import { describe, expect, test } from "bun:test";

import type { CCBGameSettings } from "../src/shared/Index";

import {
  CCB_ATTEMPT_MARKS,
  CCB_END_MARK,
  appendCCBEndMarkOnce,
  calculateCCBNonstopSetterScore,
  calculateCCBSetterScore,
  calculateCCBWinnerScore,
  computeCCBPartialAwardees,
  countCCBAttemptMarks,
  evaluateCCBAttemptLimit,
  generateCCBFeedback,
  getCCBEndResultFromMarks,
  hasCCBEndMark,
  isCCBBigWin,
  maskCCBFeedbackTags,
  mergeCCBBannedTags,
  resolveCCBAppearanceSubset,
  resolveCCBAppearanceTypes,
  resolveCCBSubjectSearchMetaTags,
  resolveCCBSubjectSearchTypes,
  resolveCCBNonstopRankScore,
  resolveCCBRevealedHints,
  resolveCCBSetterScore,
  resolveCCBSyncVerdict,
  resolveCCBTimeLimitMs,
  revealCCBBannedTagsToAll,
  stageCCBBannedTags,
  stripCCBEndMarks,
  type CCBCharacterView,
  type CCBCompareFeedback,
} from "../src/domain/CCBRules";

// 标记一律用常量拼，避免测试文件本身被编辑器/行尾工具改写后静默变色。
const T = CCB_ATTEMPT_MARKS.timeout; // ⏱️
const P = CCB_ATTEMPT_MARKS.partial; // 💡
const C = CCB_ATTEMPT_MARKS.correct; // ✔
const X = CCB_ATTEMPT_MARKS.wrong; // ❌
const WIN = CCB_END_MARK.win; // ✌
const CROWN = CCB_END_MARK.bigWin; // 👑
const DEAD = CCB_END_MARK.dead; // 💀
const TEAM = CCB_END_MARK.teamWin; // 🏆
const FLAG = CCB_END_MARK.surrender; // 🏳️

const character = (overrides: Partial<CCBCharacterView> = {}): CCBCharacterView => ({
  id: 1,
  name: "ルルーシュ",
  nameCn: "鲁路修",
  gender: "male",
  popularity: 1000,
  appearances: [],
  appearancesCn: [],
  appearanceIds: [],
  latestAppearance: -1,
  earliestAppearance: -1,
  highestRating: -1,
  metaTags: [],
  rawTags: [],
  characterTags: [],
  animeVAs: [],
  ...overrides,
});

/** 反馈判定只需这三个设置字段。 */
const defaultSettings: Pick<CCBGameSettings, "commonTags" | "subjectTagNum" | "characterTagNum"> = {
  commonTags: false,
  subjectTagNum: 3,
  characterTagNum: 8,
};

