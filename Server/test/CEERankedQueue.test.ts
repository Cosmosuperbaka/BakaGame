import { describe, expect, test } from "bun:test";
import { AppError } from "../src/domain/Errors";
import {
  CEE_RANKED_REMATCH_COOLDOWN_MS,
  CEE_RANKED_WINDOW_INITIAL,
  CEE_RANKED_WINDOW_MAX,
  CEE_RANKED_WINDOW_STEP,
  CEERankedQueue,
  ceeRankedWindow,
  type CEERankedQueueEntry,
} from "../src/application/CEERankedQueue";
import { CEE_RANKED_BOT_FALLBACK_MS } from "../src/shared/Index";

const BASE = 1_000_000;

const entry = (
  userId: string,
  rating: number,
  queuedAt: number,
  lastOpponent: CEERankedQueueEntry["lastOpponent"] = null
): CEERankedQueueEntry => ({ userId, rating, queuedAt, lastOpponent });

const pairIds = (queue: CEERankedQueue, now: number): string[][] =>
  queue.tick(now).pairs.map(([first, second]) => [first.userId, second.userId]);

describe("排位匹配窗口", () => {
  test("每等满 5 秒放宽一档，封顶后不再放宽", () => {
    const queued = entry("a", 1500, BASE);
    expect(ceeRankedWindow(queued, BASE)).toBe(CEE_RANKED_WINDOW_INITIAL);
    expect(ceeRankedWindow(queued, BASE + 4_999)).toBe(CEE_RANKED_WINDOW_INITIAL);
    expect(ceeRankedWindow(queued, BASE + 5_000)).toBe(
      CEE_RANKED_WINDOW_INITIAL + CEE_RANKED_WINDOW_STEP
    );
    expect(ceeRankedWindow(queued, BASE + 35_000)).toBe(CEE_RANKED_WINDOW_MAX);
    expect(ceeRankedWindow(queued, BASE + 600_000)).toBe(CEE_RANKED_WINDOW_MAX);
    // 时钟回拨不会把窗口压到初始值以下。
    expect(ceeRankedWindow(queued, BASE - 10_000)).toBe(CEE_RANKED_WINDOW_INITIAL);
  });
});

