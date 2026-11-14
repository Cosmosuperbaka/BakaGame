import { describe, expect, test } from "bun:test";
import { MusicCache } from "../src/infrastructure/music/MusicCache";

type CacheOptions = ConstructorParameters<typeof MusicCache>[0];

/** 让出一轮事件循环，把后台刷新的整条 Promise 链跑完。 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * 构造缓存并截下维护定时器的回调：定时器周期是写死的 60s，测试不能真等。
 * 替换只在构造期间同步生效，构造完成立刻还原，不留全局副作用，也不起真实定时器。
 */
const createCache = (options: CacheOptions) => {
  let fire: (() => void) | undefined;
  const real = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => void) => {
    fire = fn;
    return { unref() {} };
  }) as typeof setInterval;
  let cache: MusicCache;
  try {
    cache = new MusicCache(options);
  } finally {
    globalThis.setInterval = real;
  }
  return {
    cache,
    maintenance: async () => {
      fire!();
      await flush();
    },
  };
};

describe("MusicCache 软/硬 TTL", () => {
  test("命中缓存不重复回源，返回值是克隆，调用方改动不污染缓存", async () => {
    const now = 0;
    let calls = 0;
    const { cache } = createCache({ now: () => now, isUpstreamBusy: () => false });
    const loader = async () => {
      calls += 1;
      return { items: [1, 2] };
    };

    const first = await cache.cached("k", 1000, loader);
    const second = await cache.cached("k", 1000, loader);
    expect(calls).toBe(1);
    expect(second).toEqual(first);

    first.items.push(3);
    expect(await cache.cached("k", 1000, loader)).toEqual({ items: [1, 2] });
  });

  test("硬过期（3×TTL）之后强制回源", async () => {
    let now = 0;
    let calls = 0;
    const { cache } = createCache({ now: () => now, isUpstreamBusy: () => false });
    const loader = async () => ({ v: ++calls });

    await cache.cached("k", 1000, loader);
    now = 3001;
    expect(await cache.cached("k", 1000, loader)).toEqual({ v: 2 });
    expect(calls).toBe(2);
  });

  test("软过期（0.8×TTL）先返回旧值，再后台静默刷新", async () => {
    let now = 0;
    let calls = 0;
    const { cache } = createCache({ now: () => now, isUpstreamBusy: () => false });
    const loader = async () => ({ v: ++calls });

    await cache.cached("k", 1000, loader);
    now = 900;
    expect(await cache.cached("k", 1000, loader)).toEqual({ v: 1 });
    await flush();
    expect(calls).toBe(2);
    expect(cache.peek("k")).toEqual({ v: 2 });
  });

  test("上游忙态跳过后台刷新，旧值照常服务", async () => {
    let now = 0;
    let calls = 0;
    let busy = false;
    const { cache } = createCache({ now: () => now, isUpstreamBusy: () => busy });
    const loader = async () => ({ v: ++calls });

    await cache.cached("k", 1000, loader);
    now = 900;
    busy = true;
    expect(await cache.cached("k", 1000, loader)).toEqual({ v: 1 });
    await flush();
    expect(calls).toBe(1);
  });

  test("ttlForResult 返回 0 不入缓存，返回自定义 TTL 按它定硬过期", async () => {
    let now = 0;
    let calls = 0;
    const { cache } = createCache({ now: () => now, isUpstreamBusy: () => false });
    const loader = async () => {
      calls += 1;
      return "x";
    };

    await cache.cached("zero", 1000, loader, { ttlForResult: () => 0 });
    await cache.cached("zero", 1000, loader, { ttlForResult: () => 0 });
    expect(calls).toBe(2);

    await cache.cached("short", 1000, loader, { ttlForResult: () => 100 });
    now = 301;
    await cache.cached("short", 1000, loader, { ttlForResult: () => 100 });
    expect(calls).toBe(4);
  });
});

