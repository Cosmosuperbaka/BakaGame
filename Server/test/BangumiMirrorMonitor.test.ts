import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BangumiDataWorkerClient } from "../src/infrastructure/BangumiDataWorkerClient";
import {
  BangumiMirrorMonitor,
  deriveBangumiMirrorAlerts,
  type BangumiMirrorAlertInput,
} from "../src/application/BangumiMirrorMonitor";
import { adminBangumiMirrorStatusSchema } from "../src/shared/BangumiMirror";

const NOW = Date.UTC(2026, 10, 7, 12);
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

const healthy = (): BangumiMirrorAlertInput => ({
  role: "writer",
  dataset: {
    subjects: 1_000,
    characters: 2_000,
    refreshed: 1_000,
    pendingIndex: 0,
    latestRefreshAt: NOW - HOUR,
    baselineAt: NOW - 30 * DAY,
    failingSubjects: 0,
    latestSubjectDate: "2026-11-06",
    fileUpdatedAt: NOW - HOUR,
    maintenance: [
      { task: "backup", finishedAt: NOW - 8 * HOUR, ok: true, summary: "快照已更新", error: null },
      { task: "discovery", finishedAt: NOW - 8 * HOUR, ok: true, summary: "入库 3", error: null },
    ],
  },
  updater: {
    running: true,
    paused: false,
    rate: 10,
    players: 0,
    startedAt: NOW - 2 * HOUR,
    lastRound: { at: NOW - 60_000, refreshed: 1, error: null },
  },
  schedule: { nextDailyAt: NOW + 16 * HOUR, tagDiffConfigured: false },
  provider: {
    mode: "local",
    retryAt: null,
    degradedCount: 0,
    lastDegradedAt: null,
    lastErrorCode: null,
  },
  search: {
    configured: true,
    healthy: true,
    subjects: 1_000,
    characters: 2_000,
    isIndexing: false,
  },
});

const codes = (mutate: (status: BangumiMirrorAlertInput) => void) => {
  const status = healthy();
  mutate(status);
  return deriveBangumiMirrorAlerts(status, NOW).map((alert) => alert.code);
};

