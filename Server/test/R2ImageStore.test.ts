import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BangumiImageStore } from "../src/infrastructure/BangumiImageStore";
import { R2ImageStore, R2ImageUploader } from "../src/infrastructure/R2ImageStore";

const AVIF = new Uint8Array([
  0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 1, 2, 3, 4,
]);

function shards(count = 2) {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-r2-"));
  for (let i = 0; i < count; i += 1) {
    const db = new Database(join(directory, `images-${String(i).padStart(2, "0")}.sqlite`));
    db.exec(
      "CREATE TABLE images (path TEXT PRIMARY KEY, bytes BLOB NOT NULL, content_type TEXT NOT NULL, fetched_at INTEGER NOT NULL);"
    );
    db.close();
  }
  return directory;
}

const uploader = () => new R2ImageUploader({ accountId: "acc", apiToken: "tok", bucket: "files" });

test("put 先传 R2 再落索引：本地不留字节，读取侧据此 302", async () => {
  const directory = shards();
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init: RequestInit
  ) => {
    seen.push({ url, init });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch);
  try {
    const store = new R2ImageStore(
      BangumiImageStore.open(directory, { now: () => 3 })!,
      uploader()
    );
    await store.put("/r/200/pic/cover/l/ab/cd/1.jpg", AVIF);

    // 端点与鉴权：走 REST API（S3 端点在境内被 TLS 阻断，不能用 SigV4）。
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc/r2/buckets/files/objects/bangumi/r/200/pic/cover/l/ab/cd/1.jpg"
    );
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers["content-type"]).toBe("image/avif");
    // TTL 必须留在 int32 内：EdgeOne 写 100 年会溢出成负值，缓存永不命中。
    expect(headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(seen[0]!.init.body as ArrayBuffer)).toEqual(AVIF);

    expect(store.isRemote("/r/200/pic/cover/l/ab/cd/1.jpg")).toBe(true);
    expect(store.has("/r/200/pic/cover/l/ab/cd/1.jpg")).toBe(true);
    expect(store.get("/r/200/pic/cover/l/ab/cd/1.jpg")).toBeUndefined();
    store.close();
  } finally {
    spy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("上传失败退回本地：图不丢，且不会被标成 remote（否则 302 到 404）", async () => {
  const directory = shards();
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch
  );
  try {
    const store = new R2ImageStore(BangumiImageStore.open(directory)!, uploader());
    await expect(store.put("/r/200/pic/cover/l/ab/cd/2.jpg", AVIF)).rejects.toThrow("R2 写入失败");
    // 退回本地：读得到字节，但不标 remote —— 读取侧继续本地直出，不会 302 到 404。
    expect(store.isRemote("/r/200/pic/cover/l/ab/cd/2.jpg")).toBe(false);
    expect(store.has("/r/200/pic/cover/l/ab/cd/2.jpg")).toBe(true);
    expect(store.get("/r/200/pic/cover/l/ab/cd/2.jpg")?.bytes).toEqual(AVIF);
    store.close();
  } finally {
    spy.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
