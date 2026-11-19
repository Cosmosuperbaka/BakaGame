import equal from "fast-deep-equal";

export interface SerialSaveConfig<T> {
  save: (value: T) => Promise<unknown>;
  onError?: (error: unknown) => void;
  delayMs: number;
  enabled: boolean;
}

/**
 * 防抖 + 串行的保存队列，不依赖 React，便于单测。
 *
 * 约束：同一时刻最多一个保存在途，飞行期间的新草稿只保留最新一份；
 * 与已保存值相同的草稿不提交；失败的值在再次编辑之前不重试（避免对同一个坏值死循环）；
 * 关闭（`enabled` 为假）时丢弃待提交草稿与失败记录。
 */
export class SerialSaveQueue<T> {
  private saved: T;
  private pending: { value: T } | null = null;
  private failed: { value: T } | null = null;
  private saving = false;
  private mounted = true;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private config: SerialSaveConfig<T>;

  constructor(initial: T, config: SerialSaveConfig<T>) {
    this.saved = initial;
    this.config = config;
  }

  /** 同步最新的回调与开关；每次提交后调用，让定时器里的保存总用最新配置。 */
  configure(config: SerialSaveConfig<T>): void {
    this.config = config;
  }

  /** 取消尚未触发的防抖计时。 */
  cancelTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** 关闭自动保存：待提交的草稿与失败记录一并作废。 */
  disable(): void {
    this.cancelTimer();
    this.pending = null;
    this.failed = null;
  }

  /** 草稿变化：值得保存就排一次防抖，否则撤销待提交的草稿。 */
  setValue(value: T): void {
    this.cancelTimer();
    if (!this.shouldSave(value)) {
      this.pending = null;
      return;
    }
    this.pending = { value };
    this.schedule();
  }

  /** 宿主（组件）挂载。 */
  mount(): void {
    this.mounted = true;
  }

  /** 宿主卸载：取消计时并把最新草稿立即冲刷出去。 */
  unmount(): void {
    this.mounted = false;
    this.cancelTimer();
    if (this.config.enabled && this.pending) this.process();
  }

  private shouldSave(value: T): boolean {
    return !equal(value, this.saved) && !(this.failed && equal(value, this.failed.value));
  }

  private schedule(): void {
    this.cancelTimer();
    this.timer = setTimeout(() => this.process(), Math.max(0, this.config.delayMs));
  }

  private process(): void {
    this.cancelTimer();
    // 未启用或上一个保存仍在途：保持等待，在途保存收尾时会接力。
    if (!this.config.enabled || this.saving || !this.pending) return;
    const target = this.pending.value;
    this.pending = null;
    if (!this.shouldSave(target)) return;

    this.saving = true;
    const { save, onError } = this.config;
    void Promise.resolve(save(target))
      .then(() => {
        this.saved = target;
        this.failed = null;
      })
      .catch((error) => {
        this.failed = { value: target };
        onError?.(error);
      })
      .finally(() => this.afterSave());
  }

  /** 保存收尾：若飞行期间产生了值得保存的新草稿，接力排期（已卸载则立即提交）。 */
  private afterSave(): void {
    this.saving = false;
    if (!this.config.enabled) {
      this.pending = null;
      return;
    }
    if (!this.pending) return;
    if (!this.shouldSave(this.pending.value)) {
      this.pending = null;
      return;
    }
    if (this.mounted) this.schedule();
    else this.process();
  }
}
