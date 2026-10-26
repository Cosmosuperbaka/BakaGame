import { expect, test } from "bun:test";
import { ClientWebBundle, parseManifest } from "../src/infrastructure/ClientWebBundle";

const MANIFEST_URL = "https://cdn.test/files/BakaGame-web-latest.json";

const manifest = {
  build: "abc1234",
  version: "1.9.5",
  file: "BakaGame-web-abc1234.zip",
  sha256: "a".repeat(64),
  sizeBytes: 34_000_000,
  minShellVersion: "0.1.2",
  publishedAt: "2026-10-26T08:00:00.000Z",
};

const json = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Response;

test("清单把裸文件名解析成清单同目录的绝对地址", () => {
  expect(parseManifest(manifest, MANIFEST_URL)).toEqual({
    build: "abc1234",
    version: "1.9.5",
    file: "BakaGame-web-abc1234.zip",
    sha256: "a".repeat(64),
    sizeBytes: 34_000_000,
    minShellVersion: "0.1.2",
    publishedAt: "2026-10-26T08:00:00.000Z",
    url: "https://cdn.test/files/BakaGame-web-abc1234.zip",
  });
});

test("清单字段越界或形状不对时整份作废，不把半个包发给壳", () => {
  const broken: unknown[] = [
    null,
    {},
    { ...manifest, build: "" },
    { ...manifest, build: ".." },
    { ...manifest, build: "../x" },
    { ...manifest, file: "../evil.zip" },
    { ...manifest, file: "sub/dir/bundle.zip" },
    { ...manifest, file: "bundle.tar.gz" },
    { ...manifest, sha256: "xyz" },
    { ...manifest, sizeBytes: -1 },
    { ...manifest, minShellVersion: "latest" },
    { ...manifest, publishedAt: "yesterday" },
  ];
  for (const body of broken) {
    expect(parseManifest(body, MANIFEST_URL)).toBeUndefined();
  }
});

test("清单地址不是 https 时拒绝：热更新包必须走 TLS", () => {
  expect(parseManifest(manifest, "http://cdn.test/files/BakaGame-web-latest.json")).toBeUndefined();
});

test("TTL 内复用同一份清单，失败也缓存，避免壳每次启动都去撞清单服务", async () => {
  const clock = { now: 0 };
  const calls: string[] = [];
  const bundle = new ClientWebBundle({
    manifestUrl: MANIFEST_URL,
    ttlMs: 30_000,
    now: () => clock.now,
    fetcher: (async (url: string) => {
      calls.push(url);
      return json(manifest);
    }) as unknown as typeof fetch,
  });

  await Promise.all([bundle.current(), bundle.current()]);
  expect(calls).toHaveLength(1);

  clock.now = 31_000;
  await bundle.current();
  expect(calls).toHaveLength(2);

  const failing = new ClientWebBundle({
    manifestUrl: MANIFEST_URL,
    fetcher: (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch,
  });
  expect(await failing.current()).toBeUndefined();
  expect(await failing.current()).toBeUndefined();
});

test("没配清单地址时不发请求：显式关闭热更新的实例不该有额外网络面", async () => {
  let called = false;
  const bundle = new ClientWebBundle({
    manifestUrl: "",
    fetcher: (async () => {
      called = true;
      return json(manifest);
    }) as unknown as typeof fetch,
  });
  expect(await bundle.current()).toBeUndefined();
  expect(called).toBe(false);
});
