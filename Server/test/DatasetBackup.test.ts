import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextDailyRunAt, scheduleDatasetBackup } from "../src/infrastructure/DatasetBackup";

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
  try {
    return db.query("SELECT name FROM subjects WHERE id = 1").get() as { name: string } | null;
  } finally {
    db.close();
  }
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

test("每日备份轮转为两代：新快照换入，上一份留作 .prev", () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-backup-"));
  const dbPath = makeDataset(directory);
  const backupPath = `${dbPath}.backup`;

  const spy = spyOn(globalThis, "setTimeout");
  try {
    const stop = scheduleDatasetBackup({ dbPath, backupPath });
    expect(read(backupPath)).toEqual({ name: "最初" });
    expect(existsSync(`${backupPath}.prev`)).toBe(false);

    const db = new Database(dbPath);
    db.query("UPDATE subjects SET name = '更新后' WHERE id = 1").run();
    db.close();

    // 手动触发定时器回调，等价于到了 04:00。
    const fire = spy.mock.calls.at(-1)![0] as () => void;
    fire();
    expect(read(backupPath)).toEqual({ name: "更新后" });
    expect(read(`${backupPath}.prev`)).toEqual({ name: "最初" });
    // 临时文件不残留。
    expect(existsSync(`${backupPath}.tmp`)).toBe(false);
    stop();
  } finally {
    spy.mockRestore();
  }
});

test("备份失败不毁掉现有快照：旧文件与上一代都原样保留，也不残留临时文件", () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-backup-"));
  const dbPath = makeDataset(directory);
  const backupPath = `${dbPath}.backup`;
  const results: Array<{ ok: boolean; error: string | null }> = [];

  const spy = spyOn(globalThis, "setTimeout");
  try {
    const stop = scheduleDatasetBackup({
      dbPath,
      backupPath,
      onResult: (result) => results.push(result),
    });
    expect(results[0]).toEqual({ ok: true, error: null });
    // 把源库换成一个不是数据库的文件：VACUUM INTO 必然失败。
    writeFileSync(dbPath, "this is not a database".repeat(200));

    (spy.mock.calls.at(-1)![0] as () => void)();
    expect(results[1]!.ok).toBe(false);
    // 失败前上一份可用快照已被删掉是旧写法的缺陷：这里必须仍然可读。
    expect(read(backupPath)).toEqual({ name: "最初" });
    expect(existsSync(`${backupPath}.tmp`)).toBe(false);
    stop();
  } finally {
    spy.mockRestore();
  }
});

test("启动时已有足够新的快照就不重做，避免重启用坏库覆盖唯一的好快照", () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-backup-"));
  const dbPath = makeDataset(directory);
  const backupPath = `${dbPath}.backup`;
  const results: Array<{ ok: boolean; error: string | null }> = [];

  const spy = spyOn(globalThis, "setTimeout");
  try {
    scheduleDatasetBackup({ dbPath, backupPath })();
    const db = new Database(dbPath);
    db.query("UPDATE subjects SET name = '之后的写入' WHERE id = 1").run();
    db.close();

    // 一小时前的快照算新：重启不重备。
    const recent = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(backupPath, recent, recent);
    scheduleDatasetBackup({ dbPath, backupPath, onResult: (r) => results.push(r) })();
    expect(results).toHaveLength(0);
    expect(read(backupPath)).toEqual({ name: "最初" });

    // 超过一天的旧快照：启动时补做一份。
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    utimesSync(backupPath, stale, stale);
    scheduleDatasetBackup({ dbPath, backupPath, onResult: (r) => results.push(r) })();
    expect(results).toHaveLength(1);
    expect(read(backupPath)).toEqual({ name: "之后的写入" });
    expect(read(`${backupPath}.prev`)).toEqual({ name: "最初" });
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

test("每次备份都回报结果：成功与失败都能留痕", () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-backup-"));
  const dbPath = makeDataset(directory);
  const results: Array<{ ok: boolean; error: string | null }> = [];
  const onResult = (result: { ok: boolean; error: string | null }) => results.push(result);
  scheduleDatasetBackup({ dbPath, backupPath: `${dbPath}.backup`, onResult })();
  scheduleDatasetBackup({
    dbPath: join(directory, "missing.sqlite"),
    backupPath: join(directory, "missing.backup"),
    onResult,
  })();
  expect(results[0]).toEqual({ ok: true, error: null });
  expect(results[1].ok).toBe(false);
  expect(results[1].error).toContain("数据集不存在");
});

test("下一次每日任务：过了 04:00 顺延到次日", () => {
  const at = (text: string) => new Date(text).getTime();
  expect(nextDailyRunAt(at("2026-10-10T03:00:00"))).toBe(at("2026-10-10T04:00:00"));
  expect(nextDailyRunAt(at("2026-10-10T05:00:00"))).toBe(at("2026-10-11T04:00:00"));
});