describe("排位匹配队列", () => {
  test("同一账号重复入队被拒，取消后可再排", () => {
    const queue = new CEERankedQueue();
    queue.add(entry("a", 1500, BASE));
    expect(() => queue.add(entry("a", 1600, BASE + 1000))).toThrow(AppError);
    expect(queue.size).toBe(1);
    expect(queue.remove("a")?.rating).toBe(1500);
    expect(queue.remove("a")).toBeUndefined();
    expect(queue.size).toBe(0);
    queue.add(entry("a", 1500, BASE));
    expect(queue.get("a")?.userId).toBe("a");
  });

  test("分差在窗口内才配对，且取分差最小的那个", () => {
    const queue = new CEERankedQueue();
    queue.add(entry("a", 1500, BASE));
    queue.add(entry("b", 1560, BASE + 1_000));
    queue.add(entry("c", 1510, BASE + 2_000));
    expect(pairIds(queue, BASE)).toEqual([["a", "c"]]);
    expect(queue.size).toBe(1);
    expect(queue.get("b")?.userId).toBe("b");
  });

  test("分差并列时取更早排队的那个", () => {
    const queue = new CEERankedQueue();
    queue.add(entry("a", 1500, BASE));
    queue.add(entry("b", 1550, BASE + 2_000));
    queue.add(entry("c", 1450, BASE + 3_000));
    expect(pairIds(queue, BASE)).toEqual([["a", "b"]]);
  });

  test("窗口没放宽到分差以上就不配：等人变多再一起配", () => {
    const queue = new CEERankedQueue();
    queue.add(entry("a", 1500, BASE));
    queue.add(entry("b", 1900, BASE));
    expect(queue.tick(BASE).pairs).toEqual([]);
    expect(queue.size).toBe(2);
    // 双方都等满 35 秒后窗口到 500，400 的分差才配得上。
    expect(pairIds(queue, BASE + 36_000)).toEqual([["a", "b"]]);
  });

  test("三分钟内不重复匹配同一对手，改配别人", () => {
    const queue = new CEERankedQueue();
    queue.add(entry("a", 1500, BASE, { userId: "c", at: BASE - 60_000 }));
    queue.add(entry("c", 1510, BASE + 1_000, { userId: "a", at: BASE - 60_000 }));
    queue.add(entry("b", 1550, BASE + 2_000));
    expect(pairIds(queue, BASE)).toEqual([["a", "b"]]);
    expect(queue.get("c")?.userId).toBe("c");
  });

  test("冷却期一过就允许再次相遇", () => {
    const queue = new CEERankedQueue();
    const lastAt = BASE - CEE_RANKED_REMATCH_COOLDOWN_MS;
    queue.add(entry("a", 1500, BASE, { userId: "c", at: lastAt }));
    queue.add(entry("c", 1510, BASE + 1_000, { userId: "a", at: lastAt }));
    expect(pairIds(queue, BASE)).toEqual([["a", "c"]]);
  });

  test("双方窗口都到顶时解除重复匹配限制", () => {
    const queue = new CEERankedQueue();
    const lastAt = BASE - 1_000;
    // 一侧等 36 秒（窗口 500）、一侧等 34 秒（窗口 450）：没同时到顶，限制仍生效。
    // 两人都等满了兜底时长，所以这一跳谁也没配上真人。
    queue.add(entry("a", 1500, BASE - 36_000, { userId: "c", at: lastAt }));
    queue.add(entry("c", 1510, BASE - 34_000, { userId: "a", at: lastAt }));
    const early = queue.tick(BASE);
    expect(early.pairs).toEqual([]);
    expect(early.fallbacks.map((item) => item.userId)).toEqual(["a", "c"]);

    queue.add(entry("a", 1500, BASE - 36_000, { userId: "c", at: lastAt }));
    queue.add(entry("c", 1510, BASE - 36_000, { userId: "a", at: lastAt }));
    expect(pairIds(queue, BASE)).toEqual([["a", "c"]]);
  });

  test("只有单侧记录了对手也会拦住", () => {
    const queue = new CEERankedQueue();
    queue.add(entry("a", 1500, BASE, { userId: "c", at: BASE - 10_000 }));
    queue.add(entry("c", 1510, BASE + 1_000));
    expect(pairIds(queue, BASE)).toEqual([]);
    expect(queue.size).toBe(2);
  });

  test("等满兜底时长的人进 fallbacks，没等满的留在队里", () => {
    const queue = new CEERankedQueue();
    queue.add(entry("a", 1500, BASE));
    queue.add(entry("b", 2300, BASE + 1_000));
    expect(queue.tick(BASE + CEE_RANKED_BOT_FALLBACK_MS - 1_000)).toEqual({
      pairs: [],
      fallbacks: [],
    });
    expect(queue.size).toBe(2);
    const ticked = queue.tick(BASE + CEE_RANKED_BOT_FALLBACK_MS);
    expect(ticked.pairs).toEqual([]);
    expect(ticked.fallbacks.map((item) => item.userId)).toEqual(["a"]);
    expect(queue.get("b")?.userId).toBe("b");
  });

  test("先配真人，剩下等满的人才给人机", () => {
    const queue = new CEERankedQueue();
    queue.add(entry("a", 1500, BASE));
    queue.add(entry("b", 1520, BASE + 1_000));
    queue.add(entry("c", 2300, BASE + 2_000));
    const ticked = queue.tick(BASE + CEE_RANKED_BOT_FALLBACK_MS + 2_000);
    expect(ticked.pairs.map(([first, second]) => [first.userId, second.userId])).toEqual([
      ["a", "b"],
    ]);
    expect(ticked.fallbacks.map((item) => item.userId)).toEqual(["c"]);
  });

  test("返回的条目都已移出队列：调用方不需要再 remove", () => {
    const queue = new CEERankedQueue();
    queue.add(entry("a", 1500, BASE));
    const ticked = queue.tick(BASE + CEE_RANKED_BOT_FALLBACK_MS);
    expect(ticked.fallbacks.length).toBe(1);
    expect(queue.get("a")).toBeUndefined();
  });
});
