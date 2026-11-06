import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SubjectUpdater } from "../src/infrastructure/SubjectUpdater";

const makeUpdater = () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE subjects(id INTEGER PRIMARY KEY);
    CREATE TABLE characters(id INTEGER PRIMARY KEY);
    INSERT INTO subjects VALUES (1), (2);
    INSERT INTO characters VALUES (1);
  `);
  return { db, updater: new SubjectUpdater({ db, base: "https://bgm.invalid", now: () => 5_000 }) };
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
  expect(failed).toMatchObject({ task: "discovery", ok: false, finishedAt: 5_000 });
  expect(failed.error).not.toContain("example.com");
  expect(failed.error).not.toContain("bangumi.sqlite");

  updater.recordMaintenanceRun({ task: "discovery", ok: true, summary: "候选 3", error: null });
  expect(updater.stats().maintenance).toEqual([
    { task: "discovery", finishedAt: 5_000, ok: true, summary: "候选 3", error: null },
  ]);
  db.close();
});

test("快照给出数量与新鲜度，基线登记不算真实刷新", () => {
  const { db, updater } = makeUpdater();
  updater.markDatasetFresh();
  expect(updater.stats()).toMatchObject({
    subjects: 2,
    characters: 1,
    refreshed: 2,
    latestRefreshAt: null,
    failingSubjects: 0,
    lastRound: null,
  });

  db.exec("UPDATE bangumi_refresh SET tier = 0, refreshed_at = 4000 WHERE subject_id = 1");
  db.exec("UPDATE bangumi_refresh SET tier = 1, refreshed_at = 4500, failures = 2 WHERE subject_id = 2");
  expect(updater.stats()).toMatchObject({ latestRefreshAt: 4_000, failingSubjects: 1 });
  db.close();
});
