/** 转图/解码是本机重任务，不能随模型并发上限同时放大。 */
export const MAX_PARALLEL_ORIGINAL_PREPARATIONS = 2;

export class OriginalPreparationScheduler {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  getState(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting.length };
  }

  async run<T>(assertActive: () => void, operation: () => Promise<T>): Promise<T> {
    assertActive();
    if (this.active >= MAX_PARALLEL_ORIGINAL_PREPARATIONS) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      // 排队中可能取消、撤权或关闭；开始读文件、分配 Buffer 前重新检查。
      assertActive();
      return await operation();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

/** 所有工作区/成员共享；在队列闭包内部读原件，准备结束立即归还名额。 */
export const originalPreparationScheduler = new OriginalPreparationScheduler();
