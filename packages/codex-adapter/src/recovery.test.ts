import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexRpcClient, type RpcLifecycleEvent } from './index.js';

const clients: CodexRpcClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.shutdown(); vi.useRealTimers(); });
function setup() {
  const input = new PassThrough(); const output = new PassThrough();
  const client = new CodexRpcClient({ input, output, terminate() {} }, { requestTimeoutMs: 20 }); clients.push(client);
  const events: RpcLifecycleEvent[] = [];
  const options = { lateReplyMs: 60, onLifecycle: (event: RpcLifecycleEvent) => { events.push(event); } };
  const send = (frame: unknown) => output.write(`${JSON.stringify(frame)}\n`);
  return { client, input, output, events, options, send };
}
const receipt = (method: string, params: unknown): unknown | undefined => {
  const value = params as { threadId?: string; turn?: { id?: string } } | null;
  return method === 'turn/started' && value?.threadId === 'owned-thread' && value.turn?.id
    ? { turn: { id: value.turn.id } } : undefined;
};

describe('启动回执的有界关联恢复', () => {
  it('软超时后接纳同一请求晚回执，不重发资料且诊断不含正文', async () => {
    vi.useFakeTimers(); const f = setup();
    const result = f.client.requestWithRecovery('thread/start', { private: '合成不得进入诊断' }, f.options);
    const request = JSON.parse(f.input.read().toString());
    await vi.advanceTimersByTimeAsync(21);
    f.send({ id: request.id, result: { thread: { id: 'owned-thread' } } });
    await expect(result).resolves.toEqual({ thread: { id: 'owned-thread' } });
    expect(f.input.read()).toBeNull();
    expect(f.events.map(event => event.phase)).toEqual(['sent','waiting_late_reply','reply']);
    expect(JSON.stringify(f.events)).not.toContain('合成不得进入诊断');
  });
  it('本线程正式早到事件证明启动，其他线程事件和普通item不能冒充', async () => {
    vi.useFakeTimers(); const f = setup();
    const result = f.client.requestWithRecovery('turn/start', {}, { ...f.options, receiptFromNotification: receipt });
    f.input.read();
    f.send({ method: 'turn/started', params: { threadId: 'other-thread', turn: { id: 'other-turn' } } });
    f.send({ method: 'item/started', params: { threadId: 'owned-thread', turnId: 'not-a-start-receipt' } });
    await vi.advanceTimersByTimeAsync(21);
    f.send({ method: 'turn/started', params: { threadId: 'owned-thread', turn: { id: 'accepted-turn' } } });
    await expect(result).resolves.toEqual({ turn: { id: 'accepted-turn' } });
    expect(f.events.at(-1)?.phase).toBe('event_receipt');
    expect(f.input.read()).toBeNull();
  });
  it('最终未知不重发，晚回执只执行一次目标清理', async () => {
    vi.useFakeTimers(); const f = setup(); const late = vi.fn();
    const result = f.client.requestWithRecovery('turn/start', {}, { ...f.options, onLateResult: late });
    const observed = result.catch(error => error.message); const request = JSON.parse(f.input.read().toString());
    await vi.advanceTimersByTimeAsync(80);
    expect(await observed).toBe('CODEX_RPC_TIMEOUT:turn/start');
    f.send({ id: request.id, result: { turn: { id: 'late-turn' } } });
    f.send({ id: request.id, result: { turn: { id: 'late-turn' } } });
    expect(late).toHaveBeenCalledExactlyOnceWith({ turn: { id: 'late-turn' } });
    expect(f.input.read()).toBeNull();
  });
  it('取消单请求立即退出，迟到启动事件可清理，不影响并行请求', async () => {
    vi.useFakeTimers(); const f = setup(); const controller = new AbortController(); const late = vi.fn();
    const first = f.client.requestWithRecovery('turn/start', {}, { ...f.options, signal: controller.signal,
      receiptFromNotification: receipt, onLateResult: late }).catch(error => error.message);
    f.input.read();
    const second = f.client.requestWithRecovery('thread/start', {}, f.options);
    const other = JSON.parse(f.input.read().toString());
    controller.abort(new Error('TARGET_CANCELLED')); expect(await first).toBe('TARGET_CANCELLED');
    f.send({ method: 'turn/started', params: { threadId: 'owned-thread', turn: { id: 'late-turn' } } });
    f.send({ id: other.id, result: { thread: { id: 'unaffected' } } });
    await expect(second).resolves.toEqual({ thread: { id: 'unaffected' } });
    expect(late).toHaveBeenCalledTimes(1);
  });
  it('发送意图写入失败或取消发生在写入期间，不发送请求', async () => {
    const f = setup();
    await expect(f.client.requestWithRecovery('turn/start', {}, { ...f.options,
      onLifecycle: () => { throw new Error('JOURNAL_FULL'); } })).rejects.toThrow('JOURNAL_FULL');
    const controller = new AbortController();
    await expect(f.client.requestWithRecovery('turn/start', {}, { ...f.options, signal: controller.signal,
      onLifecycle: () => controller.abort(new Error('SCOPE_REVOKED')) })).rejects.toThrow('SCOPE_REVOKED');
    expect(f.input.read()).toBeNull();
  });
  it('认证错误回执直接终止，不靠等待或重发吞掉失败', async () => {
    const f = setup(); const result = f.client.requestWithRecovery('thread/start', {}, f.options);
    const request = JSON.parse(f.input.read().toString());
    f.send({ id: request.id, error: { code: 401, message: 'unauthorized' } });
    await expect(result).rejects.toThrow('CODEX_RPC_ERROR:401');
    expect(f.events.at(-1)?.phase).toBe('error_reply');
    expect(f.input.read()).toBeNull();
  });
});
