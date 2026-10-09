import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduleDatasetBackup } from "../src/infrastructure/DatasetBackup";

const makeDataset = (directory: string) => {
  const dbPath = join(directory, "bangumi.sqlite");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE subjects(id INTEGER PRIMARY KEY, name TEXT)");
  db.query("INSERT INTO subjects VALUES (1, '最初')").run();
  db.close();
  return dbPath;
};

const read = (path: string) => {
  const db = new Database(path, { readonly: true });
  try { return db.query("SELECT name FROM subjects WHERE id = 1").get() as { name: string } | null; }
  finally { db.close(); }
};

test("启动时立即备份，且备份是可读的完整快照", () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-backup-"));
  const dbPath = makeDataset(directory);
  const backupPath = `${dbPath}.backup`;

  const spy = spyOn(globalThis, "setTimeout");
  try {
    const stop = scheduleDatasetBackup({ dbPath, backupPath });
    expect(existsSync(backupPath)).toBe(true);
    expect(read(backupPath)).toEqual({ name: "最初" });
    stop();
  } finally {
    spy.mockRestore();
  }
});

test("只保留一份：新一轮覆盖旧快照，不留历史备份", () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-backup-"));
  const dbPath = makeDataset(directory);
  const backupPath = `${dbPath}.backup`;

  const spy = spyOn(globalThis, "setTimeout");
  try {
    const stop = scheduleDatasetBackup({ dbPath, backupPath });
    // 旧快照必须先删再写：VACUUM INTO 要求目标不存在，而这正好就是「只留一份」的语义。
    expect(read(backupPath)).toEqual({ name: "最初" });

    const db = new Database(dbPath);
    db.query("UPDATE subjects SET name = '更新后' WHERE id = 1").run();
    db.close();

    // 手动触发定时器回调，等价于到了 04:00。
    const fire = spy.mock.calls.at(-1)![0] as () => void;
    fire();
    expect(read(backupPath)).toEqual({ name: "更新后" });
    stop();
  } finally {
    spy.mockRestore();
  }
});

test("下次备份落在本地 04:00（已过点则顺延到次日）", () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-backup-"));
  const dbPath = makeDataset(directory);
  const backupPath = `${dbPath}.backup`;

  const at = (iso: string) => () => new Date(iso).getTime();
  const delayOf = (now: () => number) => {
    const spy = spyOn(globalThis, "setTimeout");
    try {
      const stop = scheduleDatasetBackup({ dbPath, backupPath, now });
      const delay = Number(spy.mock.calls.at(-1)![1]);
      stop();
      return delay;
    } finally {
      spy.mockRestore();
    }
  };

  // 凌晨 3 点启动 → 1 小时后备份。
  expect(delayOf(at("2026-10-10T03:00:00"))).toBe(60 * 60 * 1_000);
  // 已过 04:00 → 顺延到次日，整整一天。
  expect(delayOf(at("2026-10-10T05:00:00"))).toBe(23 * 60 * 60 * 1_000);
});

test("源库缺失时备份失败不抛出，只记一条警告", () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-backup-"));
  const warnings: string[] = [];
  const spy = spyOn(globalThis, "setTimeout");
  try {
    const stop = scheduleDatasetBackup({
      dbPath: join(directory, "missing.sqlite"),
      backupPath: join(directory, "missing.sqlite.backup"),
      logger: { warn: (message) => warnings.push(message) },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("数据集备份失败");
    stop();
  } finally {
    spy.mockRestore();
  }
});
