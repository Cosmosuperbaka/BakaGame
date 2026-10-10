import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BangumiImageStore } from "../src/infrastructure/BangumiImageStore";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bakagame-image-store-"));
  for (let i = 0; i < 16; i++) {
    const db = new Database(join(dir, `images-${String(i).padStart(2, "0")}.sqlite`));
    db.exec("CREATE TABLE images (path TEXT PRIMARY KEY, bytes BLOB NOT NULL, content_type TEXT NOT NULL, fetched_at INTEGER NOT NULL);");
    db.close();
  }
  return dir;
}

test("分片规则与构建脚本一致（python zlib.crc32 实测値）", () => {
  const dir = fixture();
  try {
    const store = BangumiImageStore.open(dir)!;
    expect(store.shardCount).toBe(16);
    const cases: Array<[string, number]> = [
      ["/r/200/pic/cover/l/c9/f0/8_wK0z3.jpg", 10],       // python: 1205221818 % 16
      ["/pic/crt/g/b1/9c/87968_crt_z9LaF.jpg", 3],        // python: 1351984339 % 16
      ["/r/400/pic/crt/l/b1/9c/87968_crt_z9LaF.jpg", 6],  // python: 2709939238 % 16
    ];
    for (const [path, shard] of cases) {
      expect(Bun.hash.crc32(path) % 16).toBe(shard);
      store.put(path, new Uint8Array([1, 2, 3]));
      const db = new Database(join(dir, `images-${String(shard).padStart(2, "0")}.sqlite`), { readonly: true });
      expect(db.query("SELECT count(*) AS n FROM images WHERE path=?").get(path)).toEqual({ n: 1 });
      db.close();
    }
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20_000);

test("put/has/get 回环与只读拒绝", () => {
  const dir = fixture();
  try {
    const store = BangumiImageStore.open(dir)!;
    expect(store.has("/x/a.jpg")).toBe(false);
    store.put("/x/a.jpg", new Uint8Array([0x66, 0x74, 0x79, 0x70]), "image/avif");
    expect(store.has("/x/a.jpg")).toBe(true);
    const got = store.get("/x/a.jpg")!;
    expect(got.contentType).toBe("image/avif");
    expect([...got.bytes]).toEqual([0x66, 0x74, 0x79, 0x70]);
    expect(store.count()).toBe(1);
    store.close();

    const ro = BangumiImageStore.open(dir, { readOnly: true })!;
    expect(ro.get("/x/a.jpg")?.contentType).toBe("image/avif");
    expect(() => ro.put("/x/b.jpg", new Uint8Array([1]))).toThrow("只读图床实例不能写入");
    ro.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20_000);

test("目录缺失或没有分片 → undefined（调用方降级为无图床）", () => {
  expect(BangumiImageStore.open(join(tmpdir(), `bakagame-missing-${crypto.randomUUID()}`))).toBeUndefined();
  const empty = mkdtempSync(join(tmpdir(), "bakagame-empty-"));
  try { expect(BangumiImageStore.open(empty)).toBeUndefined(); }
  finally { rmSync(empty, { recursive: true, force: true }); }
});
