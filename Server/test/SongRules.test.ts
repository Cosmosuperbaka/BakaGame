import { expect, test } from "bun:test";
import {
  computeSongAnswererFactors,
  computeSongAnswererScore,
  computeSongDifficulty,
  computeSongSubmitterScore,
  SONG_SCORE,
} from "../src/domain/SongRules";

const MAX_GUESSES = 3;

/** 一个答题者的得分，参数都按「可作答单元的实际情况」给。 */
const answerer = (options: {
  bloodMode?: boolean;
  rank?: number;
  answerableCount: number;
  elapsedRatio: number;
  guessesUsed: number;
}) =>
  computeSongAnswererScore({
    bloodMode: options.bloodMode ?? false,
    rank: options.rank ?? 1,
    answerableCount: options.answerableCount,
    elapsedRatio: options.elapsedRatio,
    guessesUsed: options.guessesUsed,
    maxGuessesPerRound: MAX_GUESSES,
  });

/** 一轮的难度分与出题人得分，`attemptsPerAnswerer` 是每个可作答单元的尝试次数。 */
const submitter = (options: {
  answerableCount: number;
  correctCount: number;
  attemptsPerAnswerer: number;
  elapsedRatio: number;
  averageAnswererScore: number;
}) => {
  const difficulty = computeSongDifficulty({
    answerableCount: options.answerableCount,
    correctCount: options.correctCount,
    totalAttempts: options.attemptsPerAnswerer * options.answerableCount,
    correctElapsedRatios: Array.from({ length: options.correctCount }, () => options.elapsedRatio),
    maxGuessesPerRound: MAX_GUESSES,
  });
  return {
    difficulty,
    score: computeSongSubmitterScore({
      answerableCount: options.answerableCount,
      correctCount: options.correctCount,
      averageAnswererScore: options.averageAnswererScore,
      difficulty,
    }),
  };
};

test("答题者：普通模式 1 次猜中、用了 5% 时限 → 12 分", () => {
  expect(answerer({ answerableCount: 1, elapsedRatio: 0.05, guessesUsed: 1 })).toBe(12);
  expect(
    computeSongAnswererFactors({
      bloodMode: false,
      rank: 1,
      answerableCount: 1,
      elapsedRatio: 0.05,
      guessesUsed: 1,
      maxGuessesPerRound: MAX_GUESSES,
    })
  ).toEqual({ speed: 1.16, precision: 1, score: 12 });
});

test("答题者：普通模式速度系数夹在 0.4–1.2，精度系数下限 0.5", () => {
  // 用时占比超过时限：速度取到下限 0.4，精度按猜满次数取到 0.5 → round(10×0.4×0.5)=2
  expect(answerer({ answerableCount: 1, elapsedRatio: 3, guessesUsed: MAX_GUESSES })).toBe(2);
  // 来不及猜（占比 0）也不越过 1.2
  expect(
    computeSongAnswererFactors({
      bloodMode: false,
      rank: 1,
      answerableCount: 1,
      elapsedRatio: 0,
      guessesUsed: 1,
      maxGuessesPerRound: MAX_GUESSES,
    }).speed
  ).toBe(SONG_SCORE.speedFast);
});

test("答题者：血战按抢答排名递减，最后一名最低但为正", () => {
  const scores = [1, 2, 3].map((rank) =>
    answerer({ bloodMode: true, rank, answerableCount: 3, elapsedRatio: 0, guessesUsed: 1 })
  );
  expect(scores).toEqual([10, 7, 3]);
  expect(scores[0]).toBeGreaterThan(scores[1]);
  expect(scores[1]).toBeGreaterThan(scores[2]);
  expect(scores[2]).toBeGreaterThan(0);
});