describe("标记字面量与计数", () => {
  test("码点与原版一致（只有 ⏱️ 与 🏳️ 带变体选择符）", () => {
    expect(CCB_ATTEMPT_MARKS.timeout.codePointAt(0)).toBe(0x23f1);
    expect([...CCB_ATTEMPT_MARKS.timeout]).toHaveLength(2);
    expect(CCB_ATTEMPT_MARKS.correct.codePointAt(0)).toBe(0x2714);
    expect([...CCB_ATTEMPT_MARKS.correct]).toHaveLength(1);
    expect(CCB_END_MARK.surrender.codePointAt(0)).toBe(0x1f3f3);
    expect([...CCB_END_MARK.surrender]).toHaveLength(2);
    expect([...CCB_END_MARK.win]).toHaveLength(1);
  });

  test("尝试标记计数：`⏱️` 整体算 1 次，结束标记不计入", () => {
    expect(countCCBAttemptMarks("")).toBe(0);
    expect(countCCBAttemptMarks(T)).toBe(1);
    expect(countCCBAttemptMarks(T + T)).toBe(2);
    expect(countCCBAttemptMarks(C)).toBe(1);
    expect(countCCBAttemptMarks(X)).toBe(1);
    expect(countCCBAttemptMarks(P)).toBe(1);
    expect(countCCBAttemptMarks(C + WIN)).toBe(1);
    expect(countCCBAttemptMarks(P + C + WIN + CROWN + TEAM)).toBe(2);
  });

  test("结束标记的判定、剥离与互斥追加", () => {
    expect(hasCCBEndMark(C + WIN)).toBe(true);
    expect(hasCCBEndMark(C + P)).toBe(false);
    expect(stripCCBEndMarks(C + TEAM + WIN)).toBe(C);
    expect(stripCCBEndMarks(C + FLAG)).toBe(C);
    // `appendEndMarkOnce` 保证不会出现 `💀` 与 `✌` 并存
    expect(appendCCBEndMarkOnce(C + WIN, DEAD)).toBe(C + DEAD);
    expect(appendCCBEndMarkOnce(C + DEAD, WIN)).toBe(C + WIN);
  });

  test("结束方式的判定优先级：🏆 > 💀 > 🏳️", () => {
    expect(getCCBEndResultFromMarks(C + WIN)).toBe("");
    expect(getCCBEndResultFromMarks(C + TEAM + WIN)).toBe("teamwin");
    expect(getCCBEndResultFromMarks(C + DEAD + WIN)).toBe("lose");
    expect(getCCBEndResultFromMarks(C + FLAG)).toBe("surrender");
    // 裸 🏳（丢了 FE0F）也要认
    expect(getCCBEndResultFromMarks(C + "\uD83C\uDFF3")).toBe("surrender");
  });

  test("计分路径的字符数：FE0F 会被 strip 字符类一并吃掉，所以 `⏱️` 也只算 1", () => {
    // 这是实测结论（见 Agents/CCB.md §5 缺陷 #3 的更正），不是假设。
    expect(calculateCCBWinnerScore({ guesses: T + C + WIN, baseScore: 2 }).guessCount).toBe(2);
    expect(calculateCCBWinnerScore({ guesses: T + WIN, baseScore: 2 }).guessCount).toBe(1);
    expect(calculateCCBWinnerScore({ guesses: WIN, baseScore: 2 }).guessCount).toBe(0);
  });
});

