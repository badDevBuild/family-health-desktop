import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexRpcClient } from '@codex';
import { stableHash } from '@core';
import type { RuntimeTurnRecovery, RuntimeRecoveryDiagnostic } from '@contracts';
import { CodexRuntimeManager } from './codex-runtime.js';
import { HEALTH_STARTUP_RECEIPT_GRACE_MS, HEALTH_CONNECTION_RECOVERY_RETRY_LIMIT } from './ai-runtime-policy.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const operation of cleanup.splice(0)) operation(); vi.useRealTimers(); });
const input = { prompt: '仅供合成恢复测试', aiPreferences: { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' as const },
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'health-startup-recovery-'));
  const executable = join(dir,'fake-codex'); writeFileSync(executable,'synthetic');
  const toServer = new PassThrough(); const fromServer = new PassThrough();
  const client = new CodexRpcClient({ input: toServer, output: fromServer, terminate() {} }, { requestTimeoutMs: 10 });
  const requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  let state: RuntimeTurnRecovery | null = null; const diagnostics: RuntimeRecoveryDiagnostic[] = [];
  const reply = (id: number, result: unknown) => fromServer.write(`${JSON.stringify({ id, result })}\n`);
  const notify = (method: string, params: unknown) => fromServer.write(`${JSON.stringify({ method, params })}\n`);
  const pendingStarts: number[] = []; const pendingTurns: number[] = [];
  const finalTurn = { id: 'owned-turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: '{"ok":true}' }], error: null };
  const controls = { delayThread: false, delayTurn: false, earlyTurn: false, autoComplete: true,
    readTurns: [] as Array<typeof finalTurn>, accountEmail: 'synthetic@example.com' };
  toServer.on('data', chunk => {
    for (const line of String(chunk).trim().split('\n')) {
      const request = JSON.parse(line); if (!request.id) continue;
      requests.push(request);
      if (request.method === 'account/read') reply(request.id, { account: { type: 'chatgpt', email: controls.accountEmail, planType: 'plus' }, requiresOpenaiAuth: true });
      else if (request.method === 'thread/start') {
        if (controls.delayThread) pendingStarts.push(request.id); else reply(request.id,{ thread: { id: 'owned-thread' } });
      } else if (request.method === 'turn/start') {
        pendingTurns.push(request.id);
        if (controls.earlyTurn) notify('turn/started',{ threadId: 'owned-thread', turn: { id: 'owned-turn', status: 'inProgress' } });
        if (!controls.delayTurn) reply(request.id,{ turn: { id: 'owned-turn' } });
        if (controls.autoComplete) queueMicrotask(() => notify('turn/completed',{ threadId: 'owned-thread', turn: finalTurn }));
      } else if (request.method === 'thread/read') reply(request.id,{ thread: { id: 'owned-thread', turns: controls.readTurns } });
      else reply(request.id,{});
    }
  });
  const manager = new CodexRuntimeManager({ executable, runtimeVersion: 'synthetic', codexHome: join(dir,'runtime'),
    workingDirectory: dir, startupRequestTimeoutMs: 10, createClient: () => client });
  const recovery = { read: () => state, save: (value: RuntimeTurnRecovery) => { state = structuredClone(value); },
    diagnostic: (value: RuntimeRecoveryDiagnostic) => { diagnostics.push(value); },
    lateReceipt: (threadId: string, turnId: string) => {
      if (state?.phase === 'turn_starting' && state.threadId === threadId) state = { ...state, phase: 'turn_running', turnId };
    } };
  const run = () => manager.runStructuredTurn({ ...input, recovery,
    expectedAccountFingerprint: stableHash({ provider: 'codex-chatgpt', displayLabel: controls.accountEmail }) });
  cleanup.push(() => { manager.shutdown(); client.shutdown(); rmSync(dir,{ recursive: true, force: true }); });
  return { manager, client, controls, requests, pendingStarts, pendingTurns, reply, notify, finalTurn, recovery, run,
    diagnostics, get state() { return state; } };
}

