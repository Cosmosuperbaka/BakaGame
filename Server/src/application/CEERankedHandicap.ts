// ==================== 排位人机强度自动校准 ====================
// 人机的强度分来自模拟标定的实战分，但模拟里的基线人机与真人的实际水平可能有系统偏差。这里从
// 已计分的真人战绩反推每组人机「实际比强度分强多少」（δ）；爱噶与普通人格各自一组，用法相同：
// 开局按「标称分减 δ」找强度，计分按「强度分加 δ」算（见 planCEERankedBot）。
//
// 只收已定级、偏差不大的真人样本：定级中的分数还没收敛，它们的输赢主要在修正玩家自己的分数，
// 再拿来推人机会重复计算。单个账号在窗口里的权重有上限，免得一两个人决定所有人碰到的人机。
import { CEE_RANKED_BOT_RD, expectedCEESeriesScore } from "../domain/CEERankedRating";

export type CEERankedBotGroup = "aiga" | "regular";

/**
 * 每组偏差的先验：样本不足时直接用它，样本够了从它出发按样本量向估计值收缩。强度分本身已按
 * 模拟里的实战分标定（爱噶也一样），两组先验都为 0。
 */
export const CEE_RANKED_BOT_BIAS_PRIOR: Readonly<Record<CEERankedBotGroup, number>> = {
  regular: 0,
  aiga: 0,
};

/** 真人偏差超过它的样本不进窗口：定级中或久未对局，分数还不可信。 */
export const CEE_RANKED_HANDICAP_MAX_PLAYER_RD = 150;
/** 单个账号在窗口里的权重最多占这么大比例，超出的按比例打折。 */
export const CEE_RANKED_HANDICAP_ACCOUNT_SHARE = 0.2;

export interface CEERankedBotSample {
  group: CEERankedBotGroup;
  /** 真人账号，用于限制单个账号的权重。 */
  userId: string;
  /** 赛前是否还在定级。 */
  placement: boolean;
  /** 赛前真人 μ */
  playerRating: number;
  /** 赛前真人 φ */
  playerRd: number;
  /** 人机的强度分（模型给出的实战分） */
  strengthRating: number;
  /** 真人得分 */
  score: 0 | 0.5 | 1;
}

/** 样本能不能进校准窗口：定级中或真人偏差过大的不收。 */
export const ceeRankedHandicapAccepts = (sample: CEERankedBotSample): boolean =>
  !sample.placement && sample.playerRd <= CEE_RANKED_HANDICAP_MAX_PLAYER_RD;

/**
 * 每条样本的权重：一个账号的样本合计最多占 `CEE_RANKED_HANDICAP_ACCOUNT_SHARE`（至少一条的份量），
 * 超出的按比例打折。只有一个账号时它的样本也照样打折，实际样本量随之变小、收缩更保守。
 */
export function ceeRankedHandicapWeights(samples: readonly CEERankedBotSample[]): number[] {
  const counts = new Map<string, number>();
  for (const sample of samples) counts.set(sample.userId, (counts.get(sample.userId) ?? 0) + 1);
  const cap = Math.max(1, CEE_RANKED_HANDICAP_ACCOUNT_SHARE * samples.length);
  return samples.map((sample) => Math.min(1, cap / (counts.get(sample.userId) ?? 1)));
}

/** δ 的搜索区间：超过它说明样本本身不自洽，夹到边界即可。 */
const BIAS_MIN = -600;
const BIAS_MAX = 600;
const BIAS_ITERATIONS = 60;

/**
 * 估计人机实际强度与强度分的系统偏差 δ（人机真实强度 ≈ strengthRating + δ）。
 *
 * 用二分求 `Σ 权重 × 真人得分 = Σ 权重 × 该偏差下的期望得分`：期望得分对 δ 单调递减，所以解唯一。
 * 不给权重时每条样本等权。
 */
export function estimateCEERankedBotBias(
  samples: readonly CEERankedBotSample[],
  weights: readonly number[] = samples.map(() => 1)
): number {
  if (samples.length === 0) return 0;
  let scored = 0;
  samples.forEach((sample, index) => {
    scored += weights[index] * sample.score;
  });
  const gap = (delta: number): number => {
    let expected = 0;
    samples.forEach((sample, index) => {
      expected +=
        weights[index] *
        expectedCEESeriesScore(
          { rating: sample.playerRating, rd: sample.playerRd },
          { rating: sample.strengthRating + delta, rd: CEE_RANKED_BOT_RD }
        );
    });
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
/** 样本收缩的分母常数：有效样本量 n 按 n/(n+50) 打折，刚够起步时不急着甩开手脚。 */
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
  /** 本进程累计收下的样本数（不随窗口滚动封顶），日志按它判断「每满若干条」。 */
  private readonly accepted: Record<CEERankedBotGroup, number> = { aiga: 0, regular: 0 };

  constructor(options: CEERankedHandicapOptions = {}) {
    this.window = Math.max(1, options.window ?? DEFAULT_WINDOW);
    this.minSamples = Math.max(1, options.minSamples ?? DEFAULT_MIN_SAMPLES);
    this.limit = Math.max(0, options.limit ?? DEFAULT_LIMIT);
  }

  /** 启动时用历史填充；入参按结束时间倒序，与存储端口的列举顺序一致。不计入累计数。 */
  seed(samples: readonly CEERankedBotSample[]): void {
    for (const sample of [...samples].reverse()) this.remember(sample);
  }

  /** 收一条新样本；定级中或真人偏差过大的不收，返回是否收下。 */
  add(sample: CEERankedBotSample): boolean {
    if (!this.remember(sample)) return false;
    this.accepted[sample.group] += 1;
    return true;
  }

  /**
   * 当前应施加的偏差：样本不足为该组先验；否则从先验向估计值按有效样本量（权重和）收缩，
   * 夹到 ±limit。
   */
  bias(group: CEERankedBotGroup): number {
    const list = this.samples[group];
    const prior = CEE_RANKED_BOT_BIAS_PRIOR[group];
    if (list.length < this.minSamples) return prior;
    const weights = ceeRankedHandicapWeights(list);
    const effective = weights.reduce((sum, weight) => sum + weight, 0);
    const estimate = estimateCEERankedBotBias(list, weights);
    const shrunk = prior + ((estimate - prior) * effective) / (effective + SHRINKAGE);
    return Math.min(this.limit, Math.max(-this.limit, shrunk));
  }

  /** 每组窗口里的样本数，供测试观察。 */
  count(group: CEERankedBotGroup): number {
    return this.samples[group].length;
  }

  /** 每组本进程累计收下的样本数，供日志判断节奏。 */
  total(group: CEERankedBotGroup): number {
    return this.accepted[group];
  }

  private remember(sample: CEERankedBotSample): boolean {
    if (!ceeRankedHandicapAccepts(sample)) return false;
    const list = this.samples[sample.group];
    list.push(sample);
    if (list.length > this.window) list.splice(0, list.length - this.window);
    return true;
  }
}