describe("反馈判定", () => {
  test("gender：相等 yes，否则 no", () => {
    const answer = character({ gender: "female" });
    expect(generateCCBFeedback(character({ gender: "female" }), answer, defaultSettings).gender).toEqual({
      guess: "female",
      feedback: "yes",
    });
    expect(generateCCBFeedback(character({ gender: "male" }), answer, defaultSettings).gender.feedback).toBe("no");
    // `?` 参与比较但只与自己相等
    expect(generateCCBFeedback(character({ gender: "?" }), character({ gender: "?" }), defaultSettings).gender.feedback).toBe("yes");
  });

  test("popularity：以**答案**为基准的 5% / 20% 分档", () => {
    const answer = character({ popularity: 1000 });
    const table: Array<[number, CCBCompareFeedback]> = [
      [1000, "="],
      [1050, "="],
      [1051, "+"],
      [1200, "+"],
      [1201, "++"],
      [949, "-"],
      [800, "-"],
      [799, "--"],
    ];
    for (const [popularity, feedback] of table) {
      const result = generateCCBFeedback(character({ popularity }), answer, defaultSettings).popularity;
      expect({ popularity, feedback: result.feedback }).toEqual({ popularity, feedback });
      expect(result.guess).toBe(popularity);
    }
  });

  test("rating：任一侧 -1 为 `?`；容差 0.3、单档 1 分", () => {
    const answer = character({ highestRating: 8 });
    const table: Array<[number, CCBCompareFeedback]> = [
      [8, "="],
      [8.2, "="],
      // 边界在 IEEE754 下**不对称**，这是必须照抄的浮点行为，不是笔误：
      //   8.3 − 8 = +0.3000000000000007 → 大于 0.3 → `+`
      //   7.7 − 8 = −0.2999999999999998 → 小于 0.3 → `=`
      [8.3, "+"],
      [8.4, "+"],
      [9, "+"],
      [9.1, "++"],
      [7.8, "="],
      [7.7, "="],
      [7.6, "-"],
      [7, "-"],
      [6.9, "--"],
    ];
    for (const [highestRating, feedback] of table) {
      expect({ highestRating, feedback: generateCCBFeedback(character({ highestRating }), answer, defaultSettings).rating.feedback }).toEqual(
        { highestRating, feedback },
      );
    }
    // 只有年份字段会把 -1 换成 `?`；`rating.guess` 保留原值 -1（原版的不对称）。
    expect(generateCCBFeedback(character({ highestRating: -1 }), answer, defaultSettings).rating).toEqual({
      guess: -1,
      feedback: "?",
    });
  });

  test("appearancesCount：零差 `=`，差距 ≤2 为单档", () => {
    const answer = character({ appearances: ["a", "b", "c"], appearancesCn: ["a", "b", "c"], appearanceIds: [1, 2, 3] });
    const table: Array<[number, CCBCompareFeedback]> = [
      [3, "="],
      [4, "+"],
      [5, "+"],
      [6, "++"],
      [2, "-"],
      [1, "-"],
      [0, "--"],
    ];
    for (const [count, feedback] of table) {
      const names = Array.from({ length: count }, (_, index) => `g${index}`);
      const guess = character({ appearances: names, appearancesCn: names, appearanceIds: names.map((_, index) => 100 + index) });
      const result = generateCCBFeedback(guess, answer, defaultSettings).appearancesCount;
      expect({ count, feedback: result.feedback, guessCount: result.guess }).toEqual({ count, feedback, guessCount: count });
    }
  });

  test("latestAppearance / earliestAppearance：双方 -1 记 `=`，单侧 -1 记 `?`", () => {
    const answer = character({ latestAppearance: 2015, earliestAppearance: 2008 });
    const latestTable: Array<[number, CCBCompareFeedback]> = [
      [2015, "="],
      [2017, "+"],
      [2018, "++"],
      [2013, "-"],
      [2012, "--"],
    ];
    for (const [latestAppearance, feedback] of latestTable) {
      expect(
        generateCCBFeedback(character({ latestAppearance }), answer, defaultSettings).latestAppearance.feedback,
      ).toBe(feedback);
    }
    expect(
      generateCCBFeedback(character({ latestAppearance: -1 }), answer, defaultSettings).latestAppearance,
    ).toEqual({ guess: "?", feedback: "?" });
    expect(
      generateCCBFeedback(
        character({ latestAppearance: -1 }),
        character({ latestAppearance: -1 }),
        defaultSettings,
      ).latestAppearance,
    ).toEqual({ guess: "?", feedback: "=" });
  });

  test("shared_appearances：`first` 按作品名、`firstOriginal`/`firstCn` 按 subject id", () => {
    const answer = character({ appearances: ["B", "D"], appearancesCn: ["B中", "D中"], appearanceIds: [2, 4] });
    const guess = character({
      appearances: ["A", "B", "C"],
      appearancesCn: ["A中", "B中", "C中"],
      appearanceIds: [1, 2, 3],
    });
    expect(generateCCBFeedback(guess, answer, defaultSettings).shared_appearances).toEqual({
      first: "B",
      firstOriginal: "B",
      firstCn: "B中",
      count: 1,
    });
  });

  test("shared_appearances：id 交集为空时 count 回落到名字交集", () => {
    const answer = character({ appearances: ["X"], appearancesCn: ["X中"], appearanceIds: [10] });
    const guess = character({ appearances: ["X"], appearancesCn: ["X中"], appearanceIds: [9] });
    expect(generateCCBFeedback(guess, answer, defaultSettings).shared_appearances).toEqual({
      first: "X",
      firstOriginal: "",
      firstCn: "",
      count: 1,
    });
  });

  test("metaTags（默认模式）：guess 全量、shared 取交集", () => {
    const answer = character({ metaTags: ["b", "d"] });
    const guess = character({ metaTags: ["a", "b", "c"] });
    expect(generateCCBFeedback(guess, answer, defaultSettings).metaTags).toEqual({
      guess: ["a", "b", "c"],
      shared: ["b"],
    });
  });

  test("metaTags（commonTags 模式）：先取交集再用非交集项补足，声优不截断", () => {
    const answer = character({
      rawTags: [
        ["y", 9],
        ["w", 1],
      ],
      characterTags: ["t2", "t3"],
      animeVAs: ["va2", "va3"],
    });
    const guess = character({
      rawTags: [
        ["x", 10],
        ["y", 5],
        ["z", 3],
      ],
      characterTags: ["t1", "t2"],
      animeVAs: ["va1", "va2"],
    });
    expect(
      generateCCBFeedback(guess, answer, { commonTags: true, subjectTagNum: 3, characterTagNum: 2 }).metaTags,
    ).toEqual({
      guess: ["y", "x", "z", "t2", "t1", "va1", "va2"],
      shared: ["y", "t2", "va2"],
    });
  });
});