describe("镜像告警判定", () => {
  test("一切正常时没有告警", () => {
    expect(codes(() => {})).toEqual([]);
  });

  test("超过两天没有成功刷新算超期，边界内不算", () => {
    expect(codes((s) => (s.dataset!.latestRefreshAt = NOW - 2 * DAY))).toEqual([]);
    expect(codes((s) => (s.dataset!.latestRefreshAt = NOW - 2 * DAY - 1))).toEqual([
      "refresh_stale",
    ]);
  });

  test("还没有真实刷新时从基线起算，刚换库不算超期", () => {
    expect(
      codes((s) => {
        s.dataset!.latestRefreshAt = null;
        s.dataset!.baselineAt = NOW - DAY;
      })
    ).toEqual([]);
    expect(
      codes((s) => {
        s.dataset!.latestRefreshAt = null;
        s.dataset!.baselineAt = NOW - 3 * DAY;
      })
    ).toEqual(["refresh_stale"]);
  });

  test("每日任务超过 36 小时算超期，失败单独提示", () => {
    expect(
      codes((s) => {
        s.dataset!.maintenance[1].finishedAt = NOW - 37 * HOUR;
      })
    ).toEqual(["discovery_stale"]);
    const status = healthy();
    status.dataset!.maintenance[1] = {
      task: "discovery",
      finishedAt: NOW - HOUR,
      ok: false,
      summary: "新条目发现失败",
      error: "新条目搜索失败：HTTP 503",
    };
    expect(deriveBangumiMirrorAlerts(status, NOW)).toEqual([
      {
        level: "error",
        code: "discovery_failed",
        message: "新条目发现最近一次未成功：新条目搜索失败：HTTP 503",
      },
    ]);
  });

  test("部分条目失败只算警告，并带上结果摘要", () => {
    const status = healthy();
    status.dataset!.maintenance[1] = {
      task: "discovery",
      finishedAt: NOW - HOUR,
      ok: false,
      summary: "候选 10，失败 1",
      error: null,
    };
    expect(deriveBangumiMirrorAlerts(status, NOW)[0]).toMatchObject({
      level: "warning",
      code: "discovery_failed",
    });
  });

  test("从未运行的任务按进程启动时间算，刚部署不提示", () => {
    expect(codes((s) => (s.dataset!.maintenance = []))).toEqual([]);
    expect(
      codes((s) => {
        s.dataset!.maintenance = [];
        s.updater!.startedAt = NOW - 2 * DAY;
      })
    ).toEqual(["discovery_stale", "backup_stale"]);
  });

  test("标签增量只在配置后才要求按时运行", () => {
    expect(codes((s) => (s.schedule.tagDiffConfigured = false))).toEqual([]);
    expect(
      codes((s) => {
        s.schedule.tagDiffConfigured = true;
        s.updater!.startedAt = NOW - 2 * DAY;
        s.dataset!.maintenance.push({
          task: "tagDiff",
          finishedAt: NOW - 25 * HOUR,
          ok: true,
          summary: "已是最新版本",
          error: null,
        });
      })
    ).toEqual(["tagDiff_stale"]);
  });

  test("更新器：停止、未启用、卡住与上轮失败分别提示", () => {
    expect(codes((s) => (s.updater!.running = false))).toEqual(["updater_stopped"]);
    expect(codes((s) => (s.updater = null))).toEqual(["updater_disabled"]);
    expect(codes((s) => (s.updater!.lastRound!.at = NOW - 2 * HOUR))).toEqual(["updater_stuck"]);
    expect(codes((s) => (s.updater!.lastRound!.error = "磁盘已满"))).toEqual([
      "updater_round_failed",
    ]);
  });

  test("只读分片不负责更新，不提示更新器与维护任务", () => {
    expect(
      codes((s) => {
        s.role = "reader";
        s.updater = null;
        s.dataset!.maintenance = [];
      })
    ).toEqual([]);
  });

  test("回源降级与数据集不可读都是故障", () => {
    expect(codes((s) => (s.provider.mode = "remote"))).toEqual(["local_degraded"]);
    expect(codes((s) => (s.dataset = null))).toEqual(["dataset_unavailable"]);
  });

  test("搜索：未配置不提示，不可用与数量漂移提示，索引中不判漂移", () => {
    expect(
      codes((s) => {
        s.search = { ...s.search, configured: false, healthy: false };
      })
    ).toEqual([]);
    expect(codes((s) => (s.search.healthy = false))).toEqual(["search_unhealthy"]);
    expect(codes((s) => (s.search.subjects = 1_005))).toEqual([]);
    expect(codes((s) => (s.search.subjects = 900))).toEqual(["search_drift"]);
    expect(
      codes((s) => {
        s.search.subjects = 900;
        s.search.isIndexing = true;
      })
    ).toEqual([]);
  });
});

test("汇总结果符合对外契约，且序列化后不含路径与地址字段", async () => {
  const { provider, ...snapshot } = healthy();
  const monitor = new BangumiMirrorMonitor({
    snapshot: async () => snapshot,
    provider: () => provider,
    now: () => NOW,
  });
  const status = await monitor.status();
  expect(adminBangumiMirrorStatusSchema.parse(status)).toEqual(status);
  expect(status).toMatchObject({ generatedAt: NOW, alerts: [] });
  expect(JSON.stringify(status)).not.toMatch(/https?:|\.sqlite|apiKey/);
});

test("真实数据 Worker 经只读连接给出快照：只读分片没有更新器，也没有计划与搜索", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-mirror-"));
  const dbPath = join(directory, "bangumi.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE subjects(id INTEGER PRIMARY KEY, date TEXT);
    CREATE TABLE characters(id INTEGER PRIMARY KEY);
    INSERT INTO subjects VALUES (1, '2026-01-02');
    INSERT INTO characters VALUES (7), (8);
  `);
  db.close();

  const client = new BangumiDataWorkerClient();
  try {
    await client.init({
      method: "init",
      dataset: { dbPath, readonly: true },
    });
    const snapshot = await client.request({ method: "mirror.status" });
    expect(snapshot).toMatchObject({
      role: "reader",
      dataset: {
        subjects: 1,
        characters: 2,
        refreshed: 0,
        latestSubjectDate: "2026-01-02",
        maintenance: [],
      },
      updater: null,
      schedule: { nextDailyAt: null, tagDiffConfigured: false },
      search: { configured: false, healthy: false },
    });
    expect(JSON.stringify(snapshot)).not.toContain(directory.replaceAll("\\", "\\\\"));
  } finally {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
