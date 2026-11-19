import { z } from "zod";

const moment = z.number().nullable();

export const bangumiMaintenanceRunSchema = z.object({
  /** `discovery` 新条目发现、`backup` 数据集备份、`tagDiff` 角色标签增量。 */
  task: z.string(),
  finishedAt: z.number(),
  ok: z.boolean(),
  summary: z.string(),
  /** 已抹掉地址与路径的错误摘要。 */
  error: z.string().nullable(),
});

/**
 * 后台的 Bangumi 镜像状态。只含数量、时刻、结果与错误摘要，不含路径、地址与密钥。
 * `role` 是本进程在数据集上的角色：只读分片不跑更新器与维护任务。
 */
export const adminBangumiMirrorStatusSchema = z.object({
  generatedAt: z.number(),
  role: z.enum(["writer", "reader"]),
  dataset: z
    .object({
      subjects: z.number(),
      characters: z.number(),
      refreshed: z.number(),
      pendingIndex: z.number(),
      latestRefreshAt: moment,
      baselineAt: moment,
      failingSubjects: z.number(),
      latestSubjectDate: z.string().nullable(),
      fileUpdatedAt: moment,
      maintenance: z.array(bangumiMaintenanceRunSchema),
    })
    .nullable(),
  updater: z
    .object({
      running: z.boolean(),
      paused: z.boolean(),
      rate: z.number(),
      players: z.number(),
      startedAt: moment,
      lastRound: z
        .object({ at: z.number(), refreshed: z.number(), error: z.string().nullable() })
        .nullable(),
    })
    .nullable(),
  schedule: z.object({ nextDailyAt: moment, tagDiffConfigured: z.boolean() }),
  provider: z.object({
    mode: z.enum(["local", "remote"]),
    retryAt: moment,
    degradedCount: z.number(),
    lastDegradedAt: moment,
    lastErrorCode: z.string().nullable(),
  }),
  search: z.object({
    configured: z.boolean(),
    healthy: z.boolean(),
    subjects: z.number().nullable(),
    characters: z.number().nullable(),
    isIndexing: z.boolean(),
  }),
  /** 需要处理的问题，判定集中在服务端，客户端只负责展示。 */
  alerts: z.array(
    z.object({ level: z.enum(["error", "warning"]), code: z.string(), message: z.string() })
  ),
});

export type AdminBangumiMirrorStatus = z.infer<typeof adminBangumiMirrorStatusSchema>;

/** 数据 Worker 能给出的部分；回源状态在主线程，告警由主线程汇总后算。 */
export type BangumiMirrorSnapshot = Omit<
  AdminBangumiMirrorStatus,
  "generatedAt" | "provider" | "alerts"
>;