describe("计分", () => {
  test("胜者得分：基础分 2 + 好快的猜分档", () => {
    const table: Array<[string, number, number]> = [
      [C + WIN, 2, 0],
      [C + C + WIN, 4, 2],
      [C + C + C + WIN, 4, 2],
      [C + C + C + C + WIN, 3, 1],
      [C.repeat(5) + WIN, 3, 1],
      [C.repeat(6) + WIN, 2, 0],
      [C.repeat(20) + WIN, 2, 0],
      [WIN, 2, 0],
    ];
    for (const [guesses, totalScore, quickGuess] of table) {
      const result = calculateCCBWinnerScore({ guesses, baseScore: 2, totalRounds: 10 });
      expect({ guesses, totalScore: result.totalScore, quickGuess: result.bonuses.quickGuess }).toEqual({
        guesses,
        totalScore,
        quickGuess,
      });
    }
  });

  test("大赢家固定 +12，且不再叠加好快的猜", () => {
    const result = calculateCCBWinnerScore({ guesses: C + CROWN, baseScore: 2, totalRounds: 10 });
    expect(result).toEqual({
      totalScore: 14,
      guessCount: 1,
      isBigWin: true,
      bonuses: { bigWin: 12, quickGuess: 0 },
    });
    // 只有 👑（码点计数为 0）也是 +12
    expect(calculateCCBWinnerScore({ guesses: CROWN, baseScore: 2 }).totalScore).toBe(14);
  });

  test("血战胜者用名次分作为基础分", () => {
    // 第 1 名：9 人 → 基础分 9；一次猜中 → 9
    expect(calculateCCBWinnerScore({ guesses: C + WIN, baseScore: 9, totalRounds: 10 }).totalScore).toBe(9);
    // 第 2 名：基础分 8，两次猜中 → 10
    expect(calculateCCBWinnerScore({ guesses: C + C + WIN, baseScore: 8, totalRounds: 10 }).totalScore).toBe(10);
  });

  test("出题人得分（普通/同步）", () => {
    const table: Array<[{ winnerGuesses: string; winnerGuessCount: number; bigWinnerScore?: number }, number, string]> = [
      [{ winnerGuesses: C + WIN, winnerGuessCount: 1 }, -1, "太简单了"],
      [{ winnerGuesses: C + C + C + WIN, winnerGuessCount: 3 }, -1, "太简单了"],
      [{ winnerGuesses: C.repeat(4) + WIN, winnerGuessCount: 4 }, 0, ""],
      [{ winnerGuesses: C.repeat(6) + WIN, winnerGuessCount: 6 }, 1, "难度适中"],
      [{ winnerGuesses: C + CROWN, winnerGuessCount: 1, bigWinnerScore: 14 }, -7, "纯在送分"],
      [{ winnerGuesses: C + CROWN, winnerGuessCount: 6, bigWinnerScore: 1 }, -1, "纯在送分"],
      [{ winnerGuesses: "", winnerGuessCount: 0 }, -1, "没人猜中"],
    ];
    for (const [input, score, reason] of table) {
      const result = calculateCCBSetterScore({ ...input, totalRounds: 10 });
      expect({ input, score: result.score, reason: result.reason }).toEqual({ input, score, reason });
    }
  });

  test("出题人得分（血战）：按猜中率分档并乘以 ceil(参战人数/2)", () => {
    const table: Array<[{ winnersCount: number; hasBigWinner?: boolean; bigWinnerScore?: number }, number, string]> = [
      [{ winnersCount: 0 }, -8, "无人猜中"],
      [{ winnersCount: 2 }, 4, "难度偏高"],
      [{ winnersCount: 6 }, 4, "难度偏低"],
      [{ winnersCount: 4 }, 8, "难度适中"],
      [{ winnersCount: 4, hasBigWinner: true, bigWinnerScore: 14 }, -7, "纯在送分"],
    ];
    for (const [input, score, reason] of table) {
      const result = calculateCCBNonstopSetterScore({ ...input, totalPlayersCount: 8 });
      expect({ input, score: result.score, reason: result.reason }).toEqual({ input, score, reason });
    }
  });
});

