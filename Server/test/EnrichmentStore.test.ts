import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CEEEnrichment } from "../src/infrastructure/CEEEnrichment";
import { EnrichmentStore } from "../src/infrastructure/EnrichmentStore";

describe("回填缓存存取", () => {
  test("合并写入只覆盖给出的字段，另一个写入方的字段保留", () => {
    const store = new EnrichmentStore();
    store.merge("character", 7, { image: "https://lain.bgm.tv/a.jpg", grid: "https://lain.bgm.tv/g.jpg" }, 1);
    // 猜歌侧只带 image：不能抹掉 CEE 已落的 grid。
    store.merge("character", 7, { image: "https://lain.bgm.tv/b.jpg" }, 2);
    expect(store.read("character", 7)).toEqual({
      image: "https://lain.bgm.tv/b.jpg",
      grid: "https://lain.bgm.tv/g.jpg",
    });
    expect(store.read("character", 8)).toBeUndefined();
    expect(store.read("subject", 7)).toBeUndefined();
    store.close();
  });

  test("落盘路径的父目录会被建出来，重新打开能读到", () => {
    const directory = mkdtempSync(join(tmpdir(), "enrichment-store-"));
    try {
      const path = join(directory, "nested", "enrichment.sqlite");
      const first = new EnrichmentStore(path);
      first.merge("subject", 1, { image: "https://lain.bgm.tv/s.jpg" }, 1);
      first.close();
      const second = new EnrichmentStore(path);
      expect(second.read("subject", 1)).toEqual({ image: "https://lain.bgm.tv/s.jpg" });
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("注入的实例不会被使用方关闭", async () => {
    const store = new EnrichmentStore();
    const enrichment = new CEEEnrichment({ dbPath: "unused", enrichment: store });
    await enrichment.close();
    // 仍可使用：关闭权在创建方。
    store.merge("subject", 1, { image: "https://lain.bgm.tv/s.jpg" }, 1);
    expect(store.read("subject", 1)?.image).toBe("https://lain.bgm.tv/s.jpg");
    store.close();
  });
});
