export const MAX_MODEL_TURN_CONCURRENCY = 10;
export const INITIAL_MODEL_TURN_CONCURRENCY = 4;

export type ModelTurnRelease = (outcome?: 'success') => void;

/** 所有成员、阶段共享的模型名额；排队不是模型失败，也不消耗重试预算。 */
export class FairModelTurnScheduler {
  private active = 0;
  private grantSequence = 0;
  private saturatedUntil = 0;
  private cooldownTimer: NodeJS.Timeout | null = null;
  private capacity: number;
  private stableSuccesses = 0;
  private recoveryGeneration = 0;
  private readonly lastGranted = new Map<string, number>();
  private readonly waiting: Array<{
    owner: string;
    signal: AbortSignal;
    resolve: (release: ModelTurnRelease) => void;
    reject: (reason: unknown) => void;
    abort: () => void;
  }> = [];

  constructor(private readonly maximum = MAX_MODEL_TURN_CONCURRENCY, private readonly now = () => Date.now()) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_MODEL_TURN_CONCURRENCY) {
      throw new Error('MODEL_TURN_CAPACITY_INVALID');
    }
    this.capacity = Math.min(INITIAL_MODEL_TURN_CONCURRENCY, maximum);
  }

  getState(): { maximum: number; capacity: number; active: number; waiting: number; coolingDown: boolean; stableSuccesses: number } {
    return { maximum: this.maximum, capacity: this.effectiveCapacity(), active: this.active,
      waiting: this.waiting.length, coolingDown: this.now() < this.saturatedUntil, stableSuccesses: this.stableSuccesses };
  }

  acquire(owner: string, signal: AbortSignal): Promise<ModelTurnRelease> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('CODEX_TURN_INTERRUPTED'));
    return new Promise((resolve, reject) => {
      const waiter = { owner, signal, resolve, reject, abort: () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        signal.removeEventListener('abort', waiter.abort);
        this.scheduleCooldownWake();
        reject(signal.reason ?? new Error('CODEX_TURN_INTERRUPTED'));
      } };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }

  /** 先降档再冷却；冷却期间单路探测，之后凭稳定成功窗口逐步恢复，不盲目回到满速。 */
  noteSaturation(cooldownMs = 30_000): void {
    if (!Number.isFinite(cooldownMs) || cooldownMs < 0) throw new Error('MODEL_TURN_COOLDOWN_INVALID');
    this.capacity = Math.max(Math.min(2, this.maximum), 2 * Math.floor(this.capacity / 4));
    this.stableSuccesses = 0;
    this.recoveryGeneration += 1;
    this.saturatedUntil = Math.max(this.saturatedUntil, this.now() + cooldownMs);
    this.scheduleCooldownWake();
  }

  /** 连接关闭且等待者已取消后清理计时器，不在退出回调中派发新请求。 */
  resetCooldown(): void {
    this.saturatedUntil = 0;
    this.capacity = Math.min(INITIAL_MODEL_TURN_CONCURRENCY, this.maximum);
    this.stableSuccesses = 0;
    this.recoveryGeneration += 1;
    this.lastGranted.clear();
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;
  }

  private effectiveCapacity(): number {
    return this.now() < this.saturatedUntil ? 1 : this.capacity;
  }

  private noteSuccess(generation: number): void {
    // 降档前已发送的慢请求和冷却中的探测不能令恢复窗口提前达标。
    if (generation !== this.recoveryGeneration || this.now() < this.saturatedUntil) return;
    this.stableSuccesses += 1;
    if (this.capacity < this.maximum && this.stableSuccesses >= Math.max(8, this.capacity * 2)) {
      this.capacity = Math.min(this.maximum, this.capacity + 2);
      this.stableSuccesses = 0;
    }
  }

  private scheduleCooldownWake(): void {
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;
    const remaining = this.saturatedUntil - this.now();
    if (remaining <= 0 || this.waiting.length === 0) return;
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.drain();
    }, remaining);
    this.cooldownTimer.unref();
  }

  private drain(): void {
    while (this.active < this.effectiveCapacity() && this.waiting.length > 0) {
      // 最久未获名额的任务优先，同一任务内部保持 FIFO，不让长批次霸占连接。
      let index = 0;
      for (let candidate = 1; candidate < this.waiting.length; candidate += 1) {
        if ((this.lastGranted.get(this.waiting[candidate]!.owner) ?? -1)
          < (this.lastGranted.get(this.waiting[index]!.owner) ?? -1)) index = candidate;
      }
      const waiter = this.waiting.splice(index, 1)[0]!;
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) { waiter.reject(waiter.signal.reason); continue; }
      this.active += 1;
      const generation = this.recoveryGeneration;
      this.lastGranted.set(waiter.owner, this.grantSequence++);
      let released = false;
      waiter.resolve((outcome) => {
        if (released) return;
        released = true;
        if (outcome === 'success') this.noteSuccess(generation);
        else if (generation === this.recoveryGeneration) this.stableSuccesses = 0;
        this.active -= 1;
        this.drain();
      });
    }
    if (this.active === 0 && this.waiting.length === 0) this.lastGranted.clear();
    this.scheduleCooldownWake();
  }
}