describe("次数上限与大赢家", () => {
  test("次数上限判定", () => {
    expect(evaluateCCBAttemptLimit({ marks: C.repeat(9), maxAttempts: 10 })).toEqual({
      exhausted: false,
      shouldApplyDeath: false,
      attemptCount: 9,
      maxAttempts: 10,
    });
    expect(evaluateCCBAttemptLimit({ marks: C.repeat(10), maxAttempts: 10 })).toEqual({
      exhausted: true,
      shouldApplyDeath: true,
      attemptCount: 10,
      maxAttempts: 10,
    });
    // `⏱️` 也各算一次
    expect(evaluateCCBAttemptLimit({ marks: T.repeat(10), maxAttempts: 10 }).shouldApplyDeath).toBe(true);
    // 已结束的实体不再补标记
    expect(evaluateCCBAttemptLimit({ marks: C.repeat(10) + WIN, maxAttempts: 10 }).shouldApplyDeath).toBe(false);
    // 最后一发猜中不判死
    expect(
      evaluateCCBAttemptLimit({ marks: C.repeat(10), maxAttempts: 10, isCorrect: true }).shouldApplyDeath,
    ).toBe(false);
    // maxAttempts 缺省/为 0 时回落到 10（原版 `settings.maxAttempts || 10`）
    expect(evaluateCCBAttemptLimit({ marks: C.repeat(10), maxAttempts: 0 }).maxAttempts).toBe(10);
  });

  test("大赢家：首猜即中，或本命头像就是答案", () => {
    expect(isCCBBigWin({ marksBeforeGuess: C, avatarId: 5, answerId: 9 })).toBe(true);
    expect(isCCBBigWin({ marksBeforeGuess: C + C, avatarId: 5, answerId: 9 })).toBe(false);
    expect(isCCBBigWin({ marksBeforeGuess: C + C, avatarId: 9, answerId: 9 })).toBe(true);
    expect(isCCBBigWin({ marksBeforeGuess: "", avatarId: 5, answerId: 9 })).toBe(false);
    // 答案未知时不因头像判大赢家
    expect(isCCBBigWin({ marksBeforeGuess: C + C, avatarId: 9, answerId: null })).toBe(false);
  });

  test("作品分获奖者：每组最早一次，排除出题人与旁观者", () => {
    const awardees = computeCCBPartialAwardees([
      { playerId: "a", username: "alice", index: 0, team: null, isPartialCorrect: true, isCorrect: false },
      { playerId: "b", username: "bob", index: 3, team: null, isPartialCorrect: true, isCorrect: false },
      { playerId: "c", username: "carol", index: 2, team: null, isPartialCorrect: true, isCorrect: false },
      // 猜对的不算作品分
      { playerId: "d", username: "dave", index: 1, team: null, isPartialCorrect: true, isCorrect: true },
      // 出题人与观众排除
      { playerId: "setter", username: "setter", index: 0, team: null, isAnswerSetter: true, isPartialCorrect: true, isCorrect: false },
      { playerId: "watcher", username: "watcher", index: 0, team: "0", isPartialCorrect: true, isCorrect: false },
    ]);
    // 单人组按各自 playerId 分组，因此 a/c/b 各得一分
    expect([...awardees].sort()).toEqual(["a", "b", "c"]);
  });

  test("作品分获奖者：同队只取最早的一位，同序号按用户名升序破平", () => {
    const awardees = computeCCBPartialAwardees([
      { playerId: "x", username: "zed", index: 4, team: "1", isPartialCorrect: true, isCorrect: false },
      { playerId: "y", username: "amy", index: 4, team: "1", isPartialCorrect: true, isCorrect: false },
      { playerId: "z", username: "bob", index: 6, team: "1", isPartialCorrect: true, isCorrect: false },
      { playerId: "w", username: "cat", index: 1, team: "2", isPartialCorrect: true, isCorrect: false },
    ]);
    expect([...awardees].sort()).toEqual(["w", "y"]);
  });
});

