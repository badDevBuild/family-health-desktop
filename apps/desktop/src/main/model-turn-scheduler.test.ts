import { afterEach, describe, expect, it, vi } from 'vitest';
import { FairModelTurnScheduler } from './model-turn-scheduler.js';
afterEach(() => vi.useRealTimers());

describe('全阶段模型名额的公平队列', () => {
  it('总共两个名额，后来成员优先于长批次的下一轮，并保持任务内 FIFO', async () => {
    const scheduler = new FairModelTurnScheduler(2); const signal = new AbortController().signal;
    const first = await scheduler.acquire('member-a', signal);
    const second = await scheduler.acquire('member-a', signal);
    const order: string[] = [];
    const nextA = scheduler.acquire('member-a', signal).then((release) => { order.push('a'); return release; });
    const nextB = scheduler.acquire('member-b', signal).then((release) => { order.push('b'); return release; });
    await Promise.resolve(); expect(order).toEqual([]);
    first(); const releaseB = await nextB; expect(order).toEqual(['b']);
    second(); const releaseA = await nextA; expect(order).toEqual(['b', 'a']);
    releaseA(); releaseB(); first();
  });

  it('排队时取消不占名额、不发送，取消其他任务不受影响', async () => {
    const scheduler = new FairModelTurnScheduler(1); const controller = new AbortController();
    const release = await scheduler.acquire('a', new AbortController().signal);
    const cancelled = scheduler.acquire('b', controller.signal).catch((error: unknown) => error);
    const next = scheduler.acquire('c', new AbortController().signal);
    controller.abort(new Error('JOB_CANCELLED'));
    expect(await cancelled).toMatchObject({ message: 'JOB_CANCELLED' });
    release(); (await next)();
  });

  it('繁忙临时降为单路，期限后恢复双路，释放重复调用无副作用', async () => {
    let now = 0; const scheduler = new FairModelTurnScheduler(2, () => now);
    scheduler.noteSaturation(100);
    const first = await scheduler.acquire('a', new AbortController().signal);
    let started = false;
    const second = scheduler.acquire('b', new AbortController().signal).then((release) => { started = true; return release; });
    await Promise.resolve(); expect(started).toBe(false);
    now = 100;
    const third = scheduler.acquire('c', new AbortController().signal);
    const releaseSecond = await second; expect(started).toBe(true);
    first(); first(); const releaseThird = await third; releaseSecond(); releaseThird();
  });

  it('另一条长调用不结束、没有新请求时，冷却到期也自动唤醒等待者', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const scheduler = new FairModelTurnScheduler(2); const signal = new AbortController().signal;
    const busy = await scheduler.acquire('a', signal); const long = await scheduler.acquire('b', signal);
    let started = false;
    const next = scheduler.acquire('c', signal).then((release) => { started = true; return release; });
    scheduler.noteSaturation(100); busy();
    await vi.advanceTimersByTimeAsync(99); expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(started).toBe(true);
    (await next)(); long(); expect(vi.getTimerCount()).toBe(0);
  });

  it('关闭连接前取消等待者并清理冷却，不遗留计时器或复活请求', async () => {
    vi.useFakeTimers(); const scheduler = new FairModelTurnScheduler(2); const signal = new AbortController().signal;
    const busy = await scheduler.acquire('a', signal); const long = await scheduler.acquire('b', signal);
    const waiting = new AbortController(); let started = false;
    const next = scheduler.acquire('c', waiting.signal).then((release) => { started = true; release(); }, (error: unknown) => error);
    scheduler.noteSaturation(); busy(); expect(vi.getTimerCount()).toBe(1);
    waiting.abort(new Error('CODEX_RUNTIME_EXITED')); scheduler.resetCooldown();
    expect(await next).toMatchObject({ message: 'CODEX_RUNTIME_EXITED' });
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(60_000); expect(started).toBe(false); long();
  });

  it.each([0, -1, 11, 1.5])('拒绝扩张到未经验证的并发数 %s', (maximum) => {
    expect(() => new FairModelTurnScheduler(maximum)).toThrow('MODEL_TURN_CAPACITY_INVALID');
  });

  it('默认 4 路，仅稳定成功窗口达到后逐步升到 6、8、10，不因排队长度冒进', async () => {
    const scheduler = new FairModelTurnScheduler(); const signal = new AbortController().signal;
    const success = async (count: number) => {
      for (let index = 0; index < count; index += 1) (await scheduler.acquire('synthetic', signal))('success');
    };
    expect(scheduler.getState()).toMatchObject({ maximum: 10, capacity: 4, active: 0 });
    await success(7); expect(scheduler.getState().capacity).toBe(4);
    await success(1); expect(scheduler.getState().capacity).toBe(6);
    await success(12); expect(scheduler.getState().capacity).toBe(8);
    await success(16); expect(scheduler.getState().capacity).toBe(10);
    const permits = await Promise.all(Array.from({ length: 10 }, (_, index) => scheduler.acquire(`member-${index}`, signal)));
    let extraStarted = false;
    const extra = scheduler.acquire('extra', signal).then((release) => { extraStarted = true; return release; });
    await Promise.resolve(); expect(extraStarted).toBe(false);
    permits[7]!(); (await extra)(); permits.forEach((release) => release());
    expect(scheduler.getState()).toMatchObject({ capacity: 10, active: 0, waiting: 0 });
  });

  it('繁忙降档后旧在途成功不能促升；冷却后稳定窗口自动恢复，不永久单路', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const scheduler = new FairModelTurnScheduler(); const signal = new AbortController().signal;
    const success = async (count: number) => {
      for (let index = 0; index < count; index += 1) (await scheduler.acquire('member', signal))('success');
    };
    await success(8); expect(scheduler.getState().capacity).toBe(6);
    const old = await Promise.all(Array.from({ length: 6 }, () => scheduler.acquire('old', signal)));
    scheduler.noteSaturation(100);
    old.forEach((release) => release('success'));
    expect(scheduler.getState()).toMatchObject({ capacity: 1, stableSuccesses: 0, active: 0 });
    await success(8); expect(scheduler.getState().stableSuccesses).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(scheduler.getState().capacity).toBe(2);
    await success(8); expect(scheduler.getState().capacity).toBe(4);
    await success(8); expect(scheduler.getState().capacity).toBe(6);
    await success(12); expect(scheduler.getState().capacity).toBe(8);
    await success(16); expect(scheduler.getState().capacity).toBe(10);
  });

  it('失败和取消释放不算稳定成功，关闭重置后迟到成功不能污染新的窗口', async () => {
    const scheduler = new FairModelTurnScheduler(); const signal = new AbortController().signal;
    for (let index = 0; index < 12; index += 1) (await scheduler.acquire('a', signal))();
    expect(scheduler.getState()).toMatchObject({ capacity: 4, stableSuccesses: 0 });
    for (let index = 0; index < 7; index += 1) (await scheduler.acquire('a', signal))('success');
    (await scheduler.acquire('failed', signal))();
    (await scheduler.acquire('next', signal))('success');
    expect(scheduler.getState()).toMatchObject({ capacity: 4, stableSuccesses: 1 });
    const late = await scheduler.acquire('old', signal);
    scheduler.resetCooldown(); late('success');
    expect(scheduler.getState()).toMatchObject({ capacity: 4, stableSuccesses: 0, active: 0 });
  });

  it.each([4, 6, 10])('指定最高 %s 路时仍从不超过 4 路起步', async (maximum) => {
    const scheduler = new FairModelTurnScheduler(maximum);
    expect(scheduler.getState().capacity).toBe(Math.min(maximum, 4));
    for (let index = 0; index < 64; index += 1) {
      (await scheduler.acquire('a', new AbortController().signal))('success');
    }
    expect(scheduler.getState().capacity).toBe(maximum);
  });
});
