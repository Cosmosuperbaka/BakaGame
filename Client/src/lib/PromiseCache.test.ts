import { describe, expect, it, vi } from "vitest";
import { createPromiseCache } from "./PromiseCache";

describe("Promise 缓存", () => {
  it("同一 key 复用同一个 Promise，不同 key 各自加载", async () => {
    const load = vi.fn(async (key: string) => key.toUpperCase());
    const cache = createPromiseCache(load);

    const first = cache.get("a");
    expect(cache.get("a")).toBe(first);
    expect(cache.get("b")).not.toBe(first);
    await expect(first).resolves.toBe("A");
    expect(cache.get("a")).toBe(first);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("在途期间也复用，不会并发发两次", async () => {
    let settle: (value: number) => void = () => {};
    const load = vi.fn(() => new Promise<number>((resolve) => (settle = resolve)));
    const cache = createPromiseCache(load);

    const first = cache.get("k");
    expect(cache.get("k")).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    settle(7);
    await expect(first).resolves.toBe(7);
  });

  it("失败即删，下一次 get 重新加载", async () => {
    const load = vi
      .fn<(key: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    const cache = createPromiseCache(load);

    await expect(cache.get("k")).rejects.toThrow("boom");
    await expect(cache.get("k")).resolves.toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("invalidate 只作废一个 key，clear 作废全部", async () => {
    const load = vi.fn(async (key: string) => key);
    const cache = createPromiseCache(load);
    const a = cache.get("a");
    const b = cache.get("b");
    await Promise.all([a, b]);

    cache.invalidate("a");
    expect(cache.get("a")).not.toBe(a);
    expect(cache.get("b")).toBe(b);

    cache.clear();
    expect(cache.get("b")).not.toBe(b);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("单键用法省略 key", async () => {
    const load = vi.fn(async () => 1);
    const cache = createPromiseCache<void, number>(load);

    const first = cache.get();
    expect(cache.get()).toBe(first);
    await expect(first).resolves.toBe(1);

    cache.invalidate();
    expect(cache.get()).not.toBe(first);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