describe("设置派生", () => {
  test("登场作品的大类过滤：`includes` + else-if 链，且没有 Galgame 分支", () => {
    expect(resolveCCBAppearanceTypes(["动画"])).toEqual([2]);
    expect(resolveCCBAppearanceTypes(["书籍"])).toEqual([1]);
    expect(resolveCCBAppearanceTypes(["三次元"])).toEqual([6]);
    expect(resolveCCBAppearanceTypes(["全部"])).toEqual([1, 2, 4, 6]);
    // 原版怪行为：Galgame 不在链上，落到默认的 [2]
    expect(resolveCCBAppearanceTypes(["Galgame"])).toEqual([2]);
    // 链的先后：游戏 先于 书籍
    expect(resolveCCBAppearanceTypes(["游戏", "书籍"])).toEqual([4]);
    expect(resolveCCBAppearanceTypes(["书籍", "游戏"])).toEqual([4]);
  });

  test("作品检索的类型：只看 primary（首个元素），与上面那条不同", () => {
    expect(resolveCCBSubjectSearchTypes(["Galgame"])).toEqual([4]);
    expect(resolveCCBSubjectSearchTypes(["书籍"])).toEqual([1]);
    expect(resolveCCBSubjectSearchTypes(["游戏"])).toEqual([4]);
    expect(resolveCCBSubjectSearchTypes(["三次元"])).toEqual([6]);
    expect(resolveCCBSubjectSearchTypes(["全部"])).toEqual([1, 2, 4, 6]);
    expect(resolveCCBSubjectSearchTypes(["科幻"])).toEqual([2]);
    expect(resolveCCBSubjectSearchTypes([])).toEqual([2]);
  });

  test("作品检索的 meta 过滤项：Galgame 特例替换，且不剔除「动画」", () => {
    expect(resolveCCBSubjectSearchMetaTags(["Galgame", "科幻"])).toEqual(["Galgame"]);
    expect(resolveCCBSubjectSearchMetaTags(["动画", "科幻"])).toEqual(["动画", "科幻"]);
    expect(resolveCCBSubjectSearchMetaTags(["游戏", "科幻", ""])).toEqual(["科幻"]);
    expect(resolveCCBSubjectSearchMetaTags(["书籍", "全部"])).toEqual([]);
  });

  test("登场作品子集：先按大类过滤，为空则回退全部类型", () => {
    const rows = [
      { subjectId: 1, subjectType: 2, year: 2010, rating: 8 },
      { subjectId: 2, subjectType: 4, year: 2011, rating: 7 },
      { subjectId: 3, subjectType: 3, year: 2012, rating: 6 },
    ];
    expect(resolveCCBAppearanceSubset(rows, { metaTags: ["动画"] })).toEqual([rows[0]]);
    // 没有类型为 2 的作品 → 回退到全部
    expect(resolveCCBAppearanceSubset(rows, { metaTags: ["书籍"] })).toEqual(rows);
  });

  test("单局时限：<=0 关闭，否则下限 10 秒", () => {
    expect(resolveCCBTimeLimitMs({ timeLimitMs: 0 })).toBe(0);
    expect(resolveCCBTimeLimitMs({ timeLimitMs: -1 })).toBe(0);
    expect(resolveCCBTimeLimitMs({ timeLimitMs: 5000 })).toBe(10_000);
    expect(resolveCCBTimeLimitMs({ timeLimitMs: 60_000 })).toBe(60_000);
  });
});

