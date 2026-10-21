/**
 * 猜歌计分（三级模型）。
 *
 * 旧口径（答题者固定 1 分、出题人按「猜中人数 × 3」加成）方向是反的：答对的人越多，
 * 出题人收益越高，等于奖励「出简单题」。新模型把「这轮题有多难」显式算成难度分 D，
 * 出题人只按 D 拿钱，于是「人人都会」的轮次出题人几乎拿不到分。
 *
 * 公式与常量只写在这一处：服务端结算与前端展示读同一份，避免两端各算一套。
 */

/** 计分口径版本。1 = 旧口径，2 = 三因子模型。只影响新对局，不改历史 `game_record`。 */
export const SONG_SCORING_VERSION: 1 | 2 = 2;

export const SONG_SCORE = {
  /** 答题者基准分：满分（速度 1.2 × 精度 1）即 12 分。 */
  base: 10,
  /** 出题人得分占「平均答题者得分」的比例；难度分 D 继续作折扣，避免奖励简单题。 */
  submitterRatio: 1,
  /** 难度分低于此值视为「这题根本不成立」，出题人扣分。 */
  lowDifficultyThreshold: 0.2,
  /** 普通模式速度系数：用时占比 0 取 `fast`，占比 1 取 `slow`，区间外夹紧。 */
  speedFast: 1.2,
  speedSlow: 0.4,
  /** 精度系数下限：猜满次数也只降到一半，不至于归零。 */
  minPrecision: 0.5,
  /** 难度分三项权重，和为 1。 */
  difficultyAccuracyWeight: 0.5,
  difficultyAttemptsWeight: 0.3,
  difficultySpeedWeight: 0.2,
  /** 无人猜中时出题人的硬扣分。 */
  nobodyCorrect: -2,
  /** 旧口径常量，`SONG_SCORING_VERSION === 1` 时使用。 */
  legacyCorrect: 1,
  legacySubmitterPerCorrect: 3,
  legacySubmitterNobodyCorrect: 2,
} as const;

const clamp = (min: number, max: number, value: number): number =>
  Math.min(max, Math.max(min, value));

export interface SongDifficultyInput {
  /** 可作答单元数：出题人、观战队友、人机都不计入分母。 */
  answerableCount: number;
  /** 猜中的单元数。 */
  correctCount: number;
  /** 可作答单元消耗的猜测次数总和。 */
  totalAttempts: number;
  /** 每个猜中者的用时占比（用时 ÷ 时限），已夹到 0–1。 */
  correctElapsedRatios: number[];
  maxGuessesPerRound: number;
}

/**
 * 难度分 D：0（毫无难度）到 1（无人能解）。
 * 猜中的人越多、试得越少、解得越快，D 越低，出题人拿得越少。
 */
export function computeSongDifficulty(input: SongDifficultyInput): number {
  const { answerableCount, correctCount, totalAttempts, correctElapsedRatios, maxGuessesPerRound } =
    input;
  const correctRate = answerableCount > 0 ? correctCount / answerableCount : 0;
  const averageAttempts = answerableCount > 0 ? totalAttempts / answerableCount : 0;
  const averageElapsedRatio = correctElapsedRatios.length
    ? correctElapsedRatios.reduce((sum, value) => sum + value, 0) / correctElapsedRatios.length
    : 1;
  return (
    SONG_SCORE.difficultyAccuracyWeight * (1 - correctRate) +
    SONG_SCORE.difficultyAttemptsWeight *
      Math.min(1, maxGuessesPerRound > 0 ? averageAttempts / maxGuessesPerRound : 0) +
    SONG_SCORE.difficultySpeedWeight * (1 - averageElapsedRatio)
  );
}

export interface SongAnswererInput {
  bloodMode: boolean;
  /** 血战排名，1 起。普通模式忽略。 */
  rank: number;
  /** 可作答单元数，血战按排名比例给速，必须与难度分同分母。 */
  answerableCount: number;
  /** 本人用时占比（用时 ÷ 时限），已夹到 0–1。 */
  elapsedRatio: number;
  guessesUsed: number;
  maxGuessesPerRound: number;
}

/**
 * 答题者得分的三项拆解：`round(10 × speed × precision)`。结算摘要与前端明细都读这份，
 * 免得展示端自己再算一遍速度、精度两个系数。
 */
export function computeSongAnswererFactors(input: SongAnswererInput): {
  speed: number;
  precision: number;
  score: number;
} {
  const speed = input.bloodMode
    ? input.answerableCount > 0
      ? (input.answerableCount - input.rank + 1) / input.answerableCount
      : 0
    : clamp(
        SONG_SCORE.speedSlow,
        SONG_SCORE.speedFast,
        SONG_SCORE.speedFast - (SONG_SCORE.speedFast - SONG_SCORE.speedSlow) * input.elapsedRatio
      );
  const precision = Math.max(
    SONG_SCORE.minPrecision,
    input.maxGuessesPerRound > 0
      ? (input.maxGuessesPerRound - input.guessesUsed + 1) / input.maxGuessesPerRound
      : SONG_SCORE.minPrecision
  );
  return { speed, precision, score: Math.round(SONG_SCORE.base * speed * precision) };
}

/**
 * 答题者得分：`round(10 × 速度系数 × 精度系数)`。
 *
 * 普通模式的速度系数看「解得快不快」，血战看「排第几」——血战是抢答，排名本身就是速度。
 */
export const computeSongAnswererScore = (input: SongAnswererInput): number =>
  computeSongAnswererFactors(input).score;

export interface SongSubmitterInput {
  answerableCount: number;
  correctCount: number;
  /** 本轮实际发出的答题者得分均值，无人猜中时为 0。 */
  averageAnswererScore: number;
  difficulty: number;
}

/**
 * 出题人得分：`round(平均答题者得分 × 1.0 × D)`。
 *
 * 难度分 D 就是折扣：同样答得好，题越简单出题人拿得越少；也不再把「答对人数 × 3」
 * 当作奖励（那是奖励出简单题）。硬边界依次生效：无人猜中 → -2（题废了）；难度分过低 →
 * -1（太简单）；其余不小于 0。
 */
export function computeSongSubmitterScore(input: SongSubmitterInput): number {
  if (input.correctCount === 0) return SONG_SCORE.nobodyCorrect;
  if (input.difficulty < SONG_SCORE.lowDifficultyThreshold) return -1;
  return Math.max(
    0,
    Math.round(input.averageAnswererScore * SONG_SCORE.submitterRatio * input.difficulty)
  );
}