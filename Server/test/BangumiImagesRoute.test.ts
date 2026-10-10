import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BangumiImageService } from "../src/infrastructure/BangumiImageService";
import { BangumiImageStore } from "../src/infrastructure/BangumiImageStore";
import { bangumiImageRoutes } from "../src/transport/routes/BangumiImages";

/** avif 只需前 16 字节内出现 `ftypav` 魔数。 */
const AVIF = new Uint8Array([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 1, 2, 3, 4]);

function shards(directory: string, count = 2) {
  mkdirSync(directory, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const db = new Database(join(directory, `images-${String(i).padStart(2, "0")}.sqlite`));
    db.exec("CREATE TABLE images (path TEXT PRIMARY KEY, bytes BLOB NOT NULL, content_type TEXT NOT NULL, fetched_at INTEGER NOT NULL);");
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
    const response = await app.handle(new Request("http://localhost/bangumi-images/r/200/pic/cover/l/ab/cd/1.jpg"));
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
    const response = await app.handle(new Request("http://localhost/bangumi-images/r/400/pic/crt/l/ab/cd/2.jpg"));
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
      persist: () => { persisted += 1; },
      now: () => 0,
    });
    const app = bangumiImageRoutes(service);
    const response = await app.handle(new Request("http://localhost/bangumi-images/r/200/pic/cover/l/ab/cd/3.jpg"));
    expect(response.status).toBe(404);
    expect(persisted).toBe(0);
    service.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("非法路径直接 400，不带图床时路由 404（不是 500）", async () => {
  const app = bangumiImageRoutes(undefined);
  expect((await app.handle(new Request("http://localhost/bangumi-images/r/200/pic/cover/l/a.jpg"))).status).toBe(404);
  const withService = bangumiImageRoutes(new BangumiImageService({
    directory: join(tmpdir(), `bakagame-missing-${crypto.randomUUID()}`), sourceBase: "", now: () => 0,
  }));
  // 双斜杠会被原样带进通配参数（裸 `..` 早在 URL 解析阶段就被规范化了），
  // 宁可 400 也不能拿去拼上游地址。
  expect((await withService.handle(new Request("http://localhost/bangumi-images//secret.jpg"))).status).toBe(400);
});

test("在途请求合并：同一张图并发只回源一次", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-images-route-"));
  try {
    let calls = 0;
    const service = new BangumiImageService({
      directory: shards(join(directory, "images")),
      sourceBase: "https://bangumi.baka.website",
      fetcher: (async () => { calls += 1; return new Response(AVIF, { status: 200 }); }) as unknown as typeof fetch,
      now: () => 0,
    });
    const results = await Promise.all([
      service.fetch("/r/200/pic/cover/l/ab/cd/4.jpg"),
      service.fetch("/r/200/pic/cover/l/ab/cd/4.jpg"),
    ]);
    expect(calls).toBe(1);
    expect(results[0]?.contentType).toBe("image/avif");
    expect(results[1]?.contentType).toBe("image/avif");
    service.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("每分钟回源上限：超速时直接放弃（不把上游打爆）", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-images-route-"));
  try {
    let calls = 0;
    let clock = 0;
    const service = new BangumiImageService({
      directory: shards(join(directory, "images")),
      sourceBase: "https://bangumi.baka.website",
      fetcher: (async () => { calls += 1; return new Response(AVIF, { status: 200 }); }) as unknown as typeof fetch,
      upstreamPerMinute: 2,
      now: () => clock,
    });
    expect(await service.fetch("/a.jpg")).toBeDefined();
    expect(await service.fetch("/b.jpg")).toBeDefined();
    expect(await service.fetch("/c.jpg")).toBeUndefined();
    expect(calls).toBe(2);
    // 过了窗口才恢复。
    clock = 61_000;
    expect(await service.fetch("/c.jpg")).toBeDefined();
    service.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
