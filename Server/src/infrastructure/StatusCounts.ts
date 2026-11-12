import type { PublicStatusLevel } from "../shared/Status";

/**
 * 状态账本的计数口径：日格账本与实时样本账本只有「格子键」不同（日期字符串 / 采样起点毫秒），
 * 计数、可用率与延迟的算法同出一处，改口径不会只改一半。
 */
export interface StatusCount {
  total: number;
  operational: number;
  degraded: number;
  unknown: number;
  latencySum: number;
  latencyCount: number;
}

export const emptyCount = (): StatusCount => ({
  total: 0,
  operational: 0,
  degraded: 0,
  unknown: 0,
  latencySum: 0,
  latencyCount: 0,
});

/** 记一笔样本：等级进计数，带有效延迟读数的顺带累计延迟（没有读数的不冒充 0ms）。 */
export const addSample = (
  count: StatusCount,
  level: PublicStatusLevel,
  latencyMs: number | null
): void => {
  count.total += 1;
  count[level] += 1;
  if (latencyMs !== null && latencyMs >= 0) {
    count.latencySum += latencyMs;
    count.latencyCount += 1;
  }
};

export const sumCounts = (left: StatusCount, right: StatusCount): StatusCount => ({
  total: left.total + right.total,
  operational: left.operational + right.operational,
  degraded: left.degraded + right.degraded,
  unknown: left.unknown + right.unknown,
  latencySum: left.latencySum + right.latencySum,
  latencyCount: left.latencyCount + right.latencyCount,
});

/**
 * 可用率的分母只算有结论的样本（operational + degraded）：unknown 只表示「没有结论」
 * （未接入监测或监测本身取不到），不进分母——既不把「没接入」压成 0%，也不抬高真故障。
 * 窗口可用率从原始计数累加，不从四舍五入后的格子比例反推。
 */
export const ratioOf = (counts: Iterable<StatusCount>): number | null => {
  let operational = 0;
  let degraded = 0;
  for (const count of counts) {
    operational += count.operational;
    degraded += count.degraded;
  }
  const decided = operational + degraded;
  return decided > 0 ? operational / decided : null;
};

/** 按样本加权的平均延迟（Σ 和值 / Σ 个数）：样本多的格子权重大；没有延迟样本时为 null。 */
export const latencyOf = (counts: Iterable<StatusCount>): number | null => {
  let sum = 0;
  let samples = 0;
  for (const count of counts) {
    sum += count.latencySum;
    samples += count.latencyCount;
  }
  return samples > 0 ? Math.round(sum / samples) : null;
};

export interface CellFigures {
  total: number;
  ratio: number | null;
  level: PublicStatusLevel;
  latencyMs: number | null;
}

/** 一个格子的对外读数：有降级即降级，否则有正常即正常，其余（含无样本）读作未知。 */
export const cellFigures = (count: StatusCount): CellFigures => ({
  total: count.total,
  ratio: ratioOf([count]),
  level:
    count.total === 0
      ? "unknown"
      : count.degraded > 0
        ? "degraded"
        : count.operational > 0
          ? "operational"
          : "unknown",
  latencyMs: latencyOf([count]),
});
