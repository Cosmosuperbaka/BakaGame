import { expect, test } from "bun:test";
import { SlidingWindowRateLimiter } from "../src/infrastructure/RateLimiter";

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
