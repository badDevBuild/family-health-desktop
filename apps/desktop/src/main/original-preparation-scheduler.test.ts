import { describe, expect, it } from 'vitest';
import { MAX_PARALLEL_ORIGINAL_PREPARATIONS, OriginalPreparationScheduler } from './original-preparation-scheduler.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('本机原件准备独立限流', () => {
  it('十份待处理原件同时只准备两份，乱序完成后补位且不持有模型许可', async () => {
    const scheduler = new OriginalPreparationScheduler();
    const gates = Array.from({ length: 10 }, () => deferred());
    const starts: number[] = [];
    const work = gates.map((gate, index) => scheduler.run(() => {}, async () => {
      starts.push(index); await gate.promise; return index;
    }));
    expect(MAX_PARALLEL_ORIGINAL_PREPARATIONS).toBe(2);
    expect(starts).toEqual([0, 1]); expect(scheduler.getState()).toEqual({ active: 2, waiting: 8 });
    gates[1]!.resolve(); await work[1]; await Promise.resolve();
    expect(starts).toEqual([0, 1, 2]);
    gates.forEach((gate) => gate.resolve());
    expect(await Promise.all(work)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(scheduler.getState()).toEqual({ active: 0, waiting: 0 });
  });

  it('排队后关闭或撤权，不会读取原件；失败归还槽位且后面的合法任务继续', async () => {
    const scheduler = new OriginalPreparationScheduler(); const gate = deferred();
    const first = scheduler.run(() => {}, async () => gate.promise);
    const second = scheduler.run(() => {}, async () => gate.promise);
    let valid = true; let forbiddenRead = false;
    const cancelled = scheduler.run(() => { if (!valid) throw new Error('WORKSPACE_CLOSED'); },
      async () => { forbiddenRead = true; }).catch((error: unknown) => error);
    const healthy = scheduler.run(() => {}, async () => 'ready');
    valid = false; gate.resolve(); await Promise.all([first, second]);
    expect(await cancelled).toMatchObject({ message: 'WORKSPACE_CLOSED' });
    expect(forbiddenRead).toBe(false); expect(await healthy).toBe('ready');
    expect(scheduler.getState()).toEqual({ active: 0, waiting: 0 });
  });

  it('准备抛出存储或解码故障也释放名额', async () => {
    const scheduler = new OriginalPreparationScheduler();
    await expect(scheduler.run(() => {}, async () => { throw new Error('ENOSPC'); })).rejects.toThrow('ENOSPC');
    expect(scheduler.getState()).toEqual({ active: 0, waiting: 0 });
  });
});
