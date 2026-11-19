import type { AdminBangumiMirrorStatus } from "@bakagame/shared";

const NOW = Date.UTC(2026, 10, 7, 4);
const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

/** 各项正常：刷新、每日任务与索引都在预期时长内。 */
export const MIRROR_HEALTHY: AdminBangumiMirrorStatus = {
  generatedAt: NOW,
  role: "writer",
  dataset: {
    subjects: 36342,
    characters: 223204,
    refreshed: 36342,
    pendingIndex: 0,
    latestRefreshAt: NOW - 5 * 60_000,
    baselineAt: NOW - 30 * DAY,
    failingSubjects: 13,
    latestSubjectDate: "2026-11-06",
    fileUpdatedAt: NOW - 5 * 60_000,
    maintenance: [
      {
        task: "backup",
        finishedAt: NOW - 2 * HOUR,
        ok: true,
        summary: "快照已更新",
        error: null,
      },
      {
        task: "discovery",
        finishedAt: NOW - 2 * HOUR,
        ok: true,
        summary: "窗口自 2026-10-08，候选 860，入库 42，跳过 818，失败 0",
        error: null,
      },
    ],
  },
  updater: {
    running: true,
    paused: false,
    rate: 14.5,
    players: 2,
    startedAt: NOW - 12 * HOUR,
    lastRound: { at: NOW - 60_000, refreshed: 1, error: null },
  },
  schedule: { nextDailyAt: NOW + 22 * HOUR, tagDiffConfigured: false },
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
    subjects: 36342,
    characters: 223204,
    isIndexing: false,
  },
  alerts: [],
};

/** 超过预期时长没有更新，且最近一次发现失败。 */
export const MIRROR_STALE: AdminBangumiMirrorStatus = {
  ...MIRROR_HEALTHY,
  dataset: {
    ...MIRROR_HEALTHY.dataset!,
    latestRefreshAt: NOW - 3 * DAY,
    pendingIndex: 128,
    maintenance: [
      MIRROR_HEALTHY.dataset!.maintenance[0],
      {
        task: "discovery",
        finishedAt: NOW - 2 * DAY,
        ok: false,
        summary: "新条目发现失败",
        error: "新条目搜索失败：HTTP 503",
      },
      {
        task: "tagDiff",
        finishedAt: NOW - HOUR,
        ok: false,
        summary: "基线不匹配，需要全量重建",
        error: null,
      },
    ],
  },
  schedule: { ...MIRROR_HEALTHY.schedule, tagDiffConfigured: true },
  alerts: [
    { level: "warning", code: "refresh_stale", message: "作品数据已超过 3 天没有成功刷新" },
    {
      level: "error",
      code: "discovery_failed",
      message: "新条目发现最近一次未成功：新条目搜索失败：HTTP 503",
    },
    { level: "warning", code: "discovery_stale", message: "新条目发现已超过 2 天没有运行" },
    {
      level: "warning",
      code: "tagDiff_failed",
      message: "角色标签增量最近一次未成功：基线不匹配，需要全量重建",
    },
  ],
};

/** 本地数据与搜索都不可用，查询已降级到网络回源。 */
export const MIRROR_DEGRADED: AdminBangumiMirrorStatus = {
  ...MIRROR_HEALTHY,
  dataset: null,
  updater: { ...MIRROR_HEALTHY.updater!, running: false },
  provider: {
    mode: "remote",
    retryAt: NOW + 4 * 60_000,
    degradedCount: 3,
    lastDegradedAt: NOW - 60_000,
    lastErrorCode: "BANGUMI_DATA_UNAVAILABLE",
  },
  search: { configured: true, healthy: false, subjects: null, characters: null, isIndexing: false },
  alerts: [
    { level: "error", code: "local_degraded", message: "本地数据不可用，查询正走网络回源" },
    { level: "error", code: "dataset_unavailable", message: "本地数据集读取失败" },
    { level: "error", code: "updater_stopped", message: "更新器已停止" },
    { level: "error", code: "search_unhealthy", message: "搜索索引不可用" },
  ],
};

/** 只读分片：不跑更新器和维护任务，搜索未配置。 */
export const MIRROR_READER: AdminBangumiMirrorStatus = {
  ...MIRROR_HEALTHY,
  role: "reader",
  dataset: { ...MIRROR_HEALTHY.dataset!, latestRefreshAt: null, maintenance: [] },
  updater: null,
  schedule: { nextDailyAt: null, tagDiffConfigured: false },
  search: {
    configured: false,
    healthy: false,
    subjects: null,
    characters: null,
    isIndexing: false,
  },
};
