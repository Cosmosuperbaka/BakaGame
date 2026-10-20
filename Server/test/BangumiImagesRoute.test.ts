import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BangumiImageService,
  IMAGE_CACHE_MAX_BYTES,
  IMAGE_CACHE_MAX_ENTRIES,
} from "../src/infrastructure/BangumiImageService";
import { BangumiImageStore } from "../src/infrastructure/BangumiImageStore";
import { bangumiImageRoutes } from "../src/transport/routes/BangumiImages";

/** avif 只需前 16 字节内出现 `ftypav` 魔数。 */
const AVIF = new Uint8Array([
  0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 1, 2, 3, 4,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 1, 2, 3, 4]);

function shards(directory: string, count = 2) {
  mkdirSync(directory, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const db = new Database(join(directory, `images-${String(i).padStart(2, "0")}.sqlite`));
    db.exec(
      "CREATE TABLE images (path TEXT PRIMARY KEY, bytes BLOB NOT NULL, content_type TEXT NOT NULL, fetched_at INTEGER NOT NULL);"
    );
    db.close();
  }
  return directory;
}

test("缓存命中直接回 avif，并带长缓存头", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-images-route-"));
  try {
    const store = BangumiImageStore.open(shards(join(directory, "images")))!;
    store.put("/r/200/pic/cover/l/ab/cd/1.jpg", AVIF);
    store.close();

    const service = new BangumiImageService({ directory: join(directory, "images"), now: () => 0 });
    const app = bangumiImageRoutes(service);
    const response = await app.handle(
      new Request("http://localhost/api/bangumi/r/200/pic/cover/l/ab/cd/1.jpg")
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/avif");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(AVIF);
    service.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("缺失时回源抓 avif 并转交 Worker 落库", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-images-route-"));
  try {
    const persisted: Array<{ path: string; bytes: Uint8Array }> = [];
    const seen: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen.push(url);
      expect(String((init?.headers as Record<string, string>).Accept)).toBe("image/avif");
      return new Response(AVIF, { status: 200 });
    }) as unknown as typeof fetch;
    const service = new BangumiImageService({
      directory: shards(join(directory, "images")),
      sourceBase: "https://bangumi.baka.website",
      fetcher,
      persist: (path, image) => persisted.push({ path, bytes: image.bytes }),
      now: () => 0,
    });
    const app = bangumiImageRoutes(service);
    const response = await app.handle(
      new Request("http://localhost/api/bangumi/r/400/pic/crt/l/ab/cd/2.jpg")
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual(["https://bangumi.baka.website/r/400/pic/crt/l/ab/cd/2.jpg"]);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.path).toBe("/r/400/pic/crt/l/ab/cd/2.jpg");
    service.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("回源拿到非 avif（错误页 / jpeg）不入库也不返回", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-images-route-"));
  try {
    let persisted = 0;
    const service = new BangumiImageService({
      directory: shards(join(directory, "images")),
      sourceBase: "https://bangumi.baka.website",
      fetcher: (async () => new Response(JPEG, { status: 200 })) as unknown as typeof fetch,
      persist: () => {
        persisted += 1;
      },
      now: () => 0,
    });
    const app = bangumiImageRoutes(service);
    const response = await app.handle(
      new Request("http://localhost/api/bangumi/r/200/pic/cover/l/ab/cd/3.jpg")
    );
    expect(response.status).toBe(404);
    expect(persisted).toBe(0);
    service.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("非法路径直接 400，不带图床时路由 404（不是 500）", async () => {
  const app = bangumiImageRoutes(undefined);
  expect(
    (await app.handle(new Request("http://localhost/api/bangumi/r/200/pic/cover/l/a.jpg"))).status
  ).toBe(404);
  const withService = bangumiImageRoutes(
    new BangumiImageService({
      directory: join(tmpdir(), `bakagame-missing-${crypto.randomUUID()}`),
      sourceBase: "",
      now: () => 0,
    })
  );
  // 双斜杠会被原样带进通配参数（裸 `..` 早在 URL 解析阶段就被规范化了），
  // 宁可 400 也不能拿去拼上游地址。
  expect(
    (await withService.handle(new Request("http://localhost/api/bangumi//secret.jpg"))).status
  ).toBe(400);
});

test("在途请求合并：同一张图并发只回源一次", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-images-route-"));
  try {
    let calls = 0;
    const service = new BangumiImageService({
      directory: shards(join(directory, "images")),
      sourceBase: "https://bangumi.baka.website",
      fetcher: (async () => {
        calls += 1;
        return new Response(AVIF, { status: 200 });
      }) as unknown as typeof fetch,
      now: () => 0,
    });
    const results = await Promise.all([
      service.fetch("/r/200/pic/cover/l/ab/cd/4.jpg", "203.0.113.1"),
      service.fetch("/r/200/pic/cover/l/ab/cd/4.jpg", "203.0.113.1"),
    ]);
    expect(calls).toBe(1);
    expect(results[0]).toEqual({ state: "ok", image: { bytes: AVIF, contentType: "image/avif" } });
    expect(results[1]).toEqual({ state: "ok", image: { bytes: AVIF, contentType: "image/avif" } });
    service.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("全局回源预算耗尽回 limited，不是伪装成「没有这张图」", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-images-route-"));
  try {
    let calls = 0;
    let clock = 0;
    const service = new BangumiImageService({
      directory: shards(join(directory, "images")),
      sourceBase: "https://bangumi.baka.website",
      fetcher: (async () => {
        calls += 1;
        return new Response(AVIF, { status: 200 });
      }) as unknown as typeof fetch,
      upstreamPerMinute: 2,
      perClientPerMinute: 100,
      now: () => clock,
    });
    expect((await service.fetch("/a.jpg", "203.0.113.1")).state).toBe("ok");
    expect((await service.fetch("/b.jpg", "203.0.113.2")).state).toBe("ok");
    // 第三个客户端自己一分没花，但全局预算已被前两个用光：必须是 limited，让调用方退避。
    const third = await service.fetch("/c.jpg", "203.0.113.3");
    expect(third.state).toBe("limited");
    expect(calls).toBe(2);
    if (third.state === "limited") expect(third.verdict.retryAfterMs).toBeGreaterThan(0);
    // 过了窗口才恢复。
    clock = 61_000;
    expect((await service.fetch("/c.jpg", "203.0.113.3")).state).toBe("ok");
    service.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("单客户端配额只烧自己的额度，别人照样能回源", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-images-route-"));
  try {
    let calls = 0;
    const service = new BangumiImageService({
      directory: shards(join(directory, "images")),
      sourceBase: "https://bangumi.baka.website",
      fetcher: (async () => {
        calls += 1;
        return new Response(AVIF, { status: 200 });
      }) as unknown as typeof fetch,
      upstreamPerMinute: 120,
      perClientPerMinute: 2,
      now: () => 0,
    });
    // 一个客户端连扫三个新路径：第三次被自己的额度挡住。
    expect((await service.fetch("/a.jpg", "198.51.100.7")).state).toBe("ok");
    expect((await service.fetch("/b.jpg", "198.51.100.7")).state).toBe("ok");
    expect((await service.fetch("/c.jpg", "198.51.100.7")).state).toBe("limited");
    // 全局预算还剩很多，别的客户端不受这个滥用者影响。
    expect((await service.fetch("/d.jpg", "198.51.100.8")).state).toBe("ok");
    expect(calls).toBe(3);
    service.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("配额耗尽对外是 429 与退避头，不再伪装成 404", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-images-route-"));
  try {
    const service = new BangumiImageService({
      directory: shards(join(directory, "images")),
      sourceBase: "https://bangumi.baka.website",
      fetcher: (async () => new Response(AVIF, { status: 200 })) as unknown as typeof fetch,
      upstreamPerMinute: 1,
      perClientPerMinute: 1,
      now: () => 0,
    });
    const app = bangumiImageRoutes(service);
    const url = "http://localhost/api/bangumi/r/200/pic/cover/l/ab/cd/x.jpg";
    const headers = { "x-forwarded-for": "203.0.113.9" };
    expect((await app.handle(new Request(url, { headers }))).status).toBe(200);
    const second = await app.handle(new Request(url.replace("x.jpg", "y.jpg"), { headers }));
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).not.toBeNull();
    expect(second.headers.get("x-ratelimit-remaining")).toBe("0");
    const body = (await second.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("RATE_LIMITED");
    service.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("库里存了非图片类型也只回不可执行的字节流", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-images-serve-"));
  try {
    const store = BangumiImageStore.open(shards(join(directory, "images")))!;
    store.put("/r/200/pic/cover/l/ab/cd/9.jpg", AVIF, "text/html");
    store.close();
    const service = new BangumiImageService({ directory: join(directory, "images"), now: () => 0 });
    const app = bangumiImageRoutes(service);
    const response = await app.handle(
      new Request("http://localhost/api/bangumi/r/200/pic/cover/l/ab/cd/9.jpg")
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    service.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * 开局满房时客户端成批请求同一批头像：字节缓存把这些重复请求收敛成一次同步 SQLite 读。
 * 缓存本身必须同时按条目数与总字节封顶——只限条目数时，几十张 4MB 封面照样能把长进程压穿。
 */
test("字节缓存收敛重复读，并按条目数与总字节双封顶", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-image-cache-"));
  const reads: string[] = [];
  const imageFor = (path: string) =>
    path.endsWith("/big.avif")
      ? { bytes: new Uint8Array(IMAGE_CACHE_MAX_BYTES + 1), contentType: "image/avif" }
      : { bytes: AVIF, contentType: "image/avif" };
  const spy = spyOn(BangumiImageStore.prototype, "get").mockImplementation((path: string) => {
    reads.push(path);
    return imageFor(path);
  });

  let closeService: () => void = () => {};
  try {
    const service = new BangumiImageService({
      directory: shards(join(directory, "images")),
      now: () => 0,
    });
    closeService = () => service.close();
    const get = (path: string) =>
      service.fetch(path).then((outcome) => (outcome.state === "ok" ? outcome.image : undefined));

    const first = "/r/200/pic/cover/l/a/1.jpg";
    expect(await get(first)).toEqual(imageFor(first));
    expect(await get(first)).toEqual(imageFor(first));
    expect(reads).toEqual([first]);

    // 装满上限后再进一张，最旧的 1.jpg 才被挤出——不是无上限 Map 那样越攒越多。
    for (let index = 1; index <= IMAGE_CACHE_MAX_ENTRIES + 1; index += 1)
      await get(`/r/200/pic/cover/l/a/${index}.jpg`);
    const before = reads.length;
    expect(await get(`/r/200/pic/cover/l/a/1.jpg`)).toBeDefined();
    expect(reads).toHaveLength(before + 1);

    // 单张就超过总字节上界的图：lru-cache 会拒写并抛错，这样的图只能不缓存。
    reads.length = 0;
    expect(await get("/r/200/pic/cover/l/big.avif")).toBeDefined();
    expect(await get("/r/200/pic/cover/l/big.avif")).toBeDefined();
    expect(reads).toHaveLength(2);
  } finally {
    // Windows 上被连接占用的 SQLite 文件删不掉：先关服务，断言失败时也不留脏目录。
    closeService();
    spy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