describe("MusicCache 并发与负结果", () => {
  test("同键并发请求合并为一次上游调用", async () => {
    const now = 0;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { cache } = createCache({ now: () => now, isUpstreamBusy: () => false });
    const loader = async () => {
      calls += 1;
      await gate;
      return { v: calls };
    };

    const pending = Promise.all([
      cache.cached("k", 1000, loader),
      cache.cached("k", 1000, loader),
      cache.cached("k", 1000, loader),
    ]);
    release();
    const [a, b, c] = await pending;
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  test("cacheNegative 为 false 时空值不入缓存，缺省仍缓存负结果", async () => {
    const now = 0;
    let calls = 0;
    const { cache } = createCache({ now: () => now, isUpstreamBusy: () => false });
    const loader = async () => {
      calls += 1;
      return "";
    };

    await cache.cached("neg", 1000, loader, { cacheNegative: false });
    await cache.cached("neg", 1000, loader, { cacheNegative: false });
    expect(calls).toBe(2);

    await cache.cached("pos", 1000, loader);
    await cache.cached("pos", 1000, loader);
    expect(calls).toBe(3);
  });

  test("force 绕过缓存强制回源，invalidate 丢弃后下次回源", async () => {
    const now = 0;
    let calls = 0;
    const { cache } = createCache({ now: () => now, isUpstreamBusy: () => false });
    const loader = async () => ({ v: ++calls });

    await cache.cached("k", 1000, loader);
    await cache.cached("k", 1000, loader, { force: true });
    expect(calls).toBe(2);

    cache.invalidate("k");
    await cache.cached("k", 1000, loader);
    expect(calls).toBe(3);
  });
});

describe("MusicCache peek 与维护", () => {
  test("peek 不统计命中也不触发刷新，硬过期后读不到", async () => {
    let now = 0;
    let calls = 0;
    const { cache } = createCache({ now: () => now, isUpstreamBusy: () => false });
    const loader = async () => ({ v: ++calls });

    await cache.cached("k", 1000, loader);
    now = 900;
    expect(cache.peek("k")).toEqual({ v: 1 });
    await flush();
    expect(calls).toBe(1);

    now = 3001;
    expect(cache.peek("k")).toBeUndefined();
  });

  test("空闲超过 30 分钟：低命中且久未访问的条目被淘汰", async () => {
    let now = 0;
    let calls = 0;
    const { cache, maintenance } = createCache({ now: () => now, isUpstreamBusy: () => false });
    const loader = async () => ({ v: ++calls });
    // 长 TTL 让条目在 31 分钟时仍未硬过期，peek 读不到只能是被淘汰，而非过期。
    const ttl = 60 * 60_000;

    await cache.cached("idle", ttl, loader);
    now = 31 * 60_000;
    await maintenance();
    expect(cache.peek("idle")).toBeUndefined();

    await cache.cached("idle", ttl, loader);
    expect(calls).toBe(2);
  });

  test("上游忙态时连空闲淘汰也暂缓，条目原样留着", async () => {
    let now = 0;
    let busy = false;
    const { cache, maintenance } = createCache({ now: () => now, isUpstreamBusy: () => busy });
    const ttl = 60 * 60_000;

    await cache.cached("idle", ttl, async () => ({ v: 1 }));
    now = 31 * 60_000;
    busy = true;
    await maintenance();
    expect(cache.peek("idle")).toEqual({ v: 1 });

    busy = false;
    await maintenance();
    expect(cache.peek("idle")).toBeUndefined();
  });

  test("活跃期内维护刷新软过期条目，上游忙态时整段跳过", async () => {
    let now = 0;
    let calls = 0;
    let busy = false;
    const { cache, maintenance } = createCache({
      now: () => now,
      isUpstreamBusy: () => busy,
    });
    const loader = async () => ({ v: ++calls });

    await cache.cached("k", 1000, loader);
    now = 900;
    busy = true;
    await maintenance();
    expect(calls).toBe(1);

    busy = false;
    await maintenance();
    expect(calls).toBe(2);
    expect(cache.peek("k")).toEqual({ v: 2 });
  });

  test("后台刷新失败经 onRefreshFailure 告警，不影响旧值", async () => {
    let now = 0;
    let calls = 0;
    const failures: Array<[string, unknown]> = [];
    const { cache } = createCache({
      now: () => now,
      isUpstreamBusy: () => false,
      onRefreshFailure: (key, error) => failures.push([key, error]),
    });
    const loader = async () => {
      calls += 1;
      if (calls === 1) return { v: 1 };
      throw new Error("upstream down");
    };

    await cache.cached("k", 1000, loader);
    now = 900;
    expect(await cache.cached("k", 1000, loader)).toEqual({ v: 1 });
    await flush();
    expect(failures).toHaveLength(1);
    expect(failures[0][0]).toBe("k");
    expect(failures[0][1]).toBeInstanceOf(Error);
  });
});
