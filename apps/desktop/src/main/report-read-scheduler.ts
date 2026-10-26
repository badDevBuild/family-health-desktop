/** 只并行模型读取；同成员的补核和接纳通过独立串行门执行。 */
export const MAX_PARALLEL_REPORT_READS = 10;

/** 任一任务失败即停止领取新资料；已开始的任务全部落定后才交回失败，避免迟到回执。 */
export async function runBoundedReportTasks<T>(
  items: readonly T[], concurrency: number, process: (item: T) => Promise<void>,
  selectFailure: (errors: readonly unknown[]) => unknown = (errors) => errors.length === 1
    ? errors[0] : new AggregateError(errors, 'REPORT_READ_TASKS_FAILED')
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_PARALLEL_REPORT_READS) {
    throw new Error('REPORT_READ_CONCURRENCY_INVALID');
  }
  let cursor = 0;
  let failed = false;
  const errors: unknown[] = [];
  const worker = async () => {
    while (!failed && cursor < items.length) {
      const item = items[cursor++]!;
      try { await process(item); }
      catch (error) {
        failed = true; errors.push(error);
      }
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  for (const result of settled) if (result.status === 'rejected') {
    failed = true; errors.push(result.reason);
  }
  // 所有已开始任务的失败都参与选择，不能让先到的模型繁忙掩盖随后发生的存储故障。
  if (failed) throw selectFailure(errors);
}

/** 等待模型时不持有数据库事务；失败后释放等待者，可选择仅保留后续报告的初读断点。 */
export function createReportFinalizationGate(options: { stopAfterFailure?: boolean } = {}): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve();
  let failed = false;
  let failure: unknown;
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      // P03 已保存证明但发布失败后，不能由下一份推进事实版本令断点证明失效。
      if (failed) throw failure;
      return await operation();
    } catch (error) {
      if (options.stopAfterFailure && !failed) { failed = true; failure = error; }
      throw error;
    }
    finally { release(); }
  };
}
