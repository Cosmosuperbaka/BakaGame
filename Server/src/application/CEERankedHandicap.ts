// ==================== 排位人机强度自动校准 ====================
// 人机按标称分数生成强度，但锚点表与真人的实际水平可能有系统偏差。这里从已计分的真人战绩
// 反推每组人机「实际比标称强多少」；爱噶与普通人格各自一组，用法不同（见服务开局处）：
// 普通人格把偏差从生成强度里扣掉，爱噶有意比同分人机强，偏差加到她计分用的分数上。
import { CEE_RANKED_BOT_RD, expectedCEESeriesScore } from "../domain/CEERankedRating";

export type CEERankedBotGroup = "aiga" | "regular";

/**
 * 每组偏差的先验：样本不足时直接用它，样本够了从它出发按样本量向估计值收缩。
 * 普通人格按锚点表标定，先验为 0。爱噶对同分基线人机的系列赛胜率标定在七成五左右
 * （标定脚本「爱噶对齐」一节），按人机偏差下的系列赛期望得分折算，约比标称强 190 分。
 */
export const CEE_RANKED_BOT_BIAS_PRIOR: Readonly<Record<CEERankedBotGroup, number>> = {
  regular: 0,
  aiga: 190,
};

export interface CEERankedBotSample {
  group: CEERankedBotGroup;
  /** 赛前真人 μ */
  playerRating: number;
  /** 赛前真人 φ */
  playerRd: number;
  /** 人机按哪个分数生成的强度 */
  strengthRating: number;
  /** 真人得分 */
  score: 0 | 0.5 | 1;
}

/** δ 的搜索区间：超过它说明样本本身不自洽，夹到边界即可。 */
const BIAS_MIN = -600;
const BIAS_MAX = 600;
const BIAS_ITERATIONS = 60;

/**
 * 估计人机实际强度与标称强度的系统偏差 δ（人机真实强度 ≈ strengthRating + δ）。
 *
 * 用二分求 `Σ 真人得分 = Σ 该偏差下的期望得分`：期望得分对 δ 单调递减，所以解唯一。
 */
export function estimateCEERankedBotBias(samples: readonly CEERankedBotSample[]): number {
  if (samples.length === 0) return 0;
  let scored = 0;
  for (const sample of samples) scored += sample.score;
  const gap = (delta: number): number => {
    let expected = 0;
    for (const sample of samples) {
      expected += expectedCEESeriesScore(
        { rating: sample.playerRating, rd: sample.playerRd },
        { rating: sample.strengthRating + delta, rd: CEE_RANKED_BOT_RD }
      );
    }
    return expected - scored;
  };
  if (gap(BIAS_MIN) <= 0) return BIAS_MIN;
  if (gap(BIAS_MAX) >= 0) return BIAS_MAX;
  let low = BIAS_MIN;
  let high = BIAS_MAX;
  for (let step = 0; step < BIAS_ITERATIONS; step += 1) {
    const middle = (low + high) / 2;
    if (gap(middle) > 0) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

const DEFAULT_WINDOW = 300;
const DEFAULT_MIN_SAMPLES = 30;
const DEFAULT_LIMIT = 400;
/** 样本收缩的分母常数：n 条样本按 n/(n+50) 打折，刚够起步时不急着甩开手脚。 */
const SHRINKAGE = 50;

export interface CEERankedHandicapOptions {
  window?: number;
  minSamples?: number;
  limit?: number;
}

/** 每组人机各留最近若干条样本，随时给出当前应施加的偏差。 */
export class CEERankedHandicap {
  private readonly window: number;
  private readonly minSamples: number;
  private readonly limit: number;
  private readonly samples: Record<CEERankedBotGroup, CEERankedBotSample[]> = {
    aiga: [],
    regular: [],
  };

  constructor(options: CEERankedHandicapOptions = {}) {
    this.window = Math.max(1, options.window ?? DEFAULT_WINDOW);
    this.minSamples = Math.max(1, options.minSamples ?? DEFAULT_MIN_SAMPLES);
    this.limit = Math.max(0, options.limit ?? DEFAULT_LIMIT);
  }

  /** 启动时用历史填充；入参按结束时间倒序，与存储端口的列举顺序一致。 */
  seed(samples: readonly CEERankedBotSample[]): void {
    for (const sample of [...samples].reverse()) this.remember(sample);
  }

  add(sample: CEERankedBotSample): void {
    this.remember(sample);
  }

  /** 当前应施加的偏差：样本不足为该组先验；否则从先验向估计值按样本量收缩，夹到 ±limit。 */
  bias(group: CEERankedBotGroup): number {
    const list = this.samples[group];
    const prior = CEE_RANKED_BOT_BIAS_PRIOR[group];
    if (list.length < this.minSamples) return prior;
    const estimate = estimateCEERankedBotBias(list);
    const shrunk = prior + ((estimate - prior) * list.length) / (list.length + SHRINKAGE);
    return Math.min(this.limit, Math.max(-this.limit, shrunk));
  }

  /** 每组各自的样本数，供日志与测试观察。 */
  count(group: CEERankedBotGroup): number {
    return this.samples[group].length;
  }

  private remember(sample: CEERankedBotSample): void {
    const list = this.samples[sample.group];
    list.push(sample);
    if (list.length > this.window) list.splice(0, list.length - this.window);
  }
}