describe('模型启动未知状态的安全续接', () => {
  it('thread/start晚回执沿同一请求继续，只有一次资料发送', async () => {
    vi.useFakeTimers(); const f = setup(); f.controls.delayThread = true;
    const result = f.run(); await vi.advanceTimersByTimeAsync(11);
    expect(f.state?.phase).toBe('thread_starting');
    f.reply(f.pendingStarts[0]!, { thread: { id: 'owned-thread' } });
    await expect(result).resolves.toMatchObject({ output: { ok: true } });
    expect(f.requests.filter(request => request.method === 'thread/start')).toHaveLength(1);
    expect(f.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
    expect(f.state?.phase).toBe('turn_terminal');
    expect(f.diagnostics.some(event => event.kind === 'startup_waiting_late_reply')).toBe(true);
  });
  it('正式早到turn事件替代缺失启动回执，完整终态照常接纳', async () => {
    const f = setup(); f.controls.delayTurn = true; f.controls.earlyTurn = true;
    await expect(f.run()).resolves.toMatchObject({ output: { ok: true } });
    expect(f.diagnostics.some(event => event.kind === 'startup_event_receipt')).toBe(true);
    expect(f.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
    expect(f.requests.filter(request => request.method === 'turn/interrupt')).toHaveLength(0);
  });
  it('已接受但启动回执未知时，只读取原轮次完整结果，不重新发送', async () => {
    vi.useFakeTimers(); const f = setup(); f.controls.delayTurn = true; f.controls.autoComplete = false;
    const first = f.run().catch(error => error.message);
    await vi.advanceTimersByTimeAsync(10 + HEALTH_STARTUP_RECEIPT_GRACE_MS);
    expect(await first).toBe('CODEX_RPC_TIMEOUT:turn/start');
    expect(f.state?.phase).toBe('turn_starting');
    f.controls.readTurns = [f.finalTurn];
    await expect(f.run()).resolves.toMatchObject({ output: { ok: true } });
    expect(f.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
    expect(f.requests.filter(request => request.method === 'thread/start')).toHaveLength(1);
    expect(f.requests.filter(request => request.method === 'thread/read')).toHaveLength(1);
    expect(f.state?.terminalStatus).toBe('completed');
  });
  it('回执仍不可核实，不把空历史或失效ephemeral当作可以盲重发', async () => {
    vi.useFakeTimers(); const f = setup(); f.controls.delayTurn = true; f.controls.autoComplete = false;
    const first = f.run().catch(error => error.message);
    await vi.advanceTimersByTimeAsync(10 + HEALTH_STARTUP_RECEIPT_GRACE_MS); await first;
    await expect(f.run()).rejects.toThrow('CODEX_START_STATE_UNKNOWN');
    expect(f.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
    expect(f.state?.turnStarts).toBe(1);
  });
  it('隔天恢复已完成回包不因原绝对等待期限失效，也不重新发送', async () => {
    vi.useFakeTimers(); const f = setup(); f.controls.delayTurn = true; f.controls.autoComplete = false;
    const first = f.run().catch(error => error.message);
    await vi.advanceTimersByTimeAsync(10 + HEALTH_STARTUP_RECEIPT_GRACE_MS); await first;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    f.controls.readTurns = [f.finalTurn];
    await expect(f.run()).resolves.toMatchObject({ output: { ok: true } });
    expect(f.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
    expect(f.requests.filter(request => request.method === 'turn/interrupt')).toHaveLength(0);
  });
  it('硬超时后的有效启动回执保留为恢复线索，不自动中断未取消的工作', async () => {
    vi.useFakeTimers(); const f = setup(); f.controls.delayTurn = true; f.controls.autoComplete = false;
    const first = f.run().catch(error => error.message);
    await vi.advanceTimersByTimeAsync(10 + HEALTH_STARTUP_RECEIPT_GRACE_MS); await first;
    f.reply(f.pendingTurns[0]!, { turn: { id: 'owned-turn' } });
    expect(f.state).toMatchObject({ phase: 'turn_running', turnId: 'owned-turn' });
    expect(f.requests.filter(request => request.method === 'turn/interrupt')).toHaveLength(0);
    f.controls.readTurns = [f.finalTurn];
    await expect(f.run()).resolves.toMatchObject({ output: { ok: true } });
    expect(f.requests.filter(request => request.method === 'turn/start')).toHaveLength(1);
  });
  it('只有空线程启动失败可有限重试，预算跨调用不清零', async () => {
    vi.useFakeTimers(); const f = setup(); f.controls.delayThread = true;
    for (let index = 0; index < 3; index += 1) {
      const result = f.run().catch(error => error.message);
      await vi.advanceTimersByTimeAsync(10 + HEALTH_STARTUP_RECEIPT_GRACE_MS);
      expect(await result).toBe('CODEX_RPC_TIMEOUT:thread/start');
    }
    await expect(f.run()).rejects.toThrow('CODEX_START_RECOVERY_EXHAUSTED');
    expect(f.requests.filter(request => request.method === 'thread/start')).toHaveLength(3);
    expect(f.requests.filter(request => request.method === 'turn/start')).toHaveLength(0);
  });
  it('断线后内容恢复只重置连续时间，不清掉整轮错误预算和无正文回执', async () => {
    vi.useFakeTimers(); const f = setup(); f.controls.autoComplete = false;
    const result = f.run().catch(error => error.message); await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < HEALTH_CONNECTION_RECOVERY_RETRY_LIMIT; index += 1) {
      f.notify('error',{ threadId: 'owned-thread', turnId: 'owned-turn', willRetry: true,
        error: { codexErrorInfo: 'responseStreamDisconnected', message: '合成私密日志不应落库' } });
      if (index < HEALTH_CONNECTION_RECOVERY_RETRY_LIMIT - 1) f.notify('item/agentMessage/delta', {
        threadId: 'owned-thread', turnId: 'owned-turn', itemId: 'message', delta: '合成敏感正文' });
    }
    expect(await result).toBe('CODEX_CONNECTION_FAILED');
    expect(f.state?.connectionErrorCount).toBe(8);
    expect(JSON.stringify([f.state,f.diagnostics])).not.toMatch(/合成敏感正文|合成私密日志/);
  });
});