describe("标签全局 BP（tagBan）", () => {
  test("暂存：同一个 tag 只留一条，去空白、丢空串", () => {
    expect(stageCCBBannedTags(["紫瞳", "紫瞳", " 黑发 ", ""], "p1")).toEqual([
      { tag: "紫瞳", revealer: ["p1"] },
      { tag: "黑发", revealer: ["p1"] },
    ]);
    expect(stageCCBBannedTags([], "p1")).toEqual([]);
  });

  test("暂存：已提交的标签跳过（谁先揭示归谁）", () => {
    expect(stageCCBBannedTags(["紫瞳", "黑发"], "p2", ["紫瞳"])).toEqual([
      { tag: "黑发", revealer: ["p2"] },
    ]);
  });

  test("合并：只收新标签，已提交标签的后来者不算揭示者", () => {
    const state = [{ tag: "紫瞳", revealer: ["p1"] }];
    const pending = [
      { tag: "紫瞳", revealer: ["p2"] },
      { tag: "腹黑", revealer: ["p2"] },
    ];
    const merged = mergeCCBBannedTags(state, pending);

    // ⚠️ 这是「全局 BP 有效」的关键：若第一次就把 revealer 并起来，机制完全失效。
    expect(merged).toEqual([
      { tag: "紫瞳", revealer: ["p1"] },
      { tag: "腹黑", revealer: ["p2"] },
    ]);
    // 纯函数：两个入参都不能被改。
    expect(state).toEqual([{ tag: "紫瞳", revealer: ["p1"] }]);
    expect(pending[0]!.revealer).toEqual(["p2"]);
  });

  test("合并：空 tag 直接丢弃", () => {
    expect(mergeCCBBannedTags([], [{ tag: "  ", revealer: ["p1"] }])).toEqual([]);
  });

  test("同步模式收尾：本轮参战玩家全部并入 revealer", () => {
    expect(
      revealCCBBannedTagsToAll([{ tag: "紫瞳", revealer: ["p1"] }], ["p1", "p2", "p3"]),
    ).toEqual([{ tag: "紫瞳", revealer: ["p1", "p2", "p3"] }]);
    // 纯函数：不改入参。
    expect(revealCCBBannedTagsToAll([{ tag: "紫瞳", revealer: ["p1"] }], [])).toEqual([
      { tag: "紫瞳", revealer: ["p1"] },
    ]);
  });

  test("遮掩：非揭示者看到 ???，揭示者照常看到；shared 里的被剔除", () => {
    const feedback = generateCCBFeedback(
      character({ metaTags: ["a", "b", "c"] }),
      character({ metaTags: ["b", "c"] }),
      defaultSettings,
    );
    expect(feedback.metaTags).toEqual({ guess: ["a", "b", "c"], shared: ["b", "c"] });

    // 只有 b 被屏蔽，且自己不是 b 的揭示者：guess 里换成 ???，shared 里直接剔除。
    expect(maskCCBFeedbackTags(feedback, ["b"], new Set<string>())).toMatchObject({
      metaTags: { guess: ["a", "???", "c"], shared: ["c"] },
    });
    // 自己是 b 的揭示者：原样可见。
    expect(maskCCBFeedbackTags(feedback, ["b"], new Set<string>(["b"]))).toMatchObject({
      metaTags: { guess: ["a", "b", "c"], shared: ["b", "c"] },
    });
    // 没有屏蔽项时直接短路返回同一个引用。
    expect(maskCCBFeedbackTags(feedback, [], new Set<string>())).toBe(feedback);
  });
});

describe("模式推进（同步 / 血战）", () => {
  test("同步判定：还有人没轮完就 waiting", () => {
    expect(
      resolveCCBSyncVerdict({
        participantIds: ["p1", "p2"],
        completedIds: ["p1"],
        hasWinner: false,
      }),
    ).toBe("waiting");
  });

  test("同步判定：全员完成且已有胜者才 settle", () => {
    expect(
      resolveCCBSyncVerdict({
        participantIds: ["p1", "p2"],
        completedIds: ["p1", "p2"],
        hasWinner: true,
      }),
    ).toBe("settle");
  });

  test("同步判定：全员完成但还没胜者就 advance", () => {
    // 完成列表的顺序无关紧要，判据只看「在不在里面」。
    expect(
      resolveCCBSyncVerdict({
        participantIds: ["p1", "p2"],
        completedIds: ["p2", "p1"],
        hasWinner: false,
      }),
    ).toBe("advance");
  });

  test("同步判定：参战玩家归零直接收尾（原版此处会永久卡住）", () => {
    expect(
      resolveCCBSyncVerdict({ participantIds: [], completedIds: [], hasWinner: false }),
    ).toBe("settle");
  });

  test("血战名次分依次递减，最低保底 1", () => {
    expect(resolveCCBNonstopRankScore(3, 0)).toBe(3);
    expect(resolveCCBNonstopRankScore(3, 1)).toBe(2);
    expect(resolveCCBNonstopRankScore(3, 2)).toBe(1);
    // 已胜人数追平或超过参战人数时也不能给 0 分或负分。
    expect(resolveCCBNonstopRankScore(3, 3)).toBe(1);
    expect(resolveCCBNonstopRankScore(3, 5)).toBe(1);
    expect(resolveCCBNonstopRankScore(0, 0)).toBe(1);
  });
});

