import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readDatasetStatus } from "../src/infrastructure/BangumiMirrorStatus";
import { SubjectUpdater } from "../src/infrastructure/SubjectUpdater";

const NOW = Date.UTC(2026, 10, 7);

const makeDb = () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE subjects(id INTEGER PRIMARY KEY, date TEXT);
    CREATE TABLE characters(id INTEGER PRIMARY KEY);
    INSERT INTO subjects VALUES (1, '2026-10-01'), (2, '2099-01-01'), (3, '');
    INSERT INTO characters VALUES (1);
  `);
  return db;
};

const makeUpdater = () => {
  const db = makeDb();
  return { db, updater: new SubjectUpdater({ db, base: "https://bgm.invalid", now: () => NOW }) };
};

test("维护结果落库并按任务覆盖，错误摘要抹掉地址与路径", () => {
  const { db, updater } = makeUpdater();
  updater.recordMaintenanceRun({
    task: "discovery",
    ok: false,
    summary: "新条目发现失败",
    error: "请求 https://mirror.example.com/v0/x 失败，库在 /data/bangumi.sqlite",
  });
  const failed = updater.stats().maintenance[0];
  expect(failed).toMatchObject({ task: "discovery", ok: false, finishedAt: NOW });
  expect(failed.error).not.toContain("example.com");
  expect(failed.error).not.toContain("bangumi.sqlite");

  updater.recordMaintenanceRun({ task: "discovery", ok: true, summary: "候选 3", error: null });
  expect(updater.stats().maintenance).toEqual([
    { task: "discovery", finishedAt: NOW, ok: true, summary: "候选 3", error: null },
  ]);
  db.close();
});

test("快照给出数量与新鲜度，基线登记不算真实刷新，未来排期不算最新日期", () => {
  const { db, updater } = makeUpdater();
  updater.markDatasetFresh();
  expect(updater.stats()).toMatchObject({
    subjects: 3,
    characters: 1,
    refreshed: 3,
    latestRefreshAt: null,
    baselineAt: NOW,
    failingSubjects: 0,
    latestSubjectDate: "2026-10-01",
    lastRound: null,
    startedAt: null,
  });

  db.exec("UPDATE bangumi_refresh SET tier = 0, refreshed_at = 4000 WHERE subject_id = 1");
  db.exec(
    "UPDATE bangumi_refresh SET tier = 1, refreshed_at = 4500, failures = 2 WHERE subject_id = 2"
  );
  expect(updater.stats()).toMatchObject({ latestRefreshAt: 4_000, failingSubjects: 1 });
  db.close();
});

test("没有状态表时按尚无记录读取，只读分片不会因此报错", () => {
  const db = makeDb();
  expect(readDatasetStatus(db, NOW)).toEqual({
    subjects: 3,
    characters: 1,
    refreshed: 0,
    pendingIndex: 0,
    latestRefreshAt: null,
    baselineAt: null,
    failingSubjects: 0,
    latestSubjectDate: "2026-10-01",
    maintenance: [],
  });
  db.close();
});
