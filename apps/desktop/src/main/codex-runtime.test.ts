import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexRpcClient } from '@codex';
import { directOriginalReadingResultSchema, type DirectOriginalReadingResult } from '@contracts';
import { stableHash } from '@core';
import { HEALTH_MODEL_TURN_MAX_DURATION_MS, HEALTH_MODEL_TURN_TIMEOUT_MS,
  HEALTH_CONNECTION_RECOVERY_TIMEOUT_MS, HEALTH_CONNECTION_RECOVERY_RETRY_LIMIT } from './ai-runtime-policy.js';
import { CODEX_MAX_CONCURRENT_STRUCTURED_TURNS, CodexRuntimeManager } from './codex-runtime.js';
import { CodexTurnFailure, getCodexTurnFailureDetails } from './codex-turn-failure.js';
import { decodeDirectOriginalReading, directOriginalReadingWireSchema,
  encodeDirectOriginalReading } from './direct-original-wire.js';

class FakeClient extends EventEmitter {
  requests: Array<{ method: string; params: unknown }> = [];
  authenticated = false;
  accountEmail = 'masked@example.com';
  autoCompleteTurn = true;
  turnNotifications: Array<{ method: string; params: unknown }> | null = null;
  turnCompletion = {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'completed', error: null as unknown, items: [{ type: 'agentMessage', phase: 'final_answer', text: '{"ok":true}' }] }
  };
  async initialize() { return {}; }
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === 'account/read') return { account: this.authenticated ? { type: 'chatgpt', email: this.accountEmail, planType: 'plus' } : null, requiresOpenaiAuth: true } as T;
    if (method === 'account/rateLimits/read') return { rateLimits: { primary: { usedPercent: 32, resetsAt: 2_000_000_000 }, secondary: null } } as T;
    if (method === 'account/login/start') return { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://chatgpt.com/auth' } as T;
    if (method === 'account/logout') { this.authenticated = false; return {} as T; }
    if (method === 'model/list') return {
      data: [{
        id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: '测试模型', hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '快速' }, { reasoningEffort: 'medium', description: '平衡' }],
        defaultReasoningEffort: 'low', inputModalities: ['text', 'image'], isDefault: true
      }], nextCursor: null
    } as T;
    if (method === 'thread/start') return { thread: { id: 'thread-1' } } as T;
    if (method === 'turn/start') {
      queueMicrotask(() => {
        if (!this.autoCompleteTurn) return;
        if (this.turnNotifications) {
          for (const notification of this.turnNotifications) this.emit(notification.method, notification.params);
        } else {
          this.emit('turn/completed', this.turnCompletion);
        }
      });
      return { turn: { id: 'turn-1' } } as T;
    }
    return {} as T;
  }
  shutdown() {}
}

const roots: string[] = [];
function setup(replacementClient?: FakeClient, maximumConcurrentTurns: number | undefined = 2) {
  const root = mkdtempSync(join(tmpdir(), 'codex-runtime-test-'));
  roots.push(root);
  const executable = join(root, 'codex');
  writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
  const client = new FakeClient();
  let clientCount = 0;
  const manager = new CodexRuntimeManager({
    executable,
    runtimeVersion: 'test',
    codexHome: join(root, 'codex-home'),
    workingDirectory: join(root, 'runtime-work'),
    maximumConcurrentTurns,
    now: () => new Date('2026-09-18T00:00:00Z'),
    createClient: () => clientCount++ === 0 ? client : replacementClient ?? client
  });
  return { manager, client };
}

const turnInput = { prompt: '只处理纯虚构的完整长报告',
  aiPreferences: { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' as const },
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } };
const waiterEvents = ['turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta',
  'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'thread/tokenUsage/updated',
  'serverError', 'processExit', 'processError'];
async function waitingTurn(timeoutMs?: number) {
  const { manager, client } = setup(); client.authenticated = true; client.autoCompleteTurn = false;
  await manager.start();
  const baseline = new Map(waiterEvents.map((event) => [event, client.listenerCount(event)]));
  const pending = manager.runStructuredTurn<{ ok: boolean }>({ ...turnInput, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  // 提前挂拒绝分支，假时钟触发错误时不产生未处理拒绝。
  const observed = pending.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
  await vi.advanceTimersByTimeAsync(0);
  return { manager, client, pending, observed, baseline };
}
function expectWaiterCleaned(client: FakeClient, baseline: Map<string, number>) {
  for (const event of waiterEvents) expect(client.listenerCount(event), event).toBe(baseline.get(event));
  expect(vi.getTimerCount()).toBe(0);
}
const emitDelta = (client: FakeClient, delta = ' ', scope: { threadId?: string; turnId?: string } = {}) =>
  client.emit('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta, ...scope });

describe('明确断线后的有界恢复', () => {
  it('真实协议的重连文案与结构化SSE断线进入五分钟预算，HTTP回退不重新计时', async () => {
    vi.useFakeTimers(); const f = await waitingTurn();
    f.client.emit('serverError', { threadId: 'thread-1', turnId: 'turn-1', willRetry: true,
      error: { message: 'Reconnecting... 1/5', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } } });
    await vi.advanceTimersByTimeAsync(HEALTH_CONNECTION_RECOVERY_TIMEOUT_MS - 1);
    f.client.emit('serverError', { threadId: 'thread-1', turnId: 'turn-1', willRetry: true,
      error: { message: 'error decoding response body', codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: null } } } });
    await vi.advanceTimersByTimeAsync(1);
    expect(getCodexTurnFailureDetails((await f.observed).error)?.code).toBe('CODEX_CONNECTION_FAILED');
    expect(f.client.requests.filter((r) => r.method === 'turn/interrupt')).toEqual([
      { method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } }]);
    expectWaiterCleaned(f.client, f.baseline);
  });
  const retry = (client: FakeClient, turnId = 'turn-1') => client.emit('serverError', { threadId: 'thread-1', turnId,
    willRetry: true, error: { message: 'stream disconnected before completion' } });
  it('不能让SDK的长连接重试等待超过恢复窗口；只中断本轮', async () => {
    vi.useFakeTimers(); const f = await waitingTurn(); retry(f.client);
    await vi.advanceTimersByTimeAsync(HEALTH_CONNECTION_RECOVERY_TIMEOUT_MS);
    expect(getCodexTurnFailureDetails((await f.observed).error)?.code).toBe('CODEX_CONNECTION_FAILED');
    expect(f.client.requests.filter((r) => r.method === 'turn/interrupt')).toEqual([
      { method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } }]);
    expectWaiterCleaned(f.client, f.baseline);
  });
  it('重复重连不能重置预算；达到次数上限及时停止', async () => {
    vi.useFakeTimers(); const f = await waitingTurn();
    for (let n = 0; n < HEALTH_CONNECTION_RECOVERY_RETRY_LIMIT; n += 1) retry(f.client);
    expect(getCodexTurnFailureDetails((await f.observed).error)?.code).toBe('CODEX_CONNECTION_FAILED');
    expectWaiterCleaned(f.client, f.baseline);
  });
  it('实际内容恢复后继续正常长推理；其他turn的重连不干扰', async () => {
    vi.useFakeTimers(); const f = await waitingTurn(); retry(f.client); emitDelta(f.client, '{'); retry(f.client, 'other-turn');
    await vi.advanceTimersByTimeAsync(HEALTH_CONNECTION_RECOVERY_TIMEOUT_MS + 1);
    f.client.emit('turn/completed', f.client.turnCompletion);
    expect((await f.observed).error).toBeNull(); expectWaiterCleaned(f.client, f.baseline);
  });
  it('空白输出与反复started通知不是网络恢复证据', async () => {
    vi.useFakeTimers(); const f = await waitingTurn(); retry(f.client); emitDelta(f.client, ' ');
    f.client.emit('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'retry-item', type: 'reasoning' } });
    await vi.advanceTimersByTimeAsync(HEALTH_CONNECTION_RECOVERY_TIMEOUT_MS);
    expect(getCodexTurnFailureDetails((await f.observed).error)?.code).toBe('CODEX_CONNECTION_FAILED');
    expectWaiterCleaned(f.client, f.baseline);
  });
});

const accountRequests = (client: FakeClient, method = 'account/rateLimits/read') => client.requests.filter((request) => request.method === method);
async function settleAccountRead() { for (let index = 0; index < 40; index++) await Promise.resolve(); }
function mockRateRead(client: FakeClient, read: () => Promise<unknown>) {
  const original = client.request.bind(client);
  return vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
    if (method === 'account/rateLimits/read') { client.requests.push({ method, params }); return read(); }
    return original(method, params);
  });
}

