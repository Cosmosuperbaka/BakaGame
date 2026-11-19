import type { Database } from "bun:sqlite";

/** 维护任务最近一次的结果，给后台状态页读。 */
export interface MaintenanceRun {
  task: string;
  finishedAt: number;
  ok: boolean;
  summary: string;
  error: string | null;
}

export interface BangumiDatasetStatus {
  subjects: number;
  characters: number;
  /** 已登记刷新状态的作品数。 */
  refreshed: number;
  pendingIndex: number;
  /** 最近一次真实回源刷新成功的时刻；基线登记（tier = -1）不算。 */
  latestRefreshAt: number | null;
  /** 基线登记的时刻：还没有真实刷新时，超期从这里算。 */
  baselineAt: number | null;
  failingSubjects: number;
  /** 已开播或已发售作品里最新的日期，未来排期不算：用来看数据新到什么时候。 */
  latestSubjectDate: string | null;
  maintenance: MaintenanceRun[];
}

const hasTable = (db: Database, name: string): boolean =>
  Boolean(
    db
      .query<{ found: number }, [string]>(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get(name)
  );

const countRows = (db: Database, table: string): number =>
  hasTable(db, table)
    ? Number(db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0)
    : 0;

const readFreshness = (db: Database) => {
  if (!hasTable(db, "bangumi_refresh")) return { latest: null, baseline: null, failing: 0 };
  const row = db
    .query<{ latest: number | null; baseline: number | null; failing: number | null }, []>(
      "SELECT max(CASE WHEN failures = 0 AND tier >= 0 THEN refreshed_at END) AS latest," +
        " max(CASE WHEN tier < 0 THEN refreshed_at END) AS baseline," +
        " sum(failures > 0) AS failing FROM bangumi_refresh"
    )
    .get();
  return {
    latest: row?.latest ?? null,
    baseline: row?.baseline ?? null,
    failing: Number(row?.failing ?? 0),
  };
};

const readMaintenanceRuns = (db: Database): MaintenanceRun[] => {
  if (!hasTable(db, "bangumi_maintenance_runs")) return [];
  return db
    .query<
      { task: string; finished_at: number; ok: number; summary: string; error: string | null },
      []
    >("SELECT task, finished_at, ok, summary, error FROM bangumi_maintenance_runs ORDER BY task")
    .all()
    .map((row) => ({
      task: row.task,
      finishedAt: Number(row.finished_at),
      ok: Boolean(row.ok),
      summary: row.summary,
      error: row.error,
    }));
};

/**
 * 读数据集的状态量。状态表由更新器创建，只读分片或未启用更新器的环境可能没有，
 * 这里按「尚无记录」处理，不让状态页因此报错。
 */
export function readDatasetStatus(db: Database, now: number): BangumiDatasetStatus {
  const today = new Date(now).toISOString().slice(0, 10);
  const newest = db
    .query<{ latest: string | null }, [string]>(
      "SELECT max(date) AS latest FROM subjects WHERE date <> '' AND date <= ?"
    )
    .get(today);
  const freshness = readFreshness(db);
  return {
    subjects: countRows(db, "subjects"),
    characters: countRows(db, "characters"),
    refreshed: countRows(db, "bangumi_refresh"),
    pendingIndex: countRows(db, "bangumi_index_pending"),
    latestRefreshAt: freshness.latest,
    baselineAt: freshness.baseline,
    failingSubjects: freshness.failing,
    latestSubjectDate: newest?.latest ?? null,
    maintenance: readMaintenanceRuns(db),
  };
}
