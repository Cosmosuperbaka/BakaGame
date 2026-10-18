import { expect, test } from "bun:test";
import { SlidingWindowRateLimiter, ThreeTierRateLimiter } from "../src/infrastructure/RateLimiter";

test("consume 报出剩余额度与最早可重试时刻，供限流响应头直接引用", () => {
  const limiter = new SlidingWindowRateLimiter({ windowMs: 100, maxRequests: 2 });
  expect(limiter.consume("a", 0)).toEqual({ allowed: true, retryAfterMs: 0, resetAt: 100, limit: 2, remaining: 1 });
  expect(limiter.consume("a", 50)).toEqual({ allowed: true, retryAfterMs: 0, resetAt: 100, limit: 2, remaining: 0 });

  // 窗口是滑动的：能重试的时刻是最早那次请求出窗的一刻，不是「从现在起再等一个窗口」。
  expect(limiter.consume("a", 90)).toEqual({ allowed: false, retryAfterMs: 10, resetAt: 100, limit: 2, remaining: 0 });
});

test("三层桶把第一个被拒的桶的额度报出来，响应头说得出是谁用完", () => {
  const limiter = new ThreeTierRateLimiter({
    windowMs: 100,
    ipMaxRequests: 2,
    peerMaxRequests: 3,
    globalMaxRequests: 100,
  });
  // 三个新地址各占一份 peer 额度：单客户端桶都还没满。
  expect(limiter.consume("ip1", "peer", 0).remaining).toBe(1);
  expect(limiter.consume("ip2", "peer", 10).remaining).toBe(1);
  expect(limiter.consume("ip3", "peer", 20).remaining).toBe(1);

  // 第四个地址自己没历史，被 peer 桶封顶：limit 报的是 peer 的 3，不是单客户端的 2。
  const rejected = limiter.consume("ip4", "peer", 30);
  expect(rejected.allowed).toBe(false);
  expect(rejected.limit).toBe(3);
  expect(rejected.remaining).toBe(0);
  expect(rejected.retryAfterMs).toBe(70);
  expect(rejected.resetAt).toBe(100);

  // 额度用满的单客户端桶同样报自己的额度。
  const ip = new ThreeTierRateLimiter({ windowMs: 100, ipMaxRequests: 1, globalMaxRequests: 100 });
  expect(ip.consume("ip9", "ip9", 0).allowed).toBe(true);
  expect(ip.consume("ip9", "ip9", 10).limit).toBe(1);
});

test("滑动窗口拒绝不占配额，边界时刻过期后放行", () => {
  const limiter = new SlidingWindowRateLimiter({ windowMs: 100, maxRequests: 2 });
  expect(limiter.allow("a", 0)).toBe(true);
  expect(limiter.allow("a", 50)).toBe(true);
  expect(limiter.allow("a", 99)).toBe(false);
  expect(limiter.allow("a", 100)).toBe(true);
  expect(limiter.allow("a", 149)).toBe(false);
  expect(limiter.allow("a", 150)).toBe(true);
});

test("5000 活跃 key 不全表扫描或淘汰有效配额，拒绝流量不延长窗口", () => {
  const limiter = new SlidingWindowRateLimiter({ windowMs: 100, maxRequests: 1 });
  for (let i = 0; i < 5000; i++) expect(limiter.allow(`key${i}`, 0)).toBe(true);
  const windows = (limiter as any).windows as Map<string, number[]>;
  const entries = windows[Symbol.iterator].bind(windows);
  let visits = 0;
  windows[Symbol.iterator] = function* () {
    for (const entry of entries()) { visits++; yield entry; }
    return undefined;
  };
  for (let i = 0; i < 100; i++) expect(limiter.allow(`key${i}`, 50)).toBe(false);
  expect(visits).toBe(100);
  expect(windows.size).toBe(5000);
  visits = 0;
  expect(limiter.allow("new", 100)).toBe(true);
  expect(visits).toBeLessThanOrEqual(65);
  expect(windows.size).toBe(4937);
  expect(limiter.allow("key4999", 100)).toBe(true);
  expect(limiter.allow("key4999", 100)).toBe(false);
});

test("拒绝及重复访问不乱序，持续 churn 有界摊还回收全部过期 key", () => {
  const limiter = new SlidingWindowRateLimiter({ windowMs: 100, maxRequests: 2 });
  for (let i = 0; i < 1001; i++) limiter.allow(`key${i}`, 0);
  expect(limiter.allow("key0", 80)).toBe(true);
  expect(limiter.allow("key0", 90)).toBe(false);
  for (let i = 0; i < 20; i++) limiter.allow(`new${i}`, 100);
  const windows = (limiter as any).windows as Map<string, number[]>;
  expect(windows.size).toBe(21);
  expect(windows.get("key0")).toEqual([0, 80]);
  expect(limiter.allow("key0", 100)).toBe(true);
  expect(limiter.allow("key0", 179)).toBe(false);
  expect(limiter.allow("key0", 180)).toBe(true);
  limiter.reset();
  expect(windows.size).toBe(0);
  expect(limiter.allow("key0", 180)).toBe(true);
});

test("时钟回退不会使回收删除仍有效的请求配额", () => {
  const limiter = new SlidingWindowRateLimiter({ windowMs: 100, maxRequests: 2 });
  expect(limiter.allow("a", 100)).toBe(true);
  expect(limiter.allow("a", 50)).toBe(true);
  expect(limiter.allow("a", 150)).toBe(true);
  expect(limiter.allow("a", 150)).toBe(false);
});

test("键数达到上限时挤掉最久未被用到的键，内存不随对方按需自造的新键增长", () => {
  const limiter = new SlidingWindowRateLimiter({ windowMs: 10_000, maxRequests: 1, maxKeys: 8 });
  // 同一次时钟里狂换键：这正是「客户端可影响的键」被拿来撑内存的形状。
  for (let i = 0; i < 40; i += 1) expect(limiter.allow(`k${i}`, 1000)).toBe(true);
  expect(limiter.trackedKeys).toBe(8);
  // 被挤出的键重新记一笔，等于重新给一份配额——容量优先于精确记账，是有意的降级方向。
  expect(limiter.allow("k0", 1000)).toBe(true);
  expect(limiter.trackedKeys).toBe(8);
  // 上限内不误伤：没满时同一个键的配额照旧连续生效。
  const roomy = new SlidingWindowRateLimiter({ windowMs: 10_000, maxRequests: 1, maxKeys: 8 });
  expect(roomy.allow("a", 1000)).toBe(true);
  expect(roomy.allow("a", 1000)).toBe(false);
});