describe("出题人计分（按模式选表）", () => {
  test("普通/同步：大赢家 → 扣其得分的一半（向下取整、至少 1）", () => {
    expect(
      resolveCCBSetterScore({
        mode: "normal",
        winnerMarks: "✔👑",
        winnerGuessCount: 1,
        bigWinnerScore: 14,
        winnersCount: 1,
        totalPlayers: 3,
        totalRounds: 10,
      }),
    ).toEqual({ score: -7, reason: "纯在送分" });
  });

  test("普通/同步：按首猜次数分档，无人猜中扣 1", () => {
    const base = {
      mode: "sync" as const,
      bigWinnerScore: 0,
      winnersCount: 1,
      totalPlayers: 3,
      totalRounds: 10,
    };
    expect(
      resolveCCBSetterScore({ ...base, winnerMarks: "❌💡✔✌", winnerGuessCount: 3 }),
    ).toEqual({ score: -1, reason: "太简单了" });
    // totalRounds = 10，半数正好是 5：5 次不算「超过一半」，落在不加不减那一档。
    expect(
      resolveCCBSetterScore({ ...base, winnerMarks: "❌❌❌❌✔✌", winnerGuessCount: 5 }),
    ).toEqual({ score: 0, reason: "" });
    expect(
      resolveCCBSetterScore({ ...base, winnerMarks: "❌❌❌❌❌❌✔✌", winnerGuessCount: 7 }),
    ).toEqual({ score: 1, reason: "难度适中" });
    expect(
      resolveCCBSetterScore({
        ...base,
        winnerMarks: "",
        winnerGuessCount: 0,
        winnersCount: 0,
      }),
    ).toEqual({ score: -1, reason: "没人猜中" });
  });

  test("血战：按猜中率给分，乘数 = ceil(参战人数 / 2)", () => {
    const base = {
      mode: "bloodbath" as const,
      winnerMarks: "",
      winnerGuessCount: 0,
      bigWinnerScore: 0,
      totalRounds: 10,
    };
    // 4 人参战，乘数 2：25% → 偏高 ×1、50% → 适中 ×2、75% → 偏低 ×1、无人 → −2。
    expect(resolveCCBSetterScore({ ...base, winnersCount: 1, totalPlayers: 4 })).toEqual({
      score: 2,
      reason: "难度偏高",
    });
    expect(resolveCCBSetterScore({ ...base, winnersCount: 2, totalPlayers: 4 })).toEqual({
      score: 4,
      reason: "难度适中",
    });
    expect(resolveCCBSetterScore({ ...base, winnersCount: 3, totalPlayers: 4 })).toEqual({
      score: 2,
      reason: "难度偏低",
    });
    expect(resolveCCBSetterScore({ ...base, winnersCount: 0, totalPlayers: 4 })).toEqual({
      score: -4,
      reason: "无人猜中",
    });
  });

  test("血战：大赢家照样优先扣分", () => {
    expect(
      resolveCCBSetterScore({
        mode: "bloodbath",
        winnerMarks: "✔👑",
        winnerGuessCount: 1,
        bigWinnerScore: 15,
        winnersCount: 1,
        totalPlayers: 3,
        totalRounds: 10,
      }),
    ).toEqual({ score: -7, reason: "纯在送分" });
  });
});

describe("提示系统", () => {
  test("按阈值逐条解锁：剩余次数 <= 阈值才显示", () => {
    const hints = ["甲", "乙"];
    const thresholds = [5, 3];
    expect(resolveCCBRevealedHints(hints, thresholds, 6)).toEqual([]);
    expect(resolveCCBRevealedHints(hints, thresholds, 5)).toEqual([{ index: 1, text: "甲" }]);
    expect(resolveCCBRevealedHints(hints, thresholds, 3)).toEqual([
      { index: 1, text: "甲" },
      { index: 2, text: "乙" },
    ]);
    // 剩余次数归零时已解锁的全部保留。
    expect(resolveCCBRevealedHints(hints, thresholds, 0)).toHaveLength(2);
  });

  test("任一侧缺失的位置直接跳过，后面的提示不会错位", () => {
    // 第 2 条没写文本：阈值命中但文本为空 → 跳过，第 1 条照常显示。
    expect(resolveCCBRevealedHints(["甲"], [5, 3], 3)).toEqual([{ index: 1, text: "甲" }]);
    // 阈值比文本多：多出来的阈值没有对应文本，同样跳过。
    expect(resolveCCBRevealedHints(["甲", "乙"], [9], 0)).toEqual([{ index: 1, text: "甲" }]);
    expect(resolveCCBRevealedHints([], [5, 3], 0)).toEqual([]);
  });
});