test("答题者：无人猜中时没有得分（缺省 0）", () => {
  // 没有任何单元猜中 → 结算不会给谁记分；这里断言「没猜中就不该调计分」的默认值语义
  expect(
    submitter({
      answerableCount: 3,
      correctCount: 0,
      attemptsPerAnswerer: 3,
      elapsedRatio: 1,
      averageAnswererScore: 0,
    }).score
  ).toBe(SONG_SCORE.nobodyCorrect);
});

test("出题人：1 人 1 次猜中、耗时 5% → 拿到约四分之一的答题分", () => {
  const { difficulty, score } = submitter({
    answerableCount: 1,
    correctCount: 1,
    attemptsPerAnswerer: 1,
    elapsedRatio: 0.05,
    averageAnswererScore: 12,
  });
  expect(difficulty).toBeCloseTo(0.29, 5);
  // 12 × 1.0 × 0.29 = 3.48 → 3；旧口径的 0.3 比例只给 1 分。
  expect(score).toBe(3);
});

test("出题人：5 人全在 2 次内猜中仍远低于旧口径的 15", () => {
  // 旧口径（已删）：5 个猜中 × 3 = 15；新口径按难度折扣只给个位数。
  const legacy = 15;
  expect(legacy).toBe(15);
  const half = submitter({
    answerableCount: 5,
    correctCount: 5,
    attemptsPerAnswerer: 2,
    elapsedRatio: 0.5,
    averageAnswererScore: answerer({ answerableCount: 5, elapsedRatio: 0.5, guessesUsed: 2 }),
  });
  const full = submitter({
    answerableCount: 5,
    correctCount: 5,
    attemptsPerAnswerer: 2,
    elapsedRatio: 0.9,
    averageAnswererScore: answerer({ answerableCount: 5, elapsedRatio: 0.9, guessesUsed: 2 }),
  });
  expect(half.score).toBe(2);
  expect(full.score).toBe(1);
  expect(half.score + full.score).toBeLessThan(legacy);
});

test("出题人：无人猜中 → -2；难度分过低 → -1；其余不小于 0", () => {
  expect(
    computeSongSubmitterScore({
      answerableCount: 4,
      correctCount: 0,
      averageAnswererScore: 0,
      difficulty: 0.9,
    })
  ).toBe(-2);
  expect(
    computeSongSubmitterScore({
      answerableCount: 4,
      correctCount: 1,
      averageAnswererScore: 12,
      difficulty: 0.19,
    })
  ).toBe(-1);
  // 恰好等于阈值时不扣分，乘积小到四舍五入为 0，硬边界「其余不小于 0」成立
  expect(
    computeSongSubmitterScore({
      answerableCount: 1,
      correctCount: 1,
      averageAnswererScore: 1,
      difficulty: SONG_SCORE.lowDifficultyThreshold,
    })
  ).toBe(0);
});

test("难度分：三项加权合成，猜中的人越多 D 越低", () => {
  const hard = computeSongDifficulty({
    answerableCount: 4,
    correctCount: 1,
    totalAttempts: 3,
    correctElapsedRatios: [1],
    maxGuessesPerRound: MAX_GUESSES,
  });
  // 0.5×(1−1/4) + 0.3×min(1, (3/4)/3) + 0.2×(1−1)
  expect(hard).toBeCloseTo(0.5 * 0.75 + 0.3 * 0.25 + 0.2 * 0, 5);

  const easy = computeSongDifficulty({
    answerableCount: 4,
    correctCount: 4,
    totalAttempts: 3,
    correctElapsedRatios: [1],
    maxGuessesPerRound: MAX_GUESSES,
  });
  expect(easy).toBeLessThan(hard);

  // 用时项按 (1−用时/时限) 计入：解得越快，这一项越大。
  const instant = computeSongDifficulty({
    answerableCount: 4,
    correctCount: 1,
    totalAttempts: 3,
    correctElapsedRatios: [0],
    maxGuessesPerRound: MAX_GUESSES,
  });
  expect(instant).toBeCloseTo(hard + 0.2, 5);
});
