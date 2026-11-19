/** 定时器接缝：缺省挂真实定时器；测试注入假时钟。 */
export type TimerSeam = (fire: () => void, delayMs: number) => { cancel(): void };

/** 真实定时器一律 unref：停机排空不该被一个还没到点的回合截止拖住。 */
const realTimer: TimerSeam = (fire, delayMs) => {
  const timer = setTimeout(fire, delayMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
};

interface ArmedTimer {
  cancel(): void;
}

/**
 * 按房间具名的定时器。
 *
 * 过去句柄散在服务字段与多个构造点上：回调 `void` 出去无人兜底，抛错或拒绝变成未处理异常；
 * 关房时漏清一个，就会对已删除的房间推进回合。这里统一三件事：同房同名只留一个（重挂先清）；
 * 回调的同步抛错与异步拒绝都交给 `onError`；关房清本房全部、服务关闭清全部。
 */
export class RoomTimers {
  private readonly armed = new Map<string, Map<string, ArmedTimer>>();
  private readonly setTimer: TimerSeam;

  constructor(
    private readonly options: {
      /** 回调失败的唯一出口（通常是结构化日志）；它自己不得抛错。 */
      onError(roomId: string, name: string, error: unknown): void;
      setTimer?: TimerSeam;
    }
  ) {
    this.setTimer = options.setTimer ?? realTimer;
  }

  /** 同房同名只留一个：重挂先清。到点时先摘掉登记，回调里可以再挂同名定时器。 */
  arm(roomId: string, name: string, delayMs: number, fire: () => void | Promise<void>): void {
    this.clear(roomId, name);
    const timer = this.setTimer(
      () => {
        if (this.armed.get(roomId)?.get(name) !== timer) return;
        this.forget(roomId, name);
        this.run(roomId, name, fire);
      },
      Math.max(0, delayMs)
    );
    let byName = this.armed.get(roomId);
    if (!byName) {
      byName = new Map();
      this.armed.set(roomId, byName);
    }
    byName.set(name, timer);
  }

  /** 不给 name 时清该房全部。 */
  clear(roomId: string, name?: string): void {
    const byName = this.armed.get(roomId);
    if (!byName) return;
    if (name === undefined) {
      for (const timer of byName.values()) timer.cancel();
      this.armed.delete(roomId);
      return;
    }
    byName.get(name)?.cancel();
    this.forget(roomId, name);
  }

  clearAll(): void {
    for (const byName of this.armed.values()) {
      for (const timer of byName.values()) timer.cancel();
    }
    this.armed.clear();
  }

  isArmed(roomId: string, name: string): boolean {
    return this.armed.get(roomId)?.has(name) === true;
  }

  private forget(roomId: string, name: string): void {
    const byName = this.armed.get(roomId);
    if (!byName) return;
    byName.delete(name);
    if (byName.size === 0) this.armed.delete(roomId);
  }

  private run(roomId: string, name: string, fire: () => void | Promise<void>): void {
    try {
      const pending = fire();
      if (pending) pending.catch((error: unknown) => this.options.onError(roomId, name, error));
    } catch (error) {
      this.options.onError(roomId, name, error);
    }
  }
}