// 并行场景使用真正不同的 thread/turn，不能让测试替身把两份资料复用成同一个线程。
function concurrentTurns(client: FakeClient) {
  client.autoCompleteTurn = false;
  const original = client.request.bind(client);
  let threadCount = 0;
  vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
    if (method === 'thread/start') {
      client.requests.push({ method, params });
      return { thread: { id: `thread-${++threadCount}` } };
    }
    if (method === 'turn/start') {
      client.requests.push({ method, params });
      const threadId = (params as { threadId: string }).threadId;
      return { turn: { id: threadId.replace('thread-', 'turn-') } };
    }
    return original(method, params);
  });
  return (index: number, output: unknown = { ok: true }) => client.emit('turn/completed', {
    threadId: `thread-${index}`, turn: { id: `turn-${index}`, status: 'completed', error: null,
      items: [{ type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(output) }] }
  });
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CodexRuntimeManager', () => {
  it('自动档实际先发送四份，定向取消自己的活跃与等待请求不影响其他三份', async () => {
    vi.useFakeTimers(); const { manager, client } = setup(undefined, 10); client.authenticated = true;
    const complete = concurrentTurns(client); await manager.start();
    const input = (jobId: string) => ({ ...turnInput, runScope: { jobId, attemptId: `${jobId}-1` } });
    const failed = manager.runStructuredTurn(input('cancel')).catch((error: unknown) => error);
    const peers = ['b', 'c', 'd'].map((id) => manager.runStructuredTurn(input(id)));
    const waiting = manager.runStructuredTurn(input('cancel')).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.getModelConcurrencyState()).toMatchObject({ maximum: 10, capacity: 4, active: 4, waiting: 1 });
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(4);
    await manager.interruptActiveTurn({ jobId: 'cancel' });
    expect(await failed).toMatchObject({ message: 'CODEX_TURN_INTERRUPTED' });
    expect(await waiting).toMatchObject({ message: 'CODEX_TURN_INTERRUPTED' });
    complete(4, { index: 4 }); complete(2, { index: 2 }); complete(3, { index: 3 });
    expect((await Promise.all(peers)).map((result) => result.output)).toEqual([{ index: 2 }, { index: 3 }, { index: 4 }]);
    expect(manager.getModelConcurrencyState()).toMatchObject({ active: 0, waiting: 0 });
    manager.shutdown(); expect(vi.getTimerCount()).toBe(0);
  });

  it('分别记录本地排队、连接准备与实际模型时间，保留旧总耗时语义', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { manager, client } = setup(); client.authenticated = true;
    const complete = concurrentTurns(client); await manager.start();
    const first = manager.runStructuredTurn(turnInput);
    const second = manager.runStructuredTurn(turnInput);
    const queued = manager.runStructuredTurn(turnInput);
    await vi.advanceTimersByTimeAsync(150);
    const originalRequest = client.request.bind(client);
    client.request = async <T,>(method: string, params?: unknown): Promise<T> => {
      if (method === 'thread/start') await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return originalRequest<T>(method, params);
    };
    complete(1); await first; await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(25); complete(3);
    expect((await queued).metrics).toMatchObject({ timingVersion: 2, durationMs: 225,
      totalDurationMs: 225, queueWaitMs: 150, runtimeSetupMs: 50, modelDurationMs: 25,
      modelStartedAt: new Date(200).toISOString() });
    complete(2); await second; manager.shutdown(); expect(vi.getTimerCount()).toBe(0);
  });

  it('稳定实际回包后升到十路，退出取消全部在途及等待者，迟到回包不复活请求', async () => {
    vi.useFakeTimers(); const { manager, client } = setup(undefined, 10); client.authenticated = true;
    const complete = concurrentTurns(client); await manager.start();
    for (let index = 1; index <= 36; index += 1) {
      const pending = manager.runStructuredTurn(turnInput);
      await vi.advanceTimersByTimeAsync(0); complete(index); await pending;
    }
    expect(manager.getModelConcurrencyState().capacity).toBe(10);
    const baseline = new Map(waiterEvents.map((event) => [event, client.listenerCount(event)]));
    const pending = Array.from({ length: 11 }, (_, index) => manager.runStructuredTurn({
      ...turnInput, runScope: { jobId: `member-${index}`, attemptId: `attempt-${index}` }
    }).catch((error: unknown) => error));
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.getModelConcurrencyState()).toMatchObject({ active: 10, waiting: 1 });
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(46);
    manager.shutdown();
    expect(await Promise.all(pending)).toEqual(Array.from({ length: 11 }, () => expect.objectContaining({ message: 'CODEX_RUNTIME_EXITED' })));
    complete(37); await vi.advanceTimersByTimeAsync(60_000);
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(46);
    expect(manager.getModelConcurrencyState()).toMatchObject({ active: 0, waiting: 0, capacity: 4 });
    expectWaiterCleaned(client, baseline);
  });
  it('两份资料真正同时读取，乱序完成的正文、用量和回收名额互不串线', async () => {
    vi.useFakeTimers(); const { manager, client } = setup(); client.authenticated = true;
    const complete = concurrentTurns(client); await manager.start();
    const baseline = new Map(waiterEvents.map((event) => [event, client.listenerCount(event)]));
    expect(CODEX_MAX_CONCURRENT_STRUCTURED_TURNS).toBe(10);
    const first = manager.runStructuredTurn({ ...turnInput, prompt: '虚构资料甲' });
    const second = manager.runStructuredTurn({ ...turnInput, prompt: '虚构资料乙' });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    const third = manager.runStructuredTurn({ ...turnInput, prompt: '虚构资料丙' });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    client.emit('thread/tokenUsage/updated', { threadId: 'thread-2', turnId: 'turn-2',
      tokenUsage: { total: { inputTokens: 22, outputTokens: 2, cachedInputTokens: 0 } } });
    client.emit('thread/tokenUsage/updated', { threadId: 'thread-1', turnId: 'turn-1',
      tokenUsage: { total: { inputTokens: 11, outputTokens: 1, cachedInputTokens: 0 } } });
    complete(2, { source: '乙' });
    await expect(second).resolves.toMatchObject({ threadId: 'thread-2', turnId: 'turn-2', output: { source: '乙' },
      metrics: { inputTokens: 22, outputTokens: 2 } });
    await vi.advanceTimersByTimeAsync(0);
    complete(2, { source: '过期乙' });
    complete(1, { source: '甲' }); complete(3, { source: '丙' });
    await expect(first).resolves.toMatchObject({ output: { source: '甲' }, metrics: { inputTokens: 11, outputTokens: 1 } });
    await expect(third).resolves.toMatchObject({ threadId: 'thread-3', output: { source: '丙' }, metrics: { inputTokens: null } });
    expectWaiterCleaned(client, baseline); manager.shutdown();
  });

  it('按任务取消同时覆盖自己的活跃和等待请求，不中断另一成员', async () => {
    vi.useFakeTimers(); const { manager, client } = setup(); client.authenticated = true;
    const complete = concurrentTurns(client); await manager.start();
    const first = manager.runStructuredTurn({ ...turnInput, runScope: { jobId: 'a', attemptId: 'a1' } })
      .catch((error: unknown) => error);
    const second = manager.runStructuredTurn({ ...turnInput, runScope: { jobId: 'b', attemptId: 'b1' } });
    let waitedGuardCalls = 0;
    const third = manager.runStructuredTurn({ ...turnInput, runScope: { jobId: 'a', attemptId: 'a1' },
      assertExecutionActive: () => { waitedGuardCalls += 1; } }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await manager.interruptActiveTurn({ jobId: 'a', attemptId: 'a1' });
    expect(await first).toMatchObject({ message: 'CODEX_TURN_INTERRUPTED' });
    expect(await third).toMatchObject({ message: 'CODEX_TURN_INTERRUPTED' });
    expect(waitedGuardCalls).toBe(0);
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    expect(client.requests.filter((request) => request.method === 'turn/interrupt').map((request) => request.params))
      .toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
    complete(2, { member: 'b' }); await expect(second).resolves.toMatchObject({ output: { member: 'b' } });
    manager.shutdown(); expect(vi.getTimerCount()).toBe(0);
  });

  it('等待名额期间撤权，在真正发送之前重验，不创建第三个线程', async () => {
    vi.useFakeTimers(); const { manager, client } = setup(); client.authenticated = true;
    const complete = concurrentTurns(client); await manager.start();
    const first = manager.runStructuredTurn(turnInput); const second = manager.runStructuredTurn(turnInput);
    const third = manager.runStructuredTurn({ ...turnInput,
      assertExecutionActive: () => { throw new Error('CONSENT_REVOKED'); } }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0); complete(1); await first;
    expect(await third).toMatchObject({ message: 'CONSENT_REVOKED' });
    expect(client.requests.filter((request) => request.method === 'thread/start')).toHaveLength(2);
    complete(2); await second; manager.shutdown(); expect(vi.getTimerCount()).toBe(0);
  });

  it('请求限制在释放名额前关闭新发送，另一份已成功返回的内容仍保留', async () => {
    vi.useFakeTimers(); const { manager, client } = setup(); client.authenticated = true;
    const complete = concurrentTurns(client); await manager.start();
    let allowNewRequests = true;
    const first = manager.runStructuredTurn({ ...turnInput,
      onRequestFailure: () => { allowNewRequests = false; } }).catch((error: unknown) => error);
    const second = manager.runStructuredTurn(turnInput);
    const third = manager.runStructuredTurn({ ...turnInput,
      assertRequestAllowed: () => { if (!allowNewRequests) throw new Error('CODEX_QUOTA_EXHAUSTED'); } })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    client.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed',
      error: { message: 'synthetic request failed' }, items: [] } });
    await first;
    expect(await third).toMatchObject({ message: 'CODEX_QUOTA_EXHAUSTED' });
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    complete(2, { saved: true }); await expect(second).resolves.toMatchObject({ output: { saved: true } });
    manager.shutdown(); expect(vi.getTimerCount()).toBe(0);
  });

  it('一份超时只中断自己的轮次，不借另一份的增量续命也不中断另一份', async () => {
    vi.useFakeTimers(); const { manager, client } = setup(); client.authenticated = true;
    const complete = concurrentTurns(client); await manager.start();
    const baseline = new Map(waiterEvents.map((event) => [event, client.listenerCount(event)]));
    const first = manager.runStructuredTurn({ ...turnInput, timeoutMs: 100 }).catch((error: unknown) => error);
    const second = manager.runStructuredTurn({ ...turnInput, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(80);
    emitDelta(client, '乙的真实进度', { threadId: 'thread-2', turnId: 'turn-2' });
    await vi.advanceTimersByTimeAsync(20);
    expect(await first).toMatchObject({ message: 'CODEX_TURN_TIMEOUT' });
    expect(client.requests.filter((request) => request.method === 'turn/interrupt').map((request) => request.params))
      .toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
    expect(vi.getTimerCount()).toBe(2);
    complete(1, { source: '过期甲' }); complete(2, { source: '乙' });
    await expect(second).resolves.toMatchObject({ output: { source: '乙' } });
    expectWaiterCleaned(client, baseline); manager.shutdown();
  });

  it.each(['cancel', 'shutdown', 'processExit', 'processError'] as const)('%s覆盖全部并行轮次，不遗留监听或计时器', async (action) => {
    vi.useFakeTimers(); const { manager, client } = setup(); client.authenticated = true;
    concurrentTurns(client); await manager.start();
    const baseline = new Map(waiterEvents.map((event) => [event, client.listenerCount(event)]));
    const pending = [manager.runStructuredTurn(turnInput), manager.runStructuredTurn(turnInput)]
      .map((turn) => turn.catch((error: unknown) => error));
    await vi.advanceTimersByTimeAsync(0);
    if (action === 'cancel') await manager.interruptActiveTurn();
    else if (action === 'shutdown') manager.shutdown();
    else client.emit(action);
    const expected = action === 'cancel' ? 'CODEX_TURN_INTERRUPTED' : 'CODEX_RUNTIME_EXITED';
    expect(await Promise.all(pending)).toMatchObject([{ message: expected }, { message: expected }]);
    expect(client.requests.filter((request) => request.method === 'turn/interrupt').map((request) => request.params))
      .toEqual(action === 'cancel' ? [{ threadId: 'thread-1', turnId: 'turn-1' }, { threadId: 'thread-2', turnId: 'turn-2' }] : []);
    expectWaiterCleaned(client, baseline); manager.shutdown();
  });

  it('帐号变化同时取消已开始和等待回执的请求，迟到回执只中断所属旧轮次', async () => {
    vi.useFakeTimers(); const { manager, client } = setup(); client.authenticated = true;
    const complete = concurrentTurns(client); await manager.start();
    const baseline = new Map(waiterEvents.map((event) => [event, client.listenerCount(event)]));
    const original = vi.mocked(client.request).getMockImplementation()!; let release!: (value: unknown) => void;
    vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      if (method === 'turn/start' && (params as { threadId: string }).threadId === 'thread-2') {
        client.requests.push({ method, params });
        return new Promise((resolve) => { release = resolve; });
      }
      return original(method, params);
    });
    const first = manager.runStructuredTurn(turnInput).catch((error: unknown) => error);
    const second = manager.runStructuredTurn(turnInput).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    client.accountEmail = 'another-synthetic@example.test'; client.emit('account/updated');
    await vi.advanceTimersByTimeAsync(0);
    expect(await first).toMatchObject({ message: 'JOB_AUTH_ACCOUNT_CHANGED' });
    release({ turn: { id: 'turn-2' } });
    expect(await second).toMatchObject({ message: 'JOB_AUTH_ACCOUNT_CHANGED' });
    expect(client.requests.filter((request) => request.method === 'turn/interrupt').map((request) => request.params))
      .toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }, { threadId: 'thread-2', turnId: 'turn-2' }]);
    const current = manager.runStructuredTurn(turnInput); await vi.advanceTimersByTimeAsync(0);
    complete(1, { source: '旧甲' }); complete(2, { source: '旧乙' }); complete(3, { source: '当前' });
    await expect(current).resolves.toMatchObject({ output: { source: '当前' } });
    expectWaiterCleaned(client, baseline); manager.shutdown();
  });

  it('冻结帐号与初始连接不符时不创建线程或发送资料', async () => {
    const { manager, client } = setup(); client.authenticated = true;
    const expectedAccountFingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: 'other-synthetic@example.test' });
    await expect(manager.runStructuredTurn({ ...turnInput, expectedAccountFingerprint })).rejects.toThrow('JOB_AUTH_ACCOUNT_CHANGED');
    expect(client.requests.filter((request) => ['thread/start', 'turn/start'].includes(request.method))).toEqual([]);
    manager.shutdown();
  });

  it('thread/start等待期间帐号切换后不发送turn/start', async () => {
    vi.useFakeTimers(); const { manager, client } = setup(); client.authenticated = true;
    await manager.start();
    const expectedAccountFingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: client.accountEmail });
    const originalRequest = client.request.bind(client); let release!: (value: unknown) => void;
    vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      if (method === 'thread/start') { client.requests.push({ method, params }); return new Promise((resolve) => { release = resolve; }); }
      return originalRequest(method, params);
    });
    const pending = manager.runStructuredTurn({ ...turnInput, expectedAccountFingerprint }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    client.accountEmail = 'changed-synthetic@example.test'; client.emit('account/updated');
    // 刷新仍在微任务队列时线程就返回，不能沿用旧的 connected 快照发送资料。
    release({ thread: { id: 'thread-1' } });
    expect(await pending).toMatchObject({ message: 'JOB_AUTH_ACCOUNT_CHANGED' });
    expect(client.requests.filter((request) => request.method === 'turn/start')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0); manager.shutdown();
  });

  it('完成通知前帐号已切换但刷新未结束时不接纳旧结果', async () => {
    vi.useFakeTimers(); const { manager, client } = setup(); client.authenticated = true; client.autoCompleteTurn = false;
    await manager.start();
    const baseline = new Map(waiterEvents.map((event) => [event, client.listenerCount(event)]));
    const expectedAccountFingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: client.accountEmail });
    const pending = manager.runStructuredTurn({ ...turnInput, expectedAccountFingerprint }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    client.accountEmail = 'changed-synthetic@example.test'; client.emit('account/updated');
    client.emit('turn/completed', client.turnCompletion);
    expect(await pending).toMatchObject({ message: 'JOB_AUTH_ACCOUNT_CHANGED' });
    expectWaiterCleaned(client, baseline);
    manager.shutdown();
  });

  it('冻结帐号断开时结束等待，后续未传冻结帐号的调用保持兼容', async () => {
    vi.useFakeTimers(); const { manager, client } = setup(); client.authenticated = true; client.autoCompleteTurn = false;
    await manager.start();
    const expectedAccountFingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: client.accountEmail });
    const pending = manager.runStructuredTurn({ ...turnInput, expectedAccountFingerprint }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    client.authenticated = false; client.emit('account/updated');
    expect(await pending).toMatchObject({ message: 'JOB_AUTH_ACCOUNT_CHANGED' });
    expect(vi.getTimerCount()).toBe(0);
    client.authenticated = true; client.accountEmail = 'new-synthetic@example.test'; await manager.refreshAccount();
    client.autoCompleteTurn = true;
    await expect(manager.runStructuredTurn(turnInput)).resolves.toMatchObject({ output: { ok: true } });
    manager.shutdown();
  });

  it('使用私有目录初始化且未认证时保持 disconnected', async () => {
    const { manager } = setup();
    await manager.start();
    expect(manager.getState()).toMatchObject({ status: 'disconnected', runtimeVersion: 'test' });
    manager.shutdown();
  });

  it('只返回官方浏览器登录 URL，不接触令牌', async () => {
    const { manager, client } = setup();
    await manager.start();
    await expect(manager.startChatGptLogin()).resolves.toEqual({ loginId: 'login-1', authUrl: 'https://chatgpt.com/auth' });
    expect(client.requests.find((request) => request.method === 'account/login/start')?.params).toMatchObject({ type: 'chatgpt', useHostedLoginSuccessPage: true });
    manager.shutdown();
  });

  it('退出只调用私有运行时账户并回到 disconnected', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    await manager.start();
    expect(manager.getState().status).toBe('connected');
    await expect(manager.logout()).resolves.toMatchObject({ status: 'disconnected', displayLabel: null });
    expect(client.requests.some((request) => request.method === 'account/logout')).toBe(true);
    manager.shutdown();
  });

  it('当前额度通知只触发正常fresh读取，不将sparse/null窗口覆盖完整额度', async () => {
    const { manager, client } = setup(); client.authenticated = true;
    const complete = { rateLimits: { primary: { usedPercent: 32, resetsAt: 2_000_000_000 }, secondary: { usedPercent: 65, resetsAt: 2_000_000_100 } } };
    let release!: (value: unknown) => void;
    let read = async (): Promise<unknown> => complete;
    mockRateRead(client, () => read()); await manager.start();
    expect(manager.getState().quota).toMatchObject({ status: 'available', primaryUsedPercent: 32, secondaryUsedPercent: 65 });
    const before = client.requests.length;
    read = () => new Promise((resolve) => { release = resolve; });
    client.emit('account/rateLimits/updated', { rateLimits: { primary: null, secondary: null, planType: null } });
    await settleAccountRead();
    expect(manager.getState().quota).toMatchObject({ primaryUsedPercent: 32, secondaryUsedPercent: 65 });
    release({ rateLimits: { primary: { usedPercent: 34, resetsAt: 2_000_000_000 }, secondary: { usedPercent: 66, resetsAt: 2_000_000_100 } } });
    await settleAccountRead();
    expect(manager.getState().quota).toMatchObject({ status: 'available', primaryUsedPercent: 34, secondaryUsedPercent: 66 });
    expect(client.requests.slice(before).map((request) => request.method)).toEqual(['account/read', 'account/rateLimits/read']);
    expect(accountRequests(client, 'account/read').every((request) => (request.params as { refreshToken: boolean }).refreshToken === false)).toBe(true);
    expect(client.requests.some((request) => /^(?:thread|turn)\/|account\/login|account\/logout/.test(request.method))).toBe(false);
    manager.shutdown();
  });

  it('通知使用完整fresh响应而非通知中的available猜测', async () => {
    const { manager, client } = setup(); client.authenticated = true; await manager.start();
    mockRateRead(client, async () => ({ rateLimits: { primary: { usedPercent: 100, resetsAt: 2_000_000_000 }, secondary: null } }));
    client.emit('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 0, resetsAt: null } } });
    await settleAccountRead();
    expect(manager.getState().quota).toMatchObject({ status: 'exhausted', primaryUsedPercent: 100 });
    manager.shutdown();
  });

  it('并发旧读取共享一次，100%通知必须尾随fresh，未来相同sparse信号不能永久被吞', async () => {
    const { manager, client } = setup(); client.authenticated = true; await manager.start();
    let release!: (value: unknown) => void;
    let count = 0;
    const read = vi.fn(async () => ++count === 1 ? new Promise((resolve) => { release = resolve; })
      : { rateLimits: { primary: { usedPercent: 100, resetsAt: null }, secondary: null } }); mockRateRead(client, read);
    const first = manager.refreshAccount(); const second = manager.refreshAccount();
    await settleAccountRead();
    const signal = { rateLimits: { primary: { usedPercent: 100 }, secondary: null } };
    client.emit('account/rateLimits/updated', signal); client.emit('account/rateLimits/updated', structuredClone(signal));
    await settleAccountRead(); expect(read).toHaveBeenCalledTimes(1);
    release({ rateLimits: { primary: { usedPercent: 32, resetsAt: null }, secondary: null } });
    const oldReplies = await Promise.all([first, second]);
    expect(oldReplies.every((reply) => reply.quota.status === 'unknown')).toBe(true);
    await settleAccountRead(); expect(read).toHaveBeenCalledTimes(2);
    expect(manager.getState().quota).toMatchObject({ status: 'exhausted', primaryUsedPercent: 100 });
    client.emit('account/rateLimits/updated', { rateLimits: { secondary: null, primary: { usedPercent: 100 } } });
    await settleAccountRead(); expect(read).toHaveBeenCalledTimes(3);
    expect(manager.getState().quota.primaryUsedPercent).toBe(100);
    manager.shutdown();
  });

  it('读取本身重复发相同额度通知也不会递归循环，真正新通知仍可fresh读取', async () => {
    const { manager, client } = setup(); client.authenticated = true; await manager.start();
    const signal = { rateLimits: { primary: { usedPercent: 36, resetsAt: null }, secondary: null } };
    let count = 0;
    mockRateRead(client, async () => {
      count++; client.emit('account/rateLimits/updated', structuredClone(signal));
      queueMicrotask(() => client.emit('account/rateLimits/updated', structuredClone(signal)));
      return signal;
    });
    client.emit('account/rateLimits/updated', signal); await settleAccountRead(); expect(count).toBe(1);
    // 避免合成服务在下一次读取时再发旧值，改为实际新信号。
    signal.rateLimits.primary.usedPercent = 37;
    client.emit('account/rateLimits/updated', signal); await settleAccountRead(); expect(count).toBe(2);
    expect(manager.getState().quota.primaryUsedPercent).toBe(37);
    manager.shutdown();
  });

  it('未来相同null窗口通知仍可重新fresh，不能永久保留早先available', async () => {
    const { manager, client } = setup(); client.authenticated = true; await manager.start();
    let percent = 34;
    const read = vi.fn(async () => ({ rateLimits: { primary: { usedPercent: percent, resetsAt: null }, secondary: null } }));
    mockRateRead(client, read);
    const sparse = { rateLimits: { primary: null, secondary: null } };
    client.emit('account/rateLimits/updated', sparse); await settleAccountRead();
    expect(read).toHaveBeenCalledTimes(1); expect(manager.getState().quota.primaryUsedPercent).toBe(34);
    percent = 100;
    client.emit('account/rateLimits/updated', structuredClone(sparse)); await settleAccountRead();
    expect(read).toHaveBeenCalledTimes(2); expect(manager.getState().quota).toMatchObject({ status: 'exhausted', primaryUsedPercent: 100 });
    manager.shutdown();
  });

  it('通知发起的fresh读取中出现新generation只做一次尾随，不接纳更早available快照', async () => {
    const { manager, client } = setup(); client.authenticated = true; await manager.start();
    let count = 0;
    mockRateRead(client, async () => {
      count++;
      if (count === 1) {
        client.emit('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100 }, secondary: null } });
        return { rateLimits: { primary: { usedPercent: 32, resetsAt: null }, secondary: null } };
      }
      return { rateLimits: { primary: { usedPercent: 100, resetsAt: null }, secondary: null } };
    });
    const seenStates: string[] = [];
    manager.on('stateChanged', (state: { quota: { status: string } }) => seenStates.push(state.quota.status));
    client.emit('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 34 }, secondary: null } });
    await settleAccountRead();
    expect(count).toBe(2); expect(seenStates).toEqual(['unknown', 'exhausted']);
    expect(manager.getState().quota).toMatchObject({ status: 'exhausted', primaryUsedPercent: 100 });
    manager.shutdown();
  });

  it('每次read都诱发不同通知时只读两次后unknown，后续信号仍可另起有限burst', async () => {
    const { manager, client } = setup(); client.authenticated = true; await manager.start();
    let count = 0;
    mockRateRead(client, async () => {
      count++;
      client.emit('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 40 + count }, secondary: null } });
      return { rateLimits: { primary: { usedPercent: 32, resetsAt: null }, secondary: null } };
    });
    client.emit('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 40 }, secondary: null } });
    await settleAccountRead(); expect(count).toBe(2); expect(manager.getState().quota.status).toBe('unknown');
    await settleAccountRead(); expect(count).toBe(2);
    client.emit('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 42 }, secondary: null } });
    await settleAccountRead(); expect(count).toBe(4); expect(manager.getState().quota.status).toBe('unknown');
    expect(client.requests.some((request) => /^(?:thread|turn)\//.test(request.method))).toBe(false);
    manager.shutdown();
  });

  it('初次account读取期间同步通知会尾随真正fresh，不等待自身startPromise或循环', async () => {
    const { manager, client } = setup(); client.authenticated = true;
    const read = vi.fn(async () => {
      client.emit('account/rateLimits/updated', { rateLimits: { primary: null, secondary: null } });
      return { rateLimits: { primary: { usedPercent: 33, resetsAt: null }, secondary: null } };
    });
    mockRateRead(client, read); await manager.start(); await settleAccountRead();
    expect(read).toHaveBeenCalledTimes(2); expect(manager.getState().quota.primaryUsedPercent).toBe(33);
    manager.shutdown();
  });

  it.each([null, {}, { rateLimits: null }, { rateLimits: {} }, { rateLimits: { primary: null, secondary: null } },
    { rateLimits: { primary: { usedPercent: Number.NaN, resetsAt: null } } },
    { rateLimits: { primary: { usedPercent: '34', resetsAt: null } } },
    { rateLimits: { primary: { usedPercent: -1, resetsAt: null } } }])('fresh额度无有效窗口时保持unknown，不伪造available %#', async (response) => {
    const { manager, client } = setup(); client.authenticated = true; await manager.start();
    mockRateRead(client, async () => response);
    client.emit('account/rateLimits/updated', { rateLimits: { primary: null, secondary: null } }); await settleAccountRead();
    expect(manager.getState().quota).toEqual({ status: 'unknown', primaryUsedPercent: null, secondaryUsedPercent: null, resetsAt: null });
    manager.shutdown();
  });

  it('fresh rateLimits失败仅变unknown，不伪造可用或额外模型请求，后续主动读取可恢复', async () => {
    const { manager, client } = setup(); client.authenticated = true; await manager.start();
    const fail = mockRateRead(client, async () => { throw new Error('SYNTHETIC_PRIVATE_ERROR_NOT_PUBLISHED'); });
    client.emit('account/rateLimits/updated', { rateLimits: { primary: null } }); await settleAccountRead();
    expect(manager.getState().quota.status).toBe('unknown');
    expect(JSON.stringify(manager.getState())).not.toContain('SYNTHETIC_PRIVATE');
    expect(client.requests.some((request) => /^(?:thread|turn)\//.test(request.method))).toBe(false);
    fail.mockRestore(); await expect(manager.refreshAccount()).resolves.toMatchObject({ quota: { status: 'available', primaryUsedPercent: 32 } });
    manager.shutdown();
  });

  it('account/read失败不保留旧available作为fresh额度，不泄露错误或触发登录', async () => {
    const { manager, client } = setup(); client.authenticated = true; await manager.start();
    const original = client.request.bind(client);
    vi.spyOn(client, 'request').mockImplementation(async (method, params) => {
      if (method === 'account/read') { client.requests.push({ method, params }); throw new Error('SYNTHETIC_PRIVATE_ACCOUNT_ERROR'); }
      return original(method, params);
    });
    client.emit('account/rateLimits/updated', { rateLimits: { primary: null } }); await settleAccountRead();
    expect(manager.getState()).toMatchObject({ status: 'connected', quota: { status: 'unknown' } });
    expect(JSON.stringify(manager.getState())).not.toContain('SYNTHETIC_PRIVATE');
    expect(client.requests.some((request) => /account\/login/.test(request.method))).toBe(false);
    manager.shutdown();
  });

  it('旧client和shutdown后额度事件不读取、不覆盖当前state，新连接单独接收同内容通知', async () => {
    const next = new FakeClient(); next.authenticated = true;
    const { manager, client: old } = setup(next); old.authenticated = true; await manager.start();
    const signal = { rateLimits: { primary: null } };
    old.emit('account/rateLimits/updated', signal); await settleAccountRead(); manager.shutdown(); await manager.start();
    const before = next.requests.length; const state = manager.getState();
    old.emit('account/rateLimits/updated', signal); await settleAccountRead();
    expect(next.requests).toHaveLength(before); expect(manager.getState()).toEqual(state);
    next.emit('account/rateLimits/updated', signal); await settleAccountRead();
    expect(next.requests.length).toBe(before + 2);
    manager.shutdown(); const after = next.requests.length; const shutState = manager.getState();
    next.emit('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100 } } }); await settleAccountRead();
    expect(next.requests).toHaveLength(after); expect(manager.getState()).toEqual(shutState);
  });

  it('旧client在途额度回执不能覆盖重启后账户，旧promise清理不影响新连接刷新', async () => {
    const next = new FakeClient(); next.authenticated = true;
    const { manager, client: old } = setup(next); old.authenticated = true; await manager.start();
    let release!: (value: unknown) => void;
    mockRateRead(old, () => new Promise((resolve) => { release = resolve; }));
    old.emit('account/rateLimits/updated', { rateLimits: { primary: null } }); await settleAccountRead();
    manager.shutdown(); await manager.start(); const state = manager.getState();
    release({ rateLimits: { primary: { usedPercent: 100, resetsAt: null }, secondary: null } }); await settleAccountRead();
    expect(manager.getState()).toEqual(state);
    const count = accountRequests(next).length; next.emit('account/rateLimits/updated', { rateLimits: { primary: null } }); await settleAccountRead();
    expect(accountRequests(next)).toHaveLength(count + 1); manager.shutdown();
  });

  it('额度通知不算模型活动，不延长静默期限或增加模型重试', async () => {
    vi.useFakeTimers(); const { manager, client, observed, baseline } = await waitingTurn(100);
    await vi.advanceTimersByTimeAsync(99);
    client.emit('account/rateLimits/updated', { rateLimits: { primary: null } }); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);
    expect((await observed).error).toMatchObject({ message: 'CODEX_TURN_TIMEOUT' });
    expect(client.requests.filter((request) => request.method === 'thread/start')).toHaveLength(1);
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    expectWaiterCleaned(client, baseline); manager.shutdown();
  });

  it('事实提取关闭 Web Search，并保持命令网络与本机工具不可用', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    await manager.start();
    const result = await manager.runStructuredTurn<{ ok: boolean }>({
      prompt: '只处理纯虚构资料',
      imagePaths: ['/isolated/fixture.png'],
      aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
    });
    expect(result.output).toEqual({ ok: true });
    const threadStart = client.requests.find((request) => request.method === 'thread/start');
    const turnStart = client.requests.find((request) => request.method === 'turn/start');
    expect(threadStart?.params).toMatchObject({
      model: 'gpt-5.6-sol', approvalPolicy: 'never', sandbox: 'read-only', environments: [], dynamicTools: [],
      config: { web_search: 'disabled' }
    });
    expect((threadStart?.params as { config?: Record<string, unknown> }).config).not.toHaveProperty('tools');
    expect(turnStart?.params).toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'medium',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      environments: [],
      input: [
        { type: 'text', text: '只处理纯虚构资料' },
        { type: 'localImage', path: '/isolated/fixture.png', detail: 'original' }
      ]
    });
    manager.shutdown();
  });

  it('健康模型默认连续无进展30分钟才中断未完成轮次', async () => {
    vi.useFakeTimers();
    expect(HEALTH_MODEL_TURN_TIMEOUT_MS).toBe(30 * 60_000);
    const { manager, client } = setup();
    client.authenticated = true;
    client.autoCompleteTurn = false;
    await manager.start();
    const pending = manager.runStructuredTurn({
      prompt: '只处理纯虚构的大型整篇报告',
      aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      outputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
    });
    const rejected = expect(pending).rejects.toThrow('CODEX_TURN_TIMEOUT');
    await vi.advanceTimersByTimeAsync(HEALTH_MODEL_TURN_TIMEOUT_MS - 1);
    expect(client.requests.some((request) => request.method === 'turn/interrupt')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(client.requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
    manager.shutdown();
  });

  it('实际initialize配置经RPC桥接摘要活动，超过原30分钟仍完整结束且不保存推理摘要', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), 'codex-runtime-summary-bridge-test-')); roots.push(root);
    const executable = join(root, 'codex'); writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
    const toServer = new PassThrough(); const fromServer = new PassThrough();
    const client = new CodexRpcClient({ input: toServer, output: fromServer, terminate: () => undefined });
    let optedOut: string[] = []; const requests: string[] = [];
    toServer.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        const request = JSON.parse(line) as { id?: number; method: string; params?: { capabilities?: { optOutNotificationMethods?: string[] } } };
        requests.push(request.method); if (request.id === undefined) continue;
        let result: unknown = {};
        if (request.method === 'initialize') optedOut = request.params?.capabilities?.optOutNotificationMethods ?? [];
        if (request.method === 'account/read') result = { account: { type: 'chatgpt', email: null, planType: 'synthetic' }, requiresOpenaiAuth: true };
        if (request.method === 'account/rateLimits/read') result = { rateLimits: { primary: { usedPercent: 0, resetsAt: null }, secondary: null } };
        if (request.method === 'thread/start') result = { thread: { id: 'thread-1' } };
        if (request.method === 'turn/start') result = { turn: { id: 'turn-1' } };
        fromServer.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
    const manager = new CodexRuntimeManager({ executable, runtimeVersion: 'synthetic', codexHome: join(root, 'codex-home'),
      workingDirectory: join(root, 'runtime-work'), createClient: () => client });
    await manager.start();
    expect(optedOut).toContain('item/reasoning/textDelta');
    expect(optedOut).not.toContain('item/reasoning/summaryTextDelta');
    const pending = manager.runStructuredTurn<{ ok: boolean }>(turnInput);
    const observed = pending.catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    const method = 'item/reasoning/summaryTextDelta';
    // 合成服务按正式 initialize 的 optOut 设置发事件，经真实 RPC framing 到 runtime。
    if (!optedOut.includes(method)) fromServer.write(`${JSON.stringify({ method, params: { threadId: 'thread-1', turnId: 'turn-1',
      itemId: 'reasoning-1', summaryIndex: 0, delta: '合成摘要只作为活动信号，不保存正文' } })}\n`);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(requests).not.toContain('turn/interrupt');
    fromServer.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: {
      id: 'turn-1', status: 'completed', error: null, items: [{ type: 'agentMessage', phase: 'final_answer', text: '{"ok":true}' }] } } })}\n`);
    const result = await observed; expect(result).toMatchObject({ output: { ok: true }, metrics: { durationMs: 31 * 60_000 } });
    expect(JSON.stringify(result)).not.toContain('合成摘要');
    expect(vi.getTimerCount()).toBe(0); manager.shutdown();
  });

  it.each(['processExit', 'processError'] as const)('旧client迟到%s不清除新client或中断新轮次', async (event) => {
    vi.useFakeTimers(); const next = new FakeClient(); next.authenticated = true; next.autoCompleteTurn = false;
    const { manager, client: old } = setup(next); old.authenticated = true;
    await manager.start(); manager.shutdown(); await manager.start();
    const pending = manager.runStructuredTurn<{ ok: boolean }>(turnInput); await vi.advanceTimersByTimeAsync(0);
    old.emit(event); expect(manager.getState().status).toBe('connected');
    next.emit('turn/completed', next.turnCompletion); await expect(pending).resolves.toMatchObject({ output: { ok: true } });
    expect(next.requests.some((request) => request.method === 'turn/interrupt')).toBe(false);
    expect(vi.getTimerCount()).toBe(0); manager.shutdown();
  });

  it('旧client的帐号更新和同loginId迟到登录通知不改新帐号状态或登录等待', async () => {
    vi.useFakeTimers(); const next = new FakeClient(); next.authenticated = true;
    const { manager, client: old } = setup(next); old.authenticated = true;
    await manager.start(); manager.shutdown(); await manager.start();
    await manager.startChatGptLogin(); const requestsBefore = next.requests.length;
    old.emit('account/updated');
    old.emit('account/login/completed', { loginId: 'login-1', success: false, error: '旧client合成错误' });
    await vi.advanceTimersByTimeAsync(0);
    expect(next.requests).toHaveLength(requestsBefore); expect(manager.getState().status).toBe('connecting');
    expect(manager.getState().displayLabel).not.toContain('旧client');
    next.emit('account/login/completed', { loginId: 'login-1', success: true }); await vi.advanceTimersByTimeAsync(0);
    expect(manager.getState().status).toBe('connected'); expect(vi.getTimerCount()).toBe(0); manager.shutdown();
  });

  it('旧account/read异步回执不能覆盖重启后新client已连接状态', async () => {
    vi.useFakeTimers(); const next = new FakeClient(); next.authenticated = true;
    const { manager, client: old } = setup(next); old.authenticated = true; await manager.start();
    const originalRequest = old.request.bind(old); let release!: (value: unknown) => void;
    vi.spyOn(old, 'request').mockImplementation(async (method, params) => method === 'account/read'
      ? new Promise((resolve) => { release = resolve; }) : originalRequest(method, params));
    const previous = manager.refreshAccount().catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(0);
    manager.shutdown(); await manager.start(); expect(manager.getState().status).toBe('connected');
    release({ account: null, requiresOpenaiAuth: true }); await vi.advanceTimersByTimeAsync(0);
    expect(await previous).toMatchObject({ message: 'CODEX_RUNTIME_EXITED' });
    expect(manager.getState().status).toBe('connected'); manager.shutdown();
  });

  it.each(['success', 'error'] as const)('旧login/start迟到%s不建立新登录等待或改新client状态', async (outcome) => {
    vi.useFakeTimers(); const next = new FakeClient(); next.authenticated = true;
    const { manager, client: old } = setup(next); old.authenticated = true; await manager.start();
    const originalRequest = old.request.bind(old);
    let release!: (value: unknown) => void; let reject!: (error: Error) => void;
    vi.spyOn(old, 'request').mockImplementation(async (method, params) => method === 'account/login/start'
      ? new Promise((resolve, fail) => { release = resolve; reject = fail; }) : originalRequest(method, params));
    const previous = manager.startChatGptLogin().catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(0);
    manager.shutdown(); await manager.start();
    if (outcome === 'success') release({ type: 'chatgpt', loginId: 'login-old', authUrl: 'https://example.test/synthetic-login' });
    else reject(new Error('SYNTHETIC_OLD_LOGIN_FAILURE'));
    await vi.advanceTimersByTimeAsync(0); await previous;
    expect(manager.getState().status).toBe('connected'); expect(vi.getTimerCount()).toBe(0); manager.shutdown();
  });

  it('旧cancelLogin迟到回执不能清除新client同ID登录等待', async () => {
    vi.useFakeTimers(); const next = new FakeClient(); next.authenticated = true;
    const { manager, client: old } = setup(next); old.authenticated = true; await manager.start(); await manager.startChatGptLogin();
    const originalRequest = old.request.bind(old); let release!: (value: unknown) => void;
    vi.spyOn(old, 'request').mockImplementation(async (method, params) => method === 'account/login/cancel'
      ? new Promise((resolve) => { release = resolve; }) : originalRequest(method, params));
    const previous = manager.cancelLogin('login-1').catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(0);
    manager.shutdown(); await manager.start(); await manager.startChatGptLogin(); release({}); await vi.advanceTimersByTimeAsync(0);
    expect(await previous).toMatchObject({ message: 'CODEX_RUNTIME_EXITED' }); expect(manager.getState().status).toBe('connecting');
    next.emit('account/login/completed', { loginId: 'login-1', success: true }); await vi.advanceTimersByTimeAsync(0);
    expect(manager.getState().status).toBe('connected'); expect(vi.getTimerCount()).toBe(0); manager.shutdown();
  });

  it('旧thread/start回执不能把旧prompt发送到新client，也不改新轮次等待', async () => {
    vi.useFakeTimers(); const next = new FakeClient(); next.authenticated = true; next.autoCompleteTurn = false;
    const { manager, client: old } = setup(next); old.authenticated = true; await manager.start();
    const originalRequest = old.request.bind(old); let release!: (value: unknown) => void;
    vi.spyOn(old, 'request').mockImplementation(async (method, params) => method === 'thread/start'
      ? new Promise((resolve) => { release = resolve; }) : originalRequest(method, params));
    const previous = manager.runStructuredTurn({ ...turnInput, prompt: '旧client合成内容不得发送到新client' }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0); manager.shutdown(); await manager.start();
    const current = manager.runStructuredTurn<{ ok: boolean }>({ ...turnInput, prompt: '新client合成内容' });
    await vi.advanceTimersByTimeAsync(0); release({ thread: { id: 'thread-old' } }); await vi.advanceTimersByTimeAsync(0);
    expect(await previous).toMatchObject({ message: 'CODEX_RUNTIME_EXITED' });
    const starts = next.requests.filter((request) => request.method === 'turn/start');
    expect(starts).toHaveLength(1); expect(JSON.stringify(starts[0])).not.toContain('旧client合成内容');
    next.emit('turn/completed', next.turnCompletion); await expect(current).resolves.toMatchObject({ output: { ok: true } });
    expect(manager.getState().status).toBe('connected'); expect(vi.getTimerCount()).toBe(0); manager.shutdown();
  });

  it('旧turn/start迟到回执只清旧等待并中断旧client，不清新active轮次', async () => {
    vi.useFakeTimers(); const next = new FakeClient(); next.authenticated = true; next.autoCompleteTurn = false;
    const { manager, client: old } = setup(next); old.authenticated = true; await manager.start();
    const originalRequest = old.request.bind(old); let release!: (value: unknown) => void;
    vi.spyOn(old, 'request').mockImplementation(async (method, params) => method === 'turn/start'
      ? new Promise((resolve) => { release = resolve; }) : originalRequest(method, params));
    const previous = manager.runStructuredTurn(turnInput).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(2); manager.shutdown(); expect(vi.getTimerCount()).toBe(0);
    await manager.start(); const current = manager.runStructuredTurn<{ ok: boolean }>(turnInput);
    await vi.advanceTimersByTimeAsync(0); release({ turn: { id: 'turn-old' } }); await vi.advanceTimersByTimeAsync(0);
    expect(await previous).toMatchObject({ message: 'CODEX_RUNTIME_EXITED' });
    expect(old.requests.filter((request) => request.method === 'turn/interrupt')).toHaveLength(1);
    expect(next.requests.some((request) => request.method === 'turn/interrupt')).toBe(false);
    expect(vi.getTimerCount()).toBe(2);
    next.emit('turn/completed', next.turnCompletion); await expect(current).resolves.toMatchObject({ output: { ok: true } });
    expect(manager.getState().status).toBe('connected'); expect(vi.getTimerCount()).toBe(0); manager.shutdown();
  });

  it.each(['initialize', 'thread/start', 'turn/start'].flatMap((stage) =>
    [{ stage, action: 'cancel' }, { stage, action: 'shutdown' }]))(
    '$stage回执前$action不能晚发送健康内容或复活轮次', async ({ stage, action }) => {
      vi.useFakeTimers(); const { manager, client } = setup(); client.authenticated = true;
      let release!: (value: unknown) => void;
      if (stage === 'initialize') vi.spyOn(client, 'initialize').mockImplementation(() => new Promise((resolve) => { release = () => resolve({}); }));
      else {
        await manager.start(); const originalRequest = client.request.bind(client);
        vi.spyOn(client, 'request').mockImplementation(async (method, params) => method === stage
          ? new Promise((resolve) => { release = resolve; }) : originalRequest(method, params));
      }
      const pending = manager.runStructuredTurn(turnInput).catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(0);
      if (action === 'shutdown') manager.shutdown(); else await manager.interruptActiveTurn();
      expect(vi.getTimerCount()).toBe(0);
      release(stage === 'initialize' ? {} : stage === 'thread/start' ? { thread: { id: 'thread-1' } } : { turn: { id: 'turn-1' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(await pending).toMatchObject({ message: action === 'shutdown' ? 'CODEX_RUNTIME_EXITED' : 'CODEX_TURN_INTERRUPTED' });
      if (stage !== 'turn/start') expect(client.requests.some((request) => request.method === 'turn/start')).toBe(false);
      else expect(client.requests.filter((request) => request.method === 'turn/interrupt')).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0); manager.shutdown();
    });

  it.each(['initialize', 'thread/start', 'turn/start'])('%s启动阶段已占并行名额，第三个请求不创建新线程', async (stage) => {
    vi.useFakeTimers(); const { manager, client } = setup(); client.authenticated = true;
    concurrentTurns(client);
    const releases: Array<(value: unknown) => void> = [];
    if (stage === 'initialize') vi.spyOn(client, 'initialize').mockImplementation(() => new Promise((resolve) => { releases.push(() => resolve({})); }));
    else {
      await manager.start(); const originalRequest = vi.mocked(client.request).getMockImplementation()!;
      vi.spyOn(client, 'request').mockImplementation(async (method, params) => method === stage
        ? new Promise((resolve) => { releases.push(resolve); }) : originalRequest(method, params));
    }
    const pending = [manager.runStructuredTurn(turnInput), manager.runStructuredTurn(turnInput)];
    await vi.advanceTimersByTimeAsync(0);
    const queued = manager.runStructuredTurn({ ...turnInput, runScope: { jobId: 'waiting', attemptId: 'waiting-1' } })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(releases).toHaveLength(stage === 'initialize' ? 1 : 2);
    await manager.interruptActiveTurn({ jobId: 'waiting' });
    expect(await queued).toMatchObject({ message: 'CODEX_TURN_INTERRUPTED' });
    releases.forEach((release, index) => release(stage === 'initialize' ? {} : stage === 'thread/start'
      ? { thread: { id: `thread-${index + 1}` } } : { turn: { id: `turn-${index + 1}` } }));
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 1; index <= 2; index++) client.emit('turn/completed', { threadId: `thread-${index}`,
      turn: { id: `turn-${index}`, status: 'completed', error: null,
        items: [{ type: 'agentMessage', phase: 'final_answer', text: '{"ok":true}' }] } });
    await expect(Promise.all(pending)).resolves.toMatchObject([{ output: { ok: true } }, { output: { ok: true } }]);
    expect(vi.getTimerCount()).toBe(0); manager.shutdown();
  });

  it('旧initialize迟到回执和finally不能清新启动代际或新模型操作所有者', async () => {
    vi.useFakeTimers(); const next = new FakeClient(); next.authenticated = true;
    const complete = concurrentTurns(next);
    const { manager, client: old } = setup(next); old.authenticated = true;
    let oldRelease!: (value: unknown) => void; let newRelease!: (value: unknown) => void;
    vi.spyOn(old, 'initialize').mockImplementation(() => new Promise((resolve) => { oldRelease = () => resolve({}); }));
    vi.spyOn(next, 'initialize').mockImplementation(() => new Promise((resolve) => { newRelease = () => resolve({}); }));
    const previous = manager.runStructuredTurn(turnInput).catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(0);
    manager.shutdown(); const current = manager.runStructuredTurn<{ ok: boolean }>(turnInput); await vi.advanceTimersByTimeAsync(0);
    oldRelease({}); await vi.advanceTimersByTimeAsync(0);
    expect(await previous).toMatchObject({ message: 'CODEX_RUNTIME_EXITED' });
    const second = manager.runStructuredTurn<{ ok: boolean }>(turnInput);
    await vi.advanceTimersByTimeAsync(0);
    const queued = manager.runStructuredTurn({ ...turnInput, runScope: { jobId: 'waiting', attemptId: 'waiting-2' } })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await manager.interruptActiveTurn({ jobId: 'waiting' });
    expect(await queued).toMatchObject({ message: 'CODEX_TURN_INTERRUPTED' });
    expect(next.requests.some((request) => request.method === 'thread/start')).toBe(false);
    newRelease({}); await vi.advanceTimersByTimeAsync(0);
    complete(2); complete(1);
    await expect(Promise.all([current, second])).resolves.toMatchObject([{ output: { ok: true } }, { output: { ok: true } }]);
    expect(manager.getState().status).toBe('connected'); expect(vi.getTimerCount()).toBe(0); manager.shutdown();
  });

  it('当前轮次持续增量超过原30分钟墙钟仍可完整结束，不中断活跃流', async () => {
    vi.useFakeTimers(); const { manager, client, pending, baseline } = await waitingTurn();
    client.emit('item/started', { threadId: 'thread-1', turnId: 'turn-1',
      item: { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: '' } });
    await vi.advanceTimersByTimeAsync(29 * 60_000); emitDelta(client, '{"ok":');
    await vi.advanceTimersByTimeAsync(29 * 60_000); emitDelta(client, 'true}');
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(client.requests.some((request) => request.method === 'turn/interrupt')).toBe(false);
    client.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null } });
    await expect(pending).resolves.toMatchObject({ output: { ok: true }, metrics: { durationMs: 61 * 60_000 } });
    expectWaiterCleaned(client, baseline); manager.shutdown();
  });

  it('停止增量后按最后真实进展起算30分钟，超时回执不含内容', async () => {
    vi.useFakeTimers(); const { manager, client, observed, baseline } = await waitingTurn();
    await vi.advanceTimersByTimeAsync(5 * 60_000); emitDelta(client, '合成流内容不记录');
    await vi.advanceTimersByTimeAsync(HEALTH_MODEL_TURN_TIMEOUT_MS - 1);
    expect(client.requests.some((request) => request.method === 'turn/interrupt')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await observed;
    expect(getCodexTurnFailureDetails(result.error)).toMatchObject({ code: 'CODEX_TURN_TIMEOUT', threadId: 'thread-1', turnId: 'turn-1' });
    expect(JSON.stringify(result.error)).not.toContain('合成流内容');
    expectWaiterCleaned(client, baseline); manager.shutdown();
  });

  it('不断有真实进展仍受两小时绝对上限约束，不无限等待', async () => {
    vi.useFakeTimers(); expect(HEALTH_MODEL_TURN_MAX_DURATION_MS).toBe(2 * 60 * 60_000);
    const { manager, client, observed, baseline } = await waitingTurn();
    for (let index = 0; index < 4; index += 1) { await vi.advanceTimersByTimeAsync(29 * 60_000); emitDelta(client); }
    await vi.advanceTimersByTimeAsync(4 * 60_000 - 1);
    expect(client.requests.some((request) => request.method === 'turn/interrupt')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await observed).error).toMatchObject({ message: 'CODEX_TURN_TIMEOUT' });
    expect(client.requests.filter((request) => request.method === 'turn/interrupt')).toHaveLength(1);
    expectWaiterCleaned(client, baseline); manager.shutdown();
  });

  it.each(['other_thread', 'other_turn', 'empty_delta', 'missing_item', 'numeric_lifecycle_item', 'token_usage'] as const)(
    '%s不能延长当前轮次的无进展期限', async (kind) => {
      vi.useFakeTimers(); const { manager, client, observed, baseline } = await waitingTurn();
      await vi.advanceTimersByTimeAsync(HEALTH_MODEL_TURN_TIMEOUT_MS - 1);
      if (kind === 'other_thread') emitDelta(client, '片段', { threadId: 'thread-other' });
      if (kind === 'other_turn') emitDelta(client, '片段', { turnId: 'turn-other' });
      if (kind === 'empty_delta') emitDelta(client, '');
      if (kind === 'missing_item') client.emit('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', delta: '片段' });
      if (kind === 'numeric_lifecycle_item') client.emit('item/started', {
        threadId: 'thread-1', turnId: 'turn-1', item: { type: 'reasoning', id: 1 } });
      if (kind === 'token_usage') client.emit('thread/tokenUsage/updated', { threadId: 'thread-1', turnId: 'turn-1',
        tokenUsage: { total: { inputTokens: 100, outputTokens: 100, cachedInputTokens: 0 } } });
      await vi.advanceTimersByTimeAsync(1);
      expect((await observed).error).toMatchObject({ message: 'CODEX_TURN_TIMEOUT' });
      expectWaiterCleaned(client, baseline); manager.shutdown();
    });

  it('重复相同item生命周期事件不是新进展，不能延长等待', async () => {
    vi.useFakeTimers(); const { manager, client, observed, baseline } = await waitingTurn();
    const event = { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'reasoning', id: 'reasoning-1' } };
    client.emit('item/started', event);
    await vi.advanceTimersByTimeAsync(HEALTH_MODEL_TURN_TIMEOUT_MS - 1); client.emit('item/started', event);
    await vi.advanceTimersByTimeAsync(1);
    expect((await observed).error).toMatchObject({ message: 'CODEX_TURN_TIMEOUT' });
    expectWaiterCleaned(client, baseline); manager.shutdown();
  });

  it.each(['textDelta', 'summaryTextDelta'] as const)('有效reasoning/%s只刷新进展，不保存推理正文', async (kind) => {
    vi.useFakeTimers(); const { manager, client, pending, baseline } = await waitingTurn();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    client.emit(`item/reasoning/${kind}`, { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1',
      delta: '合成推理正文不持久化', ...(kind === 'textDelta' ? { contentIndex: 0 } : { summaryIndex: 0 }) });
    await vi.advanceTimersByTimeAsync(2 * 60_000); client.emit('turn/completed', client.turnCompletion);
    const result = await pending; expect(result.output).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain('合成推理正文');
    expect(client.requests.some((request) => request.method === 'turn/interrupt')).toBe(false);
    expectWaiterCleaned(client, baseline); manager.shutdown();
  });

  it('新item完成是当前轮次真实进展，可延长到完整终态', async () => {
    vi.useFakeTimers(); const { manager, client, pending, baseline } = await waitingTurn();
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    client.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'reasoning-1', type: 'reasoning' } });
    await vi.advanceTimersByTimeAsync(2 * 60_000); client.emit('turn/completed', client.turnCompletion);
    await expect(pending).resolves.toMatchObject({ output: { ok: true } });
    expectWaiterCleaned(client, baseline); manager.shutdown();
  });

  it('用户中断后及时结束等待并清理，晚到增量不能复活任务', async () => {
    vi.useFakeTimers(); const { manager, client, observed, baseline } = await waitingTurn();
    await manager.interruptActiveTurn();
    expect((await observed).error).toMatchObject({ message: 'CODEX_TURN_INTERRUPTED' });
    expectWaiterCleaned(client, baseline);
    emitDelta(client); await vi.advanceTimersByTimeAsync(HEALTH_MODEL_TURN_MAX_DURATION_MS);
    expect(client.requests.filter((request) => request.method === 'turn/interrupt')).toHaveLength(1);
    manager.shutdown();
  });

  it.each(['processExit', 'processError', 'shutdown'] as const)('%s及时清理无进展和绝对期限，不残留后台定时器', async (kind) => {
    vi.useFakeTimers(); const { manager, client, observed, baseline } = await waitingTurn();
    if (kind === 'shutdown') manager.shutdown(); else client.emit(kind);
    expect((await observed).error).toMatchObject({ message: 'CODEX_RUNTIME_EXITED' });
    expectWaiterCleaned(client, baseline);
    await vi.advanceTimersByTimeAsync(HEALTH_MODEL_TURN_MAX_DURATION_MS);
    expect(client.requests.some((request) => request.method === 'turn/interrupt')).toBe(false); manager.shutdown();
  });

  it('不可重试的当前轮次服务错误及时结束且只保留安全回执，不自行重试', async () => {
    vi.useFakeTimers(); const { manager, client, observed, baseline } = await waitingTurn();
    client.emit('serverError', { threadId: 'thread-1', turnId: 'turn-1', willRetry: false,
      error: { message: 'Selected model is at capacity. 合成正文不应保留', codexErrorInfo: { serverOverloaded: { httpStatusCode: 503 } } } });
    const result = await observed;
    expect(getCodexTurnFailureDetails(result.error)).toMatchObject({ code: 'CODEX_MODEL_BUSY', threadId: 'thread-1', turnId: 'turn-1' });
    expect(JSON.stringify(result.error)).not.toContain('合成正文');
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    expectWaiterCleaned(client, baseline); manager.shutdown();
  });

  it('非终态error willRetry与错误turn的fatal错误都不延长当前期限', async () => {
    vi.useFakeTimers(); const { manager, client, observed, baseline } = await waitingTurn();
    await vi.advanceTimersByTimeAsync(HEALTH_MODEL_TURN_TIMEOUT_MS - 1);
    client.emit('serverError', { threadId: 'thread-1', turnId: 'turn-1', willRetry: true, error: { message: '重连中' } });
    client.emit('serverError', { threadId: 'thread-1', turnId: 'turn-other', willRetry: false, error: { message: '别轮错误' } });
    await vi.advanceTimersByTimeAsync(1);
    expect((await observed).error).toMatchObject({ message: 'CODEX_TURN_TIMEOUT' });
    expectWaiterCleaned(client, baseline); manager.shutdown();
  });

  it('其他轮次早到的完成事件不污染turn/start确认的当前轮次', async () => {
    const { manager, client } = setup(); client.authenticated = true;
    client.turnNotifications = [
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { ...client.turnCompletion.turn, id: 'turn-other', status: 'failed' } } },
      { method: 'turn/completed', params: client.turnCompletion }
    ];
    await manager.start(); await expect(manager.runStructuredTurn(turnInput)).resolves.toMatchObject({ output: { ok: true } });
    manager.shutdown();
  });

  it('早到真实进展只使用原到达时刻，不在turn/start回执时再赠完整期限', async () => {
    vi.useFakeTimers(); const { manager, client } = setup(); client.authenticated = true; client.autoCompleteTurn = false;
    await manager.start(); const originalRequest = client.request.bind(client);
    let release!: (value: { turn: { id: string } }) => void;
    vi.spyOn(client, 'request').mockImplementation(async (method, params) => method === 'turn/start'
      ? new Promise((resolve) => { release = resolve; }) : originalRequest(method, params));
    const pending = manager.runStructuredTurn({ ...turnInput, timeoutMs: 30_000 });
    const observed = pending.catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000); emitDelta(client, '{"ok":');
    await vi.advanceTimersByTimeAsync(15_000); release({ turn: { id: 'turn-1' } }); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(client.requests.some((request) => request.method === 'turn/interrupt')).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await observed).toMatchObject({ message: 'CODEX_TURN_TIMEOUT' });
    expect(vi.getTimerCount()).toBe(0); manager.shutdown();
  });

  it('超时后晚到turn/start只中断该轮，不复活等待或定时器', async () => {
    vi.useFakeTimers(); const { manager, client } = setup(); client.authenticated = true; client.autoCompleteTurn = false;
    await manager.start(); const originalRequest = client.request.bind(client);
    let release!: (value: { turn: { id: string } }) => void;
    vi.spyOn(client, 'request').mockImplementation(async (method, params) => method === 'turn/start'
      ? new Promise((resolve) => { release = resolve; }) : originalRequest(method, params));
    const pending = manager.runStructuredTurn({ ...turnInput, timeoutMs: 100 });
    const observed = pending.catch((error: unknown) => error); await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBe(0);
    release({ turn: { id: 'turn-1' } }); await vi.advanceTimersByTimeAsync(0);
    expect(await observed).toMatchObject({ message: 'CODEX_TURN_TIMEOUT' });
    expect(client.requests.filter((request) => request.method === 'turn/interrupt')).toHaveLength(1);
    emitDelta(client); await vi.advanceTimersByTimeAsync(HEALTH_MODEL_TURN_MAX_DURATION_MS);
    expect(vi.getTimerCount()).toBe(0); manager.shutdown();
  });

  it('向 Codex 发送结构化输出前把嵌套 oneOf 转为 anyOf', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    await manager.start();
    await manager.runStructuredTurn<{ ok: boolean }>({
      prompt: '只处理纯虚构资料',
      aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      outputSchema: {
        type: 'object',
        properties: { value: { oneOf: [{ type: 'string' }, { type: 'null' }] } },
        required: ['value'],
        additionalProperties: false
      }
    });
    const turnStart = client.requests.find((request) => request.method === 'turn/start');
    const sentSchema = (turnStart?.params as { outputSchema?: Record<string, unknown> }).outputSchema;
    expect(sentSchema).toMatchObject({
      properties: { value: { anyOf: [{ type: 'string' }, { type: 'null' }] } }
    });
    expect(JSON.stringify(sentSchema)).not.toContain('oneOf');
    manager.shutdown();
  });

  it('服务端严格要求可选字段时发送必填可空契约，接收后恢复省略字段', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    client.turnCompletion = {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', error: null, items: [{
        type: 'agentMessage', phase: 'final_answer', text: '{"ok":true,"note":null}'
      }] }
    };
    await manager.start();
    const result = await manager.runStructuredTurn<{ ok: boolean; note?: string }>({
      prompt: '只处理纯虚构资料',
      aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
        required: ['ok'], additionalProperties: false }
    });
    const turnStart = client.requests.find((request) => request.method === 'turn/start');
    const sentSchema = (turnStart?.params as { outputSchema?: Record<string, unknown> }).outputSchema;
    expect(sentSchema).toMatchObject({ required: ['ok', 'note'],
      properties: { note: { type: ['string', 'null'] } } });
    expect(result.output).toEqual({ ok: true });
    manager.shutdown();
  });

  it('原件短键通过真实runtime边界后保留32页和显式null、缺省、空数组及不等号', async () => {
    const pages = Array.from({ length: 32 }, (_, index) => `synthetic-page-${index + 1}`);
    const images = pages.map((page) => `/synthetic-original/${page}.png`);
    const dateRef = { sourceSpanId: 'e_date', quote: null, duplicateBasis: null };
    const findingRef = { sourceSpanId: 'e_result', quote: null };
    const explicit: DirectOriginalReadingResult = {
      schemaVersion: 1, documentId: 'synthetic-document',
      pageReadings: pages.map((sourceSpanId) => ({ sourceSpanId, status: 'read' })),
      sourceExcerpts: [
        { localKey: 'e_date', pageSourceSpanId: pages[0]!, quote: 'Synthetic exam date: 2026-02-03', role: 'date', clarity: 'clear' },
        { localKey: 'e_result', pageSourceSpanId: pages[31]!, quote: 'Synthetic boundary <2.50E＋02 U/L', role: 'finding', clarity: 'clear' }
      ],
      extraction: { schemaVersion: 1, documentId: 'synthetic-document',
        subject: { reportedName: null, confidence: 'absent', evidence: [] },
        coveredSourceSpanIds: pages,
        reportMetadata: { reportKind: null, title: null, organization: null, campus: null, department: null,
          reportNumber: null, encounterIdentifier: null, sampleIdentifiers: [], examItems: [], primaryClinicalTimeIndex: null,
          times: [{ value: '2026-02-03', precision: 'day', role: 'examined', evidence: [dateRef] }] },
        candidates: [{ localKey: 'c_result', originalName: 'Synthetic boundary', standardNameCandidate: null,
          value: { kind: 'numeric', rawText: '<2.50E＋02', decimal: '250', comparator: 'lt' },
          unitRaw: 'U/L', referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null, method: null,
          bodySite: null, clinicalDate: null, clinicalContext: null, evidence: [findingRef], issues: [] }] }
    };
    const absent = structuredClone(explicit);
    delete absent.extraction.reportMetadata!.primaryClinicalTimeIndex;
    delete absent.extraction.reportMetadata!.encounterIdentifier;
    delete absent.extraction.candidates[0]!.clinicalContext;
    for (const canonical of [explicit, absent].map((value) => directOriginalReadingResultSchema.parse(value))) {
      const { manager, client } = setup(); client.authenticated = true;
      const wire = encodeDirectOriginalReading(canonical);
      client.turnCompletion.turn.items = [{ type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(wire) }];
      await manager.start();
      try {
        const result = await manager.runStructuredTurn({ ...turnInput, imagePaths: images,
          allowWebSearch: false, outputSchema: directOriginalReadingWireSchema });
        expect(result.output).toEqual(wire);
        const restored = decodeDirectOriginalReading(result.output);
        expect(restored).toEqual(canonical);
        expect(stableHash(restored)).toBe(stableHash(canonical));
        expect(restored.extraction.reportMetadata!.sampleIdentifiers).toEqual([]);
        expect(restored.extraction.reportMetadata!.times[0]!.evidence[0]).toHaveProperty('duplicateBasis', null);
        const params = client.requests.find((request) => request.method === 'turn/start')!.params as {
          input: Array<{ type: string; path?: string }>; outputSchema: Record<string, unknown>; model: string; effort: string
        };
        expect(params.input.filter((item) => item.type === 'localImage').map((item) => item.path)).toEqual(images);
        expect(params).toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium' });
        expect(params.outputSchema).toMatchObject({ required: ['wireVersion', 'contract', 'payload'] });
      } finally { manager.shutdown(); }
    }
  });

  it('完成通知不携带条目时，从 item/completed 接收权威结构化输出', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    client.turnNotifications = [
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 1,
          item: { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: '{"ok":true}' }
        }
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', error: null, items: [], itemsView: 'notLoaded' }
        }
      }
    ];
    await manager.start();
    await expect(manager.runStructuredTurn<{ ok: boolean }>({
      prompt: '只处理纯虚构资料',
      aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
    })).resolves.toMatchObject({ output: { ok: true } });
    manager.shutdown();
  });

  it('item/completed 缺失时可从按顺序接收的消息增量恢复输出', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    client.turnNotifications = [
      {
        method: 'item/started',
        params: {
          threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1,
          item: { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: '' }
        }
      },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: '{"ok":' } },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'true}' } },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', error: null, items: [], itemsView: 'notLoaded' }
        }
      }
    ];
    await manager.start();
    await expect(manager.runStructuredTurn<{ ok: boolean }>({
      prompt: '只处理纯虚构资料',
      aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
    })).resolves.toMatchObject({ output: { ok: true } });
    manager.shutdown();
  });

  it.each(['synthetic commentary', '{"ok":false}'])('终态回执final优先于另一来源的旧commentary，不按JSON长相选择：%s', async (text) => {
    const { manager, client } = setup(); client.authenticated = true;
    client.turnNotifications = [
      { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1',
        item: { id: 'old-commentary', type: 'agentMessage', phase: 'commentary', text } } },
      { method: 'serverError', params: { threadId: 'thread-1', turnId: 'turn-1', willRetry: true,
        error: { message: 'synthetic recoverable stream error' } } },
      { method: 'turn/completed', params: client.turnCompletion }
    ];
    await manager.start();
    await expect(manager.runStructuredTurn(turnInput)).resolves.toMatchObject({ output: { ok: true } });
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    manager.shutdown();
  });

  it('正式终态final优先于先前item/completed的不同final，不混合两个item', async () => {
    const { manager, client } = setup(); client.authenticated = true;
    client.turnNotifications = [
      { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1',
        item: { id: 'old-final', type: 'agentMessage', phase: 'final_answer', text: '{"ok":false}' } } },
      { method: 'turn/completed', params: client.turnCompletion }
    ];
    await manager.start();
    await expect(manager.runStructuredTurn(turnInput)).resolves.toMatchObject({ output: { ok: true } });
    manager.shutdown();
  });

  it('retry后新的无phase正式完整回执优先于旧item带final阶段的partial流', async () => {
    const { manager, client } = setup(); client.authenticated = true;
    const scope = { threadId: 'thread-1', turnId: 'turn-1' };
    client.turnNotifications = [
      { method: 'item/started', params: { ...scope,
        item: { id: 'old-partial', type: 'agentMessage', phase: 'final_answer', text: '' } } },
      { method: 'item/agentMessage/delta', params: { ...scope, itemId: 'old-partial', delta: '{"ok":' } },
      { method: 'serverError', params: { ...scope, willRetry: true,
        error: { message: 'synthetic recoverable stream error' } } },
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null,
        items: [{ id: 'new-complete', type: 'agentMessage', text: '{"ok":true}' }] } } }
    ];
    await manager.start();
    await expect(manager.runStructuredTurn(turnInput)).resolves.toMatchObject({ output: { ok: true } });
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    manager.shutdown();
  });

  it('item/completed中的final优先于终态回执的commentary', async () => {
    const { manager, client } = setup(); client.authenticated = true;
    client.turnNotifications = [
      { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1',
        item: { id: 'actual-final', type: 'agentMessage', phase: 'final_answer', text: '{"ok":true}' } } },
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null,
        items: [{ id: 'commentary', type: 'agentMessage', phase: 'commentary', text: '合成过程消息，不是最终结果' }] } } }
    ];
    await manager.start();
    await expect(manager.runStructuredTurn(turnInput)).resolves.toMatchObject({ output: { ok: true } });
    manager.shutdown();
  });

  it('已有final阶段证据的消息流优先于其他来源的commentary', async () => {
    const { manager, client } = setup(); client.authenticated = true;
    const commentary = { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: '合成过程消息' };
    client.turnNotifications = [
      { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: commentary } },
      { method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1',
        item: { id: 'stream-final', type: 'agentMessage', phase: 'final_answer', text: '' } } },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'stream-final', delta: '{"ok":true}' } },
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null,
        items: [commentary] } } }
    ];
    await manager.start();
    await expect(manager.runStructuredTurn(turnInput)).resolves.toMatchObject({ output: { ok: true } });
    manager.shutdown();
  });

  it.each(['same_item', 'changed_item'] as const)('willRetry=true恢复%s时保留已收增量，不把不同item的partial拼接', async (mode) => {
    const { manager, client } = setup(); client.authenticated = true;
    const scope = { threadId: 'thread-1', turnId: 'turn-1' };
    client.turnNotifications = [
      { method: 'item/started', params: { ...scope, item: { id: 'old-item', type: 'agentMessage', phase: 'final_answer', text: '' } } },
      { method: 'item/agentMessage/delta', params: { ...scope, itemId: 'old-item', delta: '{"ok":' } },
      { method: 'serverError', params: { ...scope, willRetry: true, error: { message: 'synthetic recoverable stream error' } } },
      ...(mode === 'same_item'
        ? [{ method: 'item/agentMessage/delta', params: { ...scope, itemId: 'old-item', delta: 'true}' } }]
        : [{ method: 'item/started', params: { ...scope, item: { id: 'new-item', type: 'agentMessage', phase: 'final_answer', text: '' } } },
          { method: 'item/agentMessage/delta', params: { ...scope, itemId: 'new-item', delta: '{"ok":true}' } }]),
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null,
        items: [], itemsView: 'notLoaded' } } }
    ];
    await manager.start();
    await expect(manager.runStructuredTurn(turnInput)).resolves.toMatchObject({ output: { ok: true } });
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    manager.shutdown();
  });

  it.each([
    { source: 'turn', phase: undefined }, { source: 'turn', phase: null },
    { source: 'item', phase: undefined }, { source: 'item', phase: null }
  ])('旧正式完成条目无phase时仍兼容：%j', async ({ source, phase }) => {
    const { manager, client } = setup(); client.authenticated = true;
    const item = { id: 'legacy-item', type: 'agentMessage', ...(phase === undefined ? {} : { phase }), text: '{"ok":true}' };
    client.turnNotifications = [
      ...(source === 'item' ? [{ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item } }] : []),
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null,
        items: source === 'turn' ? [item] : [] } } }
    ];
    await manager.start();
    await expect(manager.runStructuredTurn(turnInput)).resolves.toMatchObject({ output: { ok: true } });
    manager.shutdown();
  });

  it.each(['commentary', 'unphased_stream'] as const)('没有可信final或旧正式完成条目时，不按JSON长相采信%s', async (mode) => {
    const { manager, client } = setup(); client.authenticated = true;
    client.turnNotifications = mode === 'commentary'
      ? [{ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1',
          item: { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: '{"ok":true}' } } }]
      : [{ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1',
          itemId: 'partial-without-phase', delta: '{"ok":true}' } }];
    client.turnNotifications.push({ method: 'turn/completed', params: { threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', error: null, items: [] } } });
    await manager.start();
    await expect(manager.runStructuredTurn(turnInput)).rejects.toThrow('CODEX_STRUCTURED_OUTPUT_MISSING');
    manager.shutdown();
  });

  it('无效最终 JSON 返回固定格式错误，不把模型正文留在错误信息里', async () => {
    const { manager, client } = setup(); client.authenticated = true;
    const text = '合成私有原文：{"ok":';
    client.turnCompletion.turn.items = [{ type: 'agentMessage', phase: 'final_answer', text }];
    await manager.start();
    const failure = await manager.runStructuredTurn(turnInput).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('CODEX_STRUCTURED_OUTPUT_INVALID');
    expect((failure as Error).message).not.toContain(text);
    // 恢复次数由任务管道持久化，运行时不自行增加发送。
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    manager.shutdown();
  });

  it('保留结构化输出服务端错误的稳定错误码', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    client.turnCompletion = {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1', status: 'failed', items: [],
        error: { error: { code: 'invalid_json_schema', message: 'Invalid schema for response_format' } }
      }
    };
    await manager.start();
    await expect(manager.runStructuredTurn({
      prompt: '只处理纯虚构资料',
      aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      outputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
    })).rejects.toThrow('CODEX_OUTPUT_SCHEMA_INVALID');
    manager.shutdown();
  });

  it('把运行时真实上下文超限作为可识别错误，不与普通模型失败混淆', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    client.turnCompletion = {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'failed', items: [],
        error: { error: { codexErrorInfo: 'ContextWindowExceeded', message: 'input too large' } } }
    };
    await manager.start();
    await expect(manager.runStructuredTurn({
      prompt: '合成超大输入', aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      outputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
    })).rejects.toThrow('CODEX_CONTEXT_WINDOW_EXCEEDED');
    manager.shutdown();
  });

  it('模型满载保留失败轮次回执和安全原因，运行时自身不额外重试或换模型', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    client.turnCompletion = {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'failed', items: [], error: { error: {
        codexErrorInfo: { serverOverloaded: { httpStatusCode: 503 } },
        message: 'Selected model is at capacity. 合成私人内容不可保存。'
      } } }
    };
    await manager.start();
    const result = await manager.runStructuredTurn({
      prompt: '只处理纯虚构资料', aiPreferences: { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' },
      outputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
    }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(CodexTurnFailure);
    expect(getCodexTurnFailureDetails(result)).toMatchObject({
      code: 'CODEX_MODEL_BUSY', modelBusy: true, threadId: 'thread-1', turnId: 'turn-1', httpStatus: 503
    });
    expect(JSON.stringify(result)).not.toContain('合成私人内容');
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    expect(client.requests.find((request) => request.method === 'turn/start')?.params)
      .toMatchObject({ model: 'gpt-6.1-sol', effort: 'medium' });
    manager.shutdown();
  });

  it('派生分析只开启内置实时 Web Search，命令网络仍保持关闭', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    await manager.start();
    await manager.runStructuredTurn<{ ok: boolean }>({
      prompt: '只处理纯虚构、去标识化资料',
      aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      allowWebSearch: true,
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
    });
    const threadStart = client.requests.find((request) => request.method === 'thread/start');
    const turnStart = client.requests.find((request) => request.method === 'turn/start');
    expect(threadStart?.params).toMatchObject({
      config: { web_search: 'live' },
      developerInstructions: expect.stringContaining('去标识化')
    });
    expect((threadStart?.params as { config?: Record<string, unknown> }).config).not.toHaveProperty('tools');
    expect(turnStart?.params).toMatchObject({ sandboxPolicy: { type: 'readOnly', networkAccess: false } });
    manager.shutdown();
  });

  it('只记录去标识化的 Web Search 动作计数，完成事件重复时不重复计数', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    const searchItem = { id: 'web-1', type: 'webSearch', action: { type: 'search', query: '虚构敏感查询词' } };
    const openItem = { id: 'web-2', type: 'webSearch', action: { type: 'openPage', url: 'https://example.test/private' } };
    client.turnNotifications = [
      { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: searchItem } },
      { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: openItem } },
      { method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1',
        tokenUsage: { total: { inputTokens: 120, outputTokens: 35, cachedInputTokens: 40 },
          last: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 10 } } } },
      { method: 'turn/completed', params: { threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', error: null,
          items: [searchItem, openItem, { type: 'agentMessage', phase: 'final_answer', text: '{"ok":true}' }] } } }
    ];
    await manager.start();
    const result = await manager.runStructuredTurn<{ ok: boolean }>({
      prompt: '仅使用虚构资料', aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      allowWebSearch: true,
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
    });
    expect(result.metrics).toMatchObject({ webSearches: 1, webPageOpens: 1, webPageFinds: 0,
      webSearchOtherActions: 0, inputTokens: 120, outputTokens: 35, cachedInputTokens: 40 });
    expect(JSON.stringify(result.metrics)).not.toContain('虚构敏感查询词');
    expect(JSON.stringify(result.metrics)).not.toContain('example.test/private');
    manager.shutdown();
  });

  it('从当前 Codex 账户读取支持图像的模型与推理强度', async () => {
    const { manager } = setup();
    await expect(manager.listModels()).resolves.toEqual([{
      id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: '测试模型',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: '快速' },
        { reasoningEffort: 'medium', description: '平衡' }
      ],
      defaultReasoningEffort: 'low', isDefault: true
    }]);
    manager.shutdown();
  });

  it('运行时文件缺失时明确报错', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-runtime-missing-'));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const manager = new CodexRuntimeManager({ executable: join(root, 'missing'), runtimeVersion: null, codexHome: join(root, 'home'), workingDirectory: join(root, 'work') });
    await expect(manager.start()).rejects.toThrow('CODEX_RUNTIME_UNAVAILABLE');
    expect(manager.getState()).toMatchObject({ status: 'error', displayLabel: 'Codex 运行时未安装' });
  });
});
