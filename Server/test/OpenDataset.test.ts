import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDataset } from "../src/infrastructure/OpenDataset";

/** 造一份最小的真实数据集（必须是 SQLite 魔数文件，openDataset 不凭空建库）。 */
const withDataset = <T>(run: (path: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "bakagame-open-dataset-"));
  const path = join(dir, "bangumi.sqlite");
  const seed = new Database(path);
  seed.exec("CREATE TABLE subject (id INTEGER PRIMARY KEY, name TEXT)");
  seed.exec("INSERT INTO subject (id, name) VALUES (1, '初始条目')");
  seed.close();
  try {
    return run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("openDataset 的打开模式", () => {
  it("数据集缺失时直接报错，不把它伪装成空库", () => {
    const dir = mkdtempSync(join(tmpdir(), "bakagame-missing-dataset-"));
    try {
      expect(() => openDataset(join(dir, "not-there.sqlite"))).toThrow(/本地数据集不存在/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("默认可写：主片要能自己更新数据集", () => {
    withDataset((path) => {
      const db = openDataset(path);
      try {
        db.exec("INSERT INTO subject (id, name) VALUES (2, '新增条目')");
        expect(db.query("SELECT COUNT(*) AS n FROM subject").get()).toEqual({ n: 2 });
      } finally {
        db.close();
      }
    });
  });

  it("只读打开：分片上的写操作当场失败，而不是先等满 5 秒锁超时", () => {
    withDataset((path) => {
      const db = openDataset(path, true);
      try {
        // 读照常可用，读到的就是主片正在维护的那一份。
        expect(db.query("SELECT name FROM subject WHERE id = 1").get()).toEqual({
          name: "初始条目",
        });
        expect(() => db.exec("INSERT INTO subject (id, name) VALUES (3, '不该写进去')")).toThrow(
          /readonly/i
        );
      } finally {
        db.close();
      }
    });
  });
});
