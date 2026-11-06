import type { BangumiProviderStatus } from "../infrastructure/FallbackBangumiProvider";
import type { AdminBangumiMirrorStatus, BangumiMirrorSnapshot } from "../shared/BangumiMirror";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
/** 热层两天一轮：超过这个时长没有任何成功刷新，说明循环或上游出了问题。 */
const REFRESH_STALE_MS = 2 * DAY_MS;
/** 一轮最多千条且有限速，算上轮间隔也到不了一小时；再久就是卡住了。 */
const ROUND_STALE_MS = HOUR_MS;
/** 每日任务一天一次，留半天余量给部署重启错过窗口的情况。 */
const DAILY_STALE_MS = 36 * HOUR_MS;
/** 标签增量六小时一轮，一整天没跑就是断了。 */
const TAG_DIFF_STALE_MS = DAY_MS;
/** 索引与数据集的容差：新条目入库后索引异步写入，少量差异不值得打扰。 */
const SEARCH_DRIFT_RATIO = 0.01;

const MAINTENANCE_TASKS = [
  { task: "discovery", label: "新条目发现", staleMs: DAILY_STALE_MS },
  { task: "backup", label: "数据集备份", staleMs: DAILY_STALE_MS },
  { task: "tagDiff", label: "角色标签增量", staleMs: TAG_DIFF_STALE_MS },
] as const;

type Alert = AdminBangumiMirrorStatus["alerts"][number];
export type BangumiMirrorAlertInput = Omit<AdminBangumiMirrorStatus, "generatedAt" | "alerts">;

const formatAge = (elapsed: number): string =>
  elapsed >= DAY_MS
    ? `${Math.floor(elapsed / DAY_MS)} 天`
    : `${Math.floor(elapsed / HOUR_MS)} 小时`;

const datasetAlerts = ({ dataset }: BangumiMirrorAlertInput, now: number): Alert[] => {
  if (!dataset) {
    return [{ level: "error", code: "dataset_unavailable", message: "本地数据集读取失败" }];
  }
  // 还没有真实刷新时从基线登记算起：刚换库的前两天不算超期。
  const reference = dataset.latestRefreshAt ?? dataset.baselineAt;
  if (reference === null || now - reference <= REFRESH_STALE_MS) return [];
  return [
    {
      level: "warning",
      code: "refresh_stale",
      message: `作品数据已超过 ${formatAge(now - reference)} 没有成功刷新`,
    },
  ];
};

const updaterAlerts = ({ role, updater }: BangumiMirrorAlertInput, now: number): Alert[] => {
  if (role === "reader") return [];
  if (!updater) {
    return [{ level: "warning", code: "updater_disabled", message: "更新器未启用，作品数据不会自动更新" }];
  }
  if (!updater.running) {
    return [{ level: "error", code: "updater_stopped", message: "更新器已停止" }];
  }
  const alerts: Alert[] = [];
  if (updater.lastRound?.error) {
    alerts.push({
      level: "warning",
      code: "updater_round_failed",
      message: `最近一轮作品刷新失败：${updater.lastRound.error}`,
    });
  }
  const heartbeat = updater.lastRound?.at ?? updater.startedAt;
  if (heartbeat !== null && now - heartbeat > ROUND_STALE_MS) {
    alerts.push({
      level: "error",
      code: "updater_stuck",
      message: `更新器已超过 ${formatAge(now - heartbeat)} 没有完成一轮`,
    });
  }
  return alerts;
};

const maintenanceAlerts = (status: BangumiMirrorAlertInput, now: number): Alert[] => {
  if (status.role === "reader" || !status.dataset) return [];
  const runs = status.dataset.maintenance;
  const expected = MAINTENANCE_TASKS.filter(
    ({ task }) => task !== "tagDiff" || status.schedule.tagDiffConfigured
  );
  return expected.flatMap(({ task, label, staleMs }) => {
    const run = runs.find((item) => item.task === task);
    const alerts: Alert[] = [];
    if (run && !run.ok) {
      alerts.push({
        // 没有错误摘要说明任务跑完了只是部分条目失败，不算故障。
        level: run.error ? "error" : "warning",
        code: `${task}_failed`,
        message: `${label}最近一次未成功：${run.error ?? run.summary}`,
      });
    }
    // 没有记录时从进程启动算起：刚部署、每日任务还没轮到不算超期。
    const reference = run?.finishedAt ?? status.updater?.startedAt ?? null;
    if (reference !== null && now - reference > staleMs) {
      alerts.push({
        level: "warning",
        code: `${task}_stale`,
        message: `${label}已超过 ${formatAge(now - reference)} 没有运行`,
      });
    }
    return alerts;
  });
};

const hasDrifted = (indexed: number | null, stored: number, pending: number): boolean =>
  indexed !== null &&
  Math.abs(indexed - stored) > Math.max(pending, stored * SEARCH_DRIFT_RATIO);

const searchAlerts = ({ search, dataset }: BangumiMirrorAlertInput): Alert[] => {
  if (!search.configured) return [];
  if (!search.healthy) {
    return [{ level: "error", code: "search_unhealthy", message: "搜索索引不可用" }];
  }
  if (!dataset || search.isIndexing) return [];
  const drifted =
    hasDrifted(search.subjects, dataset.subjects, dataset.pendingIndex) ||
    hasDrifted(search.characters, dataset.characters, 0);
  if (!drifted) return [];
  return [
    {
      level: "warning",
      code: "search_drift",
      message: `搜索索引与数据集数量不一致：作品 ${search.subjects} / ${dataset.subjects}，角色 ${search.characters} / ${dataset.characters}`,
    },
  ];
};

/** 判定集中在这里：客户端只展示，超期口径改动不用发两端。 */
export function deriveBangumiMirrorAlerts(status: BangumiMirrorAlertInput, now: number): Alert[] {
  const degraded: Alert[] =
    status.provider.mode === "remote"
      ? [{ level: "error", code: "local_degraded", message: "本地数据不可用，查询正走网络回源" }]
      : [];
  return [
    ...degraded,
    ...datasetAlerts(status, now),
    ...updaterAlerts(status, now),
    ...maintenanceAlerts(status, now),
    ...searchAlerts(status),
  ];
}

export interface BangumiMirrorMonitorOptions {
  snapshot: () => Promise<BangumiMirrorSnapshot>;
  provider: () => BangumiProviderStatus;
  now?: () => number;
}

/** 汇总数据 Worker 的快照与主线程的回源状态，算出后台要看的结论。 */
export class BangumiMirrorMonitor {
  private readonly now: () => number;

  constructor(private readonly options: BangumiMirrorMonitorOptions) {
    this.now = options.now ?? Date.now;
  }

  async status(): Promise<AdminBangumiMirrorStatus> {
    const input = { ...(await this.options.snapshot()), provider: this.options.provider() };
    const generatedAt = this.now();
    return { ...input, generatedAt, alerts: deriveBangumiMirrorAlerts(input, generatedAt) };
  }
}
