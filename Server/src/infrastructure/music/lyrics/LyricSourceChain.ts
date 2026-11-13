import { describeError, type EventLogger } from "../../EventLogger";
import type { SongLyricLine } from "../../../shared/Index";

export interface LyricTierOutcome {
  lines: SongLyricLine[];
  /** 本级没取到（瞬态失败，已由来源自己记过日志）；与「确实没有」不同。 */
  failed?: boolean;
  /** 本级命中了原文：即便清洗后为空也不再降级到下一级。 */
  settled?: boolean;
}

export interface LyricTier {
  run: () => Promise<LyricTierOutcome> | LyricTierOutcome;
  /** 本级抛错时的告警：错误只记告警、当作没命中，继续下一级。 */
  onError: { message: string; context: Record<string, unknown> };
}

export interface LyricChainResult {
  lines: SongLyricLine[];
  /**
   * 比应有的结果差：排在命中者之前的来源没取到（或根本没有命中者且有来源没取到）。
   * 调用方据此不把这份结果当作完整结果缓存，下次重新回源。
   */
  degraded: boolean;
}

/**
 * 按优先级逐级取歌词，命中即停：逐级短路是硬约束——外部服务只在前一级没命中时才发请求。
 * 两个平台的级数与各级的采纳条件不同，由调用方组装；骨架（顺序、短路、错误降级、
 * 降级标记）只此一份。
 */
export const resolveLyricChain = async (
  tiers: readonly LyricTier[],
  logger?: EventLogger
): Promise<LyricChainResult> => {
  let degraded = false;
  for (const tier of tiers) {
    let outcome: LyricTierOutcome;
    try {
      outcome = await tier.run();
    } catch (error) {
      logger?.warn?.(tier.onError.message, { ...tier.onError.context, ...describeError(error) });
      degraded = true;
      continue;
    }
    if (outcome.failed) degraded = true;
    if (outcome.lines.length > 0 || outcome.settled) return { lines: outcome.lines, degraded };
  }
  return { lines: [], degraded };
};
