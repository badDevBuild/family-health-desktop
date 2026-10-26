import { describe, expect, it } from 'vitest';
import { createReportFinalizationGate, MAX_PARALLEL_REPORT_READS, runBoundedReportTasks } from './report-read-scheduler.js';
import { CODEX_MAX_CONCURRENT_STRUCTURED_TURNS } from './codex-runtime.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('报告读取的有限并行与有序接纳', () => {
  it('读取调度上限不超过模型连接的实际容量', () => {
    expect(MAX_PARALLEL_REPORT_READS).toBe(10);
    expect(MAX_PARALLEL_REPORT_READS).toBeLessThanOrEqual(CODEX_MAX_CONCURRENT_STRUCTURED_TURNS);
  });
  it('两份真正重叠，第三份等空位，允许按实际完成顺序保存', async () => {
    const waits = [deferred(), deferred(), deferred()];
    const secondStarted = deferred(); const thirdStarted = deferred();
    const started: number[] = []; const completed: number[] = [];
    const running = runBoundedReportTasks([0, 1, 2], 2, async (item) => {
      started.push(item);
      if (item === 1) secondStarted.resolve();
      if (item === 2) thirdStarted.resolve();
      await waits[item]!.promise; completed.push(item);
    });
    await secondStarted.promise; expect(started).toEqual([0, 1]);
    waits[1]!.resolve(); await thirdStarted.promise;
    expect(completed).toEqual([1]); expect(started).toEqual([0, 1, 2]);
    waits[2]!.resolve(); waits[0]!.resolve(); await running;
    expect(new Set(completed)).toEqual(new Set([0, 1, 2]));
  });

  it('一份失败停止派发，仍等待另一份已开始的处理完成后结束尝试', async () => {
    const fail = deferred(); const complete = deferred(); const bothStarted = deferred();
    const started: number[] = []; const completed: number[] = [];
    const failure = new Error('SYNTHETIC_MODEL_BUSY'); let finished = false;
    const running = runBoundedReportTasks([0, 1, 2], 2, async (item) => {
      started.push(item); if (item === 1) bothStarted.resolve();
      if (item === 0) { await fail.promise; throw failure; }
      await complete.promise; completed.push(item);
    }).catch((error: unknown) => error).finally(() => { finished = true; });
    await bothStarted.promise; fail.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false); expect(started).toEqual([0, 1]);
    complete.resolve(); expect(await running).toBe(failure);
    expect(started).toEqual([0, 1]); expect(completed).toEqual([1]);
  });

  it('退回单路时同一时刻只处理一份', async () => {
    const first = deferred(); const firstStarted = deferred(); const started: number[] = [];
    const running = runBoundedReportTasks([0, 1], 1, async (item) => {
      started.push(item); if (item === 0) { firstStarted.resolve(); await first.promise; }
    });
    await firstStarted.promise; expect(started).toEqual([0]);
    first.resolve(); await running; expect(started).toEqual([0, 1]);
  });

  it('两份同时失败都保留，后到的存储故障可由调用方优先处理', async () => {
    const busy = new Error('CODEX_MODEL_BUSY'); const storage = new Error('ENOSPC');
    const release = deferred(); const errorsSeen: unknown[] = [];
    const running = runBoundedReportTasks([0, 1, 2], 2, async (item) => {
      if (item === 0) throw busy;
      await release.promise; throw storage;
    }, (errors) => { errorsSeen.push(...errors); return storage; }).catch((error: unknown) => error);
    await Promise.resolve(); release.resolve();
    expect(await running).toBe(storage); expect(errorsSeen).toEqual([busy, storage]);
  });

  it('未提供选择函数时也不能丢弃多份失败', async () => {
    const failures = [new Error('SYNTHETIC_FIRST'), new Error('SYNTHETIC_SECOND')];
    const result = await runBoundedReportTasks([0, 1], 2, async (item) => { throw failures[item]; })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual(failures);
  });

  it.each([0, -1, 1.5, 11, Number.NaN])('拒绝不受控的并发数 %s', async (concurrency) => {
    await expect(runBoundedReportTasks([1], concurrency, async () => {})).rejects.toThrow('REPORT_READ_CONCURRENCY_INVALID');
  });

  it('补核接纳保持独占，前一份失败后仍释放门', async () => {
    const gate = createReportFinalizationGate(); const release = deferred();
    const entered = deferred(); const order: string[] = [];
    const first = gate(async () => {
      order.push('first:start'); entered.resolve(); await release.promise;
      order.push('first:failed'); throw new Error('SYNTHETIC_VALIDATION_FAILURE');
    }).catch((error: unknown) => error);
    await entered.promise;
    const second = gate(async () => { order.push('second'); return 'published'; });
    await Promise.resolve(); expect(order).toEqual(['first:start']);
    release.resolve(); expect(await first).toMatchObject({ message: 'SYNTHETIC_VALIDATION_FAILURE' });
    expect(await second).toBe('published'); expect(order).toEqual(['first:start', 'first:failed', 'second']);
  });

  it('接纳失败时释放等待者但不再推进事实版本，避免已保存的来源证明在续跑前过期', async () => {
    const gate = createReportFinalizationGate({ stopAfterFailure: true });
    const release = deferred(); const entered = deferred(); const order: string[] = [];
    const failure = new Error('SYNTHETIC_COMMIT_FAILURE');
    const first = gate(async () => {
      order.push('proof:saved'); entered.resolve(); await release.promise; throw failure;
    }).catch((error: unknown) => error);
    await entered.promise;
    const second = gate(async () => { order.push('peer:published'); }).catch((error: unknown) => error);
    release.resolve(); expect(await first).toBe(failure); expect(await second).toBe(failure);
    expect(order).toEqual(['proof:saved']);
  });
});
