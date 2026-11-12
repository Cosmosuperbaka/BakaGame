import { describe, expect, test } from "bun:test";

import { RoomTimers, type TimerSeam } from "../../src/application/room/RoomTimers";

/** 假时钟：`advance` 按到点先后触发；`honorCancel` 为假时模拟「取消没拦住、回调照样来了」。 */
const createClock = (honorCancel = true) => {
  let now = 0;
  let pending: { at: number; fire: () => void; cancelled: boolean }[] = [];
  const seam: TimerSeam = (fire, delayMs) => {
    const entry = { at: now + delayMs, fire, cancelled: false };
    pending.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  };
  const advance = (ms: number) => {
    now += ms;
    const due = pending.filter((entry) => entry.at <= now).sort((a, b) => a.at - b.at);
    pending = pending.filter((entry) => entry.at > now);
    for (const entry of due) if (!entry.cancelled || !honorCancel) entry.fire();
  };
  return { seam, advance, live: () => pending.filter((entry) => !entry.cancelled).length };
};

const createTimers = (clock = createClock()) => {
  const errors: [string, string, unknown][] = [];
  const timers = new RoomTimers({
    onError: (roomId, name, error) => errors.push([roomId, name, error]),
    setTimer: clock.seam,
  });
  return { timers, errors, clock };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("按房具名定时器", () => {
  test("到点触发一次，触发前已摘掉登记", () => {
    const { timers, clock } = createTimers();
    const fired: boolean[] = [];
    timers.arm("r1", "deadline", 100, () => {
      fired.push(timers.isArmed("r1", "deadline"));
    });
    expect(timers.isArmed("r1", "deadline")).toBe(true);
    clock.advance(99);
    expect(fired).toEqual([]);
    clock.advance(1);
    expect(fired).toEqual([false]);
    expect(timers.isArmed("r1", "deadline")).toBe(false);
  });

  test("同房同名重挂先清：只有最后一次挂的回调会触发", () => {
    const { timers, clock } = createTimers();
    const fired: string[] = [];
    timers.arm("r1", "deadline", 100, () => fired.push("first"));
    timers.arm("r1", "deadline", 300, () => fired.push("second"));
    expect(clock.live()).toBe(1);
    clock.advance(300);
    expect(fired).toEqual(["second"]);
  });

  test("取消没拦住的旧回调不执行，也不摘掉新挂的同名定时器", () => {
    const { timers, clock } = createTimers(createClock(false));
    const fired: string[] = [];
    timers.arm("r1", "deadline", 100, () => fired.push("stale"));
    timers.arm("r1", "deadline", 300, () => fired.push("fresh"));
    clock.advance(100);
    expect(fired).toEqual([]);
    expect(timers.isArmed("r1", "deadline")).toBe(true);
    clock.advance(200);
    expect(fired).toEqual(["fresh"]);
  });

  test("不同房间、不同名称互不影响", () => {
    const { timers, clock } = createTimers();
    const fired: string[] = [];
    timers.arm("r1", "a", 100, () => fired.push("r1:a"));
    timers.arm("r1", "b", 100, () => fired.push("r1:b"));
    timers.arm("r2", "a", 100, () => fired.push("r2:a"));
    timers.clear("r1", "a");
    clock.advance(100);
    expect(fired).toEqual(["r1:b", "r2:a"]);
  });

  test("解散后该房任何名字的 isArmed 恒假，到点也不再触发", () => {
    const { timers, clock } = createTimers();
    const fired: string[] = [];
    for (const name of ["phase", "fallback", "deadline"])
      timers.arm("r1", name, 100, () => fired.push(name));
    timers.arm("r2", "phase", 100, () => fired.push("other"));
    timers.clear("r1");
    // 底层定时器也要真的取消，不能只靠登记表把回调挡掉。
    expect(clock.live()).toBe(1);
    for (const name of ["phase", "fallback", "deadline", "never-armed"])
      expect(timers.isArmed("r1", name)).toBe(false);
    clock.advance(100);
    expect(fired).toEqual(["other"]);
    timers.clear("r1");
    timers.clear("r1", "phase");
  });

  test("回调同步抛错与异步拒绝都进 onError，不影响别的定时器", async () => {
    const { timers, clock, errors } = createTimers();
    const fired: string[] = [];
    const syncError = new Error("同步失败");
    const asyncError = new Error("异步失败");
    timers.arm("r1", "sync", 100, () => {
      throw syncError;
    });
    timers.arm("r2", "async", 100, async () => {
      await Promise.resolve();
      throw asyncError;
    });
    timers.arm("r3", "ok", 100, () => {
      fired.push("ok");
    });
    clock.advance(100);
    await flush();
    expect(fired).toEqual(["ok"]);
    expect(errors).toEqual([
      ["r1", "sync", syncError],
      ["r2", "async", asyncError],
    ]);
  });

  test("回调里可以重挂同名定时器", () => {
    const { timers, clock } = createTimers();
    let count = 0;
    const tick = () => {
      count += 1;
      if (count < 3) timers.arm("r1", "tick", 10, tick);
    };
    timers.arm("r1", "tick", 10, tick);
    clock.advance(10);
    expect(timers.isArmed("r1", "tick")).toBe(true);
    clock.advance(10);
    clock.advance(10);
    expect(count).toBe(3);
    expect(timers.isArmed("r1", "tick")).toBe(false);
  });

  test("clearAll 清掉全部房间；负的延迟按立即处理", () => {
    const { timers, clock } = createTimers();
    const fired: string[] = [];
    timers.arm("r1", "a", 100, () => fired.push("a"));
    timers.arm("r2", "b", 100, () => fired.push("b"));
    timers.clearAll();
    expect(clock.live()).toBe(0);
    expect([timers.isArmed("r1", "a"), timers.isArmed("r2", "b")]).toEqual([false, false]);
    clock.advance(100);
    expect(fired).toEqual([]);
    timers.arm("r3", "late", -50, () => fired.push("late"));
    clock.advance(0);
    expect(fired).toEqual(["late"]);
  });

  test("缺省挂真实定时器且不拖住进程退出", async () => {
    const original = globalThis.setTimeout;
    const created: ReturnType<typeof setTimeout>[] = [];
    globalThis.setTimeout = ((handler: () => void, delay?: number) => {
      const timer = original(handler, delay);
      created.push(timer);
      return timer;
    }) as typeof setTimeout;
    try {
      const fired = Promise.withResolvers<string>();
      const timers = new RoomTimers({ onError: () => {} });
      timers.arm("r1", "real", 1, () => fired.resolve("fired"));
      expect(created).toHaveLength(1);
      expect(created[0].hasRef()).toBe(false);
      expect(await fired.promise).toBe("fired");
    } finally {
      globalThis.setTimeout = original;
    }
  });
});
