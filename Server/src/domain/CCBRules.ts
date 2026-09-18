/**
 * CCB 玩法规则的唯一真相源（纯函数，无 IO、无状态）。
 *
 * 逐条复刻原版 `anime-character-guessr`：
 * - 标记体系与计数：`server/utils/gameplay.js` 顶部（`countAttemptMarks` 一族）
 * - 反馈判定：`client/src/utils/bangumi.js` 的 `generateFeedback`
 * - 计分：`gameplay.js` 的 `calculateWinnerScore` / `calculateSetterScore` /
 *   `calculateNonstopSetterScore`
 *
 * 与 `CCBFilter` 无关 —— 那是同一份 dump 的另一个消费者，不是真相源。
 * 差异登记在 `Agents/CCB.md §6.5`。**改动本文件前必须先改那里的判定表。**
 */

import type {
  CCBCompareFeedback,
  CCBEndResult,
  CCBFeedback,
  CCBGameMode,
  CCBGameSettings,
  CCBGender,
  CCBRevealedHint,
  CCBScalarFeedback,
  CCBSharedAppearancesFeedback,
} from "../shared/CCB";

// 这些类型是**线上的形状**，真相源在共享契约（客户端要渲染反馈），这里只做转发，
// 免得下游出现两个 import 路径。
export type {
  CCBCompareFeedback,
  CCBEndResult,
  CCBFeedback,
  CCBSharedAppearancesFeedback,
  CCBScalarFeedback,
} from "../shared/CCB";

// ==================== 标记体系 ====================
//
// 字符一律写成码点转义，避免源码被编辑器/行尾工具改写后静默变色。
// 对照（原版原文 → 转义）：
//   ⏱️ = U+23F1 U+FE0F（**带变体选择符**）  💡 = U+1F4A1   ✔ = U+2714   ❌ = U+274C
//   ✌ = U+270C   👑 = U+1F451   💀 = U+1F480   🏆 = U+1F3C6   🏳️ = U+1F3F3 U+FE0F
//
// ⚠️ `🏳️` 的 FE0F 被写进了「结束标记」字符类，于是 `stripCCBEndMarks` 会把它一起剥掉
// —— 连带把 `⏱️` 变成单个码点 `⏱`。后果：**计分路径下 `⏱️` 也只算 1 次**
// （`Array.from(clean(guesses)).length`）。这是实测结论，不要"顺手修正"。

/** 尝试标记：计入次数上限。`⏱` 后接可选 FE0F，整体算一个 match。 */
const ATTEMPT_MARK_PATTERN = /(?:\u23F1\uFE0F?|\uD83D\uDCA1|\u2714|\u274C)/g;

/** 结束标记：表示该玩家/队伍本局已结束。 */
export const CCB_END_MARKS = [
  "\u270C", // ✌
  "\uD83D\uDC51", // 👑
  "\uD83D\uDC80", // 💀
  "\uD83C\uDFC6", // 🏆
  "\uD83C\uDFF3\uFE0F", // 🏳️
] as const;

/** 剥离结束标记用的字符类（含 FE0F，见文件头说明）。 */
const END_MARK_PATTERN = /(?:\u270C|\uD83D\uDC51|\uD83D\uDC80|\uD83C\uDFC6|\uD83C\uDFF3\uFE0F?)/g;

/** 计分路径的 «clean» 字符类：原版 `guesses.replace(/[✌👑💀🏳️🏆]/g, '')`。 */
const SCORE_CLEAN_PATTERN = /[\u270C\uD83D\uDC51\uD83D\uDC80\uD83C\uDFF3\uFE0F\uD83C\uDFC6]/g;

export const CCB_ATTEMPT_MARKS = {
  timeout: "\u23F1\uFE0F", // ⏱️
  partial: "\uD83D\uDCA1", // 💡
  correct: "\u2714", // ✔
  wrong: "\u274C", // ❌
} as const;

export const CCB_END_MARK = {
  win: "\u270C", // ✌
  bigWin: "\uD83D\uDC51", // 👑
  dead: "\uD83D\uDC80", // 💀
  teamWin: "\uD83C\uDFC6", // 🏆
  surrender: "\uD83C\uDFF3\uFE0F", // 🏳️
} as const;

/** 已用尝试次数。**这是「次数」的唯一权威**（`guessLimit` 判定/大赢家判定都用它）。 */
export const countCCBAttemptMarks = (marks: string): number => {
  const matched = String(marks ?? "").match(ATTEMPT_MARK_PATTERN);
  return matched ? matched.length : 0;
};

export const hasCCBEndMark = (marks: string): boolean => {
  const source = String(marks ?? "");
  return CCB_END_MARKS.some((mark) => source.includes(mark));
};

export const stripCCBEndMarks = (marks: string): string => String(marks ?? "").replace(END_MARK_PATTERN, "");

/** 结束标记互斥：`💀 + ✌` 这种组合会污染「本局如何结束」的判定，所以先剥离再追加。 */
export const appendCCBEndMarkOnce = (marks: string, endMark: string): string =>
  stripCCBEndMarks(marks) + endMark;

/** 从标记推断本局结束方式。`🏆` 优先于 `💀`，两者又优先于 `🏳️`（原版判定顺序）。 */
export const getCCBEndResultFromMarks = (marks: string): CCBEndResult => {
  const source = String(marks ?? "");
  if (source.includes(CCB_END_MARK.teamWin)) return "teamwin";
  if (source.includes(CCB_END_MARK.dead)) return "lose";
  // 裸 🏳（无 FE0F）也认，与原版 `s.includes('🏳️') || s.includes('🏳')` 一致。
  if (source.includes(CCB_END_MARK.surrender) || source.includes("\uD83C\uDFF3")) return "surrender";
  return "";
};

// ==================== 设置派生 ====================

/**
 * `getCharacterAppearances` 里的大类过滤：**`includes` + else-if 链**，
 * 注意它**没有 `Galgame` 分支**，也没有「动画」分支（默认即 `[2]`）。
 * 这是原版的真实行为：只选 Galgame 的房间，登场作品先按动画过滤、为空再回退全部。
 */
export const resolveCCBAppearanceTypes = (metaTags: string[]): number[] => {
  if (metaTags.includes("游戏")) return [4];
  if (metaTags.includes("书籍")) return [1];
  if (metaTags.includes("三次元")) return [6];
  if (metaTags.includes("全部")) return [1, 2, 4, 6];
  return [2];
};

/** `getRandomCharacter.buildFilter` 的类型：**只看首个元素**（primary），与上面那条不同。 */
export const resolveCCBSubjectSearchTypes = (metaTags: string[]): number[] => {
  switch (metaTags[0]) {
    case "书籍":
      return [1];
    case "游戏":
    case "Galgame":
      return [4];
    case "三次元":
      return [6];
    case "全部":
      return [1, 2, 4, 6];
    default:
      return [2];
  }
};

/**
 * `buildFilter` 传给作品检索的 meta 标签过滤项。
 * `Galgame` 是特例：primary 为它时**替换**成 `['Galgame']`；否则剔除大类字面量后原样传。
 * 注意原版**不剔除「动画」**（它会被当成一个 meta 标签过滤项，通常无副作用）。
 */
export const resolveCCBSubjectSearchMetaTags = (metaTags: string[]): string[] => {
  if (metaTags[0] === "Galgame") return ["Galgame"];
  const categoryMarkers = ["游戏", "书籍", "三次元", "全部"];
  return metaTags.filter((tag) => tag !== "" && !categoryMarkers.includes(tag));
};

/** 单局时限：`<= 0` 关闭；否则下限 10 秒（原版 `Math.max(10, round(sec*1000))`）。 */
export const resolveCCBTimeLimitMs = (settings: Pick<CCBGameSettings, "timeLimitMs">): number => {
  const value = Number(settings.timeLimitMs);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(10_000, Math.round(value));
};

/** 每次猜错后的计时策略与原版一致：普通模式重置本人计时，其余模式只补缺失的计时。 */
export const shouldResetTimerAfterGuess = (
  settings: Pick<CCBGameSettings, "mode">,
  isCorrect: boolean,
): boolean => settings.mode !== "sync" && settings.mode !== "bloodbath" && !isCorrect;

// ==================== 标签全局 BP（`tagBan`） ====================
//
// 原版 `socket.js` 的 `tagBanState` / `tagBanStatePending`，规则：
//
// 1. 一次猜测若**猜中共享标签**（`feedback.metaTags.shared` 非空），这些标签以
//    `{ tag, revealer: [自己] }` 记入「待提交」列表。**中局不生效**；已被提交过的标签跳过
//    （原版 `tagBanSharedMetaTags` 开头就 `return`，即「谁先揭示归谁」）。
// 2. 一局结算时把待提交列表合并进 `tagBanState`：**只收新标签**，同 tag 多条只认最早那条。
// 3. 展示时按观众遮掩：**标签已被禁用、且自己不是揭示者** → 显示为 `???`。
//    也就是说「别人先揭示过的共享标签你就看不到了」——这是竞速向的机制，不是 bug。
// 4. 同步模式在结算时会把**本轮所有参战玩家**都并入 revealer（全员透视），
//    见 `revealCCBBannedTagsToAll`；非同步模式只有真正的揭示者能看到。

/** 被禁用标签对非揭示者的展示形态。 */
export const CCB_MASKED_TAG = "???";

export interface CCBBannedTagEntry {
  tag: string;
  /** 有权看到该标签的玩家 id。 */
  revealer: string[];
}

/**
 * 把一次猜测**猜中的共享标签**整理成待提交条目（去重，同一个 tag 只留一条）。
 *
 * ⚠️ **已提交（`tagBanState` 里已有）的标签必须排除**：原版 `socket.js` 的
 * `tagBanSharedMetaTags` 处理器在开头就 `if (tagBanState.find(...)) return;` ——
 * 也就是「**谁先揭示，标签就归谁**」，后来者不会被记为揭示者。所以全局 BP 的真实效果是
 * 「别人先揭示过的共享标签，你就只能看到 `???`」。做成并集会让这个机制完全失效。
 */
export const stageCCBBannedTags = (
  sharedTags: readonly string[],
  playerId: string,
  alreadyCommitted: readonly string[] = [],
): CCBBannedTagEntry[] => {
  const committed = new Set(alreadyCommitted);
  const unique = [...new Set(sharedTags.map((tag) => tag.trim()).filter(Boolean))];
  return unique
    .filter((tag) => !committed.has(tag))
    .map((tag) => ({ tag, revealer: playerId ? [playerId] : [] }));
};

/**
 * 结算时合并待提交条目。纯函数：返回新数组，不修改入参。
 *
 * **只收新标签，不并 revealer**：同一个 tag 出现多条时，只有**最早那条**算数
 * （与「谁先揭示归谁」一致）。空 tag 直接丢弃。
 */
export const mergeCCBBannedTags = (
  state: readonly CCBBannedTagEntry[],
  pending: readonly CCBBannedTagEntry[],
): CCBBannedTagEntry[] => {
  const merged = state.map((entry) => ({ tag: entry.tag, revealer: [...entry.revealer] }));
  const committed = new Set(merged.map((entry) => entry.tag));

  for (const entry of pending) {
    const tag = entry.tag?.trim();
    if (!tag || committed.has(tag)) continue;
    merged.push({ tag, revealer: [...entry.revealer] });
    committed.add(tag);
  }

  return merged;
};

/**
 * 同步模式的收尾：把本轮**所有参战玩家**并入每条标签的 revealer（全员透视）。
 *
 * 原版在 `gameplay.js` 的 `allCompleted` 分支里做这件事，之后这些标签才算正式提交 ——
 * 所以同步模式下「谁先揭示」不成立，整轮结束后大家一起看见。
 */
export const revealCCBBannedTagsToAll = (
  state: readonly CCBBannedTagEntry[],
  participantIds: readonly string[],
): CCBBannedTagEntry[] =>
  state.map((entry) => {
    const seen = new Set(entry.revealer);
    for (const id of participantIds) if (id && !seen.has(id)) seen.add(id);
    return { tag: entry.tag, revealer: [...seen] };
  });

/**
 * 按观众遮掩反馈里的标签。
 *
 * 只动 `metaTags` 两个数组：`guess` 里被遮掩的替换成 `???`，
 * `shared` 里被遮掩的直接剔除（否则交集本身会泄露标签存在）。
 * 其余 7 个字段与 `feedback` 的其它内容原样透传。
 */
export const maskCCBFeedbackTags = (
  feedback: CCBFeedback,
  bannedTags: readonly string[],
  entitled: ReadonlySet<string>,
): CCBFeedback => {
  if (bannedTags.length === 0) return feedback;
  const banned = new Set(bannedTags);
  const hidden = (tag: string) => banned.has(tag) && !entitled.has(tag);

  return {
    ...feedback,
    metaTags: {
      guess: feedback.metaTags.guess.map((tag) => (hidden(tag) ? CCB_MASKED_TAG : tag)),
      shared: feedback.metaTags.shared.filter((tag) => !hidden(tag)),
    },
  };
};

// ==================== 提示系统 ====================
//
// 原版里提示是**纯客户端**行为（`GameInfo.jsx`）：出题人提供文本数组，客户端按
// `guessesLeft <= useHints[i]` 决定显示第几条；图片提示（`useImageHint`）是把答案立绘
// 按剩余次数做 CSS 模糊。**本项目只移植文本提示**，图片提示不移植（见 §6.9 说明）。

/**
 * 算出**本条该显示**的提示（原版 `guessesLeft <= useHints[i]`）。
 *
 * 返回值类型 `CCBRevealedHint` 的真相源在 `shared/CCB.ts`（客户端要渲染它，见那里的说明）。
 *
 * `thresholds` 与 `hints` 按序配对：第 i 条阈值配第 i 条文本。
 * 任一侧缺失的位置直接跳过（原版 JSX 里就是这么 `&&` 起来的），
 * 所以出题人少填一条不会让后面的提示整体错位。
 */
export const resolveCCBRevealedHints = (
  hints: readonly string[],
  thresholds: readonly number[],
  remainingGuesses: number,
): CCBRevealedHint[] => {
  const revealed: CCBRevealedHint[] = [];
  thresholds.forEach((threshold, index) => {
    const text = hints[index];
    if (!text || remainingGuesses > threshold) return;
    revealed.push({ index: index + 1, text });
  });
  return revealed;
};

// ==================== 模式推进（同步 / 血战） ====================
//
// 真相源：原版 `gameplay.js` 的 `updateSyncProgress` 与 `finalizeNonstopGame`。
// ⚠️ **两者不是同一套推进**：
// - `sync`：按「轮」推进，同一答案下每人的一次猜测算一轮，全员完成才进下一轮；
// - `bloodbath`：**与轮次无关**（原版 `nonstopMode` 会覆盖 `syncMode`，见 `gameplay.js:899`
//   的 `syncMode && !nonstopMode`），玩家自由连续猜，直到**全员结束**才收尾。

/** 同步模式的推进结论。 */
export type CCBSyncVerdict = "waiting" | "advance" | "settle";

/**
 * 同步模式的推进判定。
 *
 * - `participantIds` 只放**本局尚未结束**的参战玩家；
 * - 还有人在本轮没猜完 → `waiting`；
 * - 全员完成且本轮已出现胜者 → `settle`（原版 `syncReadyToEnd`）；
 * - 全员完成但还没胜者 → `advance`（轮次 +1、清空完成列表）。
 *
 * ⚠️ **参战玩家归零时返回 `settle`**：原版此处直接 `return` 什么都不做，
 * 于是「全员 💀 且无人猜中」的同步局会永久卡在 `guessing`。增强版改为直接收尾，
 * 已登记为已知差异（`Agents/CCB.md §5`）。
 */
export const resolveCCBSyncVerdict = ({
  participantIds,
  completedIds,
  hasWinner,
}: {
  participantIds: readonly string[];
  completedIds: readonly string[];
  hasWinner: boolean;
}): CCBSyncVerdict => {
  if (participantIds.length === 0) return "settle";
  const completed = new Set(completedIds);
  if (!participantIds.every((id) => completed.has(id))) return "waiting";
  return hasWinner ? "settle" : "advance";
};

/**
 * 血战名次分：`max(1, 参战人数 − 已胜人数)`。
 *
 * 第一个猜对拿满「开局参战人数」，之后依次递减，最后一名保底 1 分。
 * 这个分数在**猜对当场**就发（原版 `settleNonstopCorrectGuess`），
 * 所以血战的结算阶段不再重复计胜者分。
 */
export const resolveCCBNonstopRankScore = (
  totalPlayers: number,
  winnersBefore: number,
): number => Math.max(1, Math.max(1, totalPlayers) - winnersBefore);

// ==================== 反馈判定 ====================

export interface CCBAppearanceRow {
  subjectId: number;
  subjectType: number;
  year: number;
  rating: number;
}

/**
 * 按房间设置筛出真正参与反馈计算的登场作品（原版 `filteredAppearances`）。
 *
 * 顺序很关键：**先按大类过滤，过滤后为空则回退到全部类型**。因此数据层物化的是
 * 「全部类型」的超集，这里才做收窄。
 */
export const resolveCCBAppearanceSubset = <TRow extends CCBAppearanceRow>(
  rows: TRow[],
  settings: Pick<CCBGameSettings, "metaTags">,
): TRow[] => {
  const types = resolveCCBAppearanceTypes(settings.metaTags);
  const filtered = rows.filter((row) => types.includes(row.subjectType));
  return filtered.length > 0 ? filtered : rows;
};

/**
 * 反馈计算所需的角色视图。字段与原版 `getCharacterDetails` +
 * `getCharacterAppearances` 的返回值一一对应。
 */
export interface CCBCharacterView {
  id: number;
  /** 原名（多为日文）。`appearances` 用的就是它。 */
  name: string;
  nameCn: string;
  gender: CCBGender;
  /** 热度 = `collects + comments`。 */
  popularity: number;
  /** 登场作品原名，与 `appearanceIds` 同序同长。 */
  appearances: string[];
  /** 登场作品中文名（缺失时回落到原名）。 */
  appearancesCn: string[];
  appearanceIds: number[];
  /** 无有效作品时为 `-1`（原版哨兵值）。 */
  latestAppearance: number;
  earliestAppearance: number;
  /** 无有效作品时为 `-1`；另有「一个作品关联都没有」时为 `0` 的分支。 */
  highestRating: number;
  /** 非 `commonTags` 模式的标签池（有序）。 */
  metaTags: string[];
  /** `commonTags` 模式的候选：标签 → 票数，**保序**（原版是 `Map`）。 */
  rawTags: Array<[string, number]>;
  /** 角色标签，保 `character_tags.position` 序。 */
  characterTags: string[];
  /** 声优原名，保序遍历。 */
  animeVAs: string[];
}

/** 分档比较：`equal` → `=`；偏高 → `+`/`++`；偏低 → `-`/`--`。 */
const steppedFeedback = (diff: number, tolerance: number, step: number): CCBCompareFeedback => {
  if (Math.abs(diff) <= tolerance) return "=";
  if (diff > 0) return diff <= step ? "+" : "++";
  return diff >= -step ? "-" : "--";
};

/** 年份类（`latestAppearance` / `earliestAppearance`）：相等 `=`，差距 ≤2 为单档。 */
const yearFeedback = (diff: number): CCBCompareFeedback => {
  if (diff === 0) return "=";
  if (diff > 0) return diff <= 2 ? "+" : "++";
  return diff >= -2 ? "-" : "--";
};

/**
 * 年份字段的哨兵处理：任一侧为 `-1` 时不可比；
 * **两侧都是 `-1` 反而算相等**（原版对「都没作品」给了 `=`）。
 */
const yearSentinelFeedback = (guessValue: number, answerValue: number): CCBScalarFeedback => {
  if (guessValue === -1 || answerValue === -1) {
    return {
      guess: guessValue === -1 ? "?" : guessValue,
      feedback: guessValue === -1 && answerValue === -1 ? "=" : "?",
    };
  }
  return { guess: guessValue, feedback: yearFeedback(guessValue - answerValue) };
};

/**
 * 生成一次猜测的完整反馈。与原版 `generateFeedback` 逐字段等价。
 *
 * `settings` 参与两件事：`commonTags` 决定走哪条标签分支，
 * `subjectTagNum` / `characterTagNum` 决定标签截断。
 */
export const generateCCBFeedback = (
  guess: CCBCharacterView,
  answer: CCBCharacterView,
  settings: Pick<CCBGameSettings, "commonTags" | "subjectTagNum" | "characterTagNum">,
): CCBFeedback => {
  const popularityDiff = guess.popularity - answer.popularity;
  const fivePercent = answer.popularity * 0.05;
  const twentyPercent = answer.popularity * 0.2;
  let popularity: CCBCompareFeedback;
  if (Math.abs(popularityDiff) <= fivePercent) popularity = "=";
  else if (popularityDiff > 0) popularity = popularityDiff <= twentyPercent ? "+" : "++";
  else popularity = popularityDiff >= -twentyPercent ? "-" : "--";

  // 最高分：任一侧为 -1 即不可比；容差 0.3，单档 1 分。
  let rating: CCBCompareFeedback;
  if (guess.highestRating === -1 || answer.highestRating === -1) rating = "?";
  else rating = steppedFeedback(guess.highestRating - answer.highestRating, 0.3, 1);

  // 共同作品：`first` 按作品名求交集，`firstOriginal` / `firstCn` 按 subject id 求交集，
  // `count` 优先采用 id 交集。三者口径不同是原版实现，必须照抄。
  const sharedByName = guess.appearances.filter((name) => answer.appearances.includes(name));
  const answerIdSet = new Set(answer.appearanceIds ?? []);
  const sharedIndexes = (guess.appearanceIds ?? [])
    .map((id, index) => ({ id, index }))
    .filter((entry) => answerIdSet.has(entry.id));
  const firstSharedIndex = sharedIndexes[0]?.index;
  const sharedAppearances: CCBSharedAppearancesFeedback = {
    first: sharedByName[0] ?? "",
    firstOriginal: firstSharedIndex === undefined ? "" : guess.appearances[firstSharedIndex] ?? "",
    firstCn:
      firstSharedIndex === undefined
        ? ""
        : guess.appearancesCn?.[firstSharedIndex] ?? guess.appearances[firstSharedIndex] ?? "",
    count: sharedIndexes.length || sharedByName.length,
  };

  const appearanceDiff = guess.appearances.length - answer.appearances.length;
  let appearancesCount: CCBCompareFeedback;
  if (appearanceDiff === 0) appearancesCount = "=";
  else if (appearanceDiff > 0) appearancesCount = appearanceDiff <= 2 ? "+" : "++";
  else appearancesCount = appearanceDiff >= -2 ? "-" : "--";

  let metaTags: { guess: string[]; shared: string[] };
  if (settings.commonTags) {
    metaTags = buildCommonTagsFeedback(guess, answer, settings);
  } else {
    const answerMetaTags = new Set(answer.metaTags);
    metaTags = {
      guess: guess.metaTags,
      shared: guess.metaTags.filter((tag) => answerMetaTags.has(tag)),
    };
  }

  return {
    gender: { guess: guess.gender, feedback: guess.gender === answer.gender ? "yes" : "no" },
    popularity: { guess: guess.popularity, feedback: popularity },
    rating: { guess: guess.highestRating, feedback: rating },
    shared_appearances: sharedAppearances,
    appearancesCount: { guess: guess.appearances.length, feedback: appearancesCount },
    metaTags,
    latestAppearance: yearSentinelFeedback(guess.latestAppearance, answer.latestAppearance),
    earliestAppearance: yearSentinelFeedback(guess.earliestAppearance, answer.earliestAppearance),
  };
};

/**
 * `commonTags` 模式的标签反馈：作品标签与角色标签各自「先取交集、再用非交集项补足到上限」，
 * 声优**不截断**。`shared` 只含三类的交集。
 */
const buildCommonTagsFeedback = (
  guess: CCBCharacterView,
  answer: CCBCharacterView,
  settings: Pick<CCBGameSettings, "subjectTagNum" | "characterTagNum">,
): { guess: string[]; shared: string[] } => {
  const guessSubjectTags = guess.rawTags.map(([tag]) => tag);
  const answerSubjectTags = new Set(answer.rawTags.map(([tag]) => tag));
  const sharedSubjectTags = guessSubjectTags
    .filter((tag) => answerSubjectTags.has(tag))
    .slice(0, settings.subjectTagNum);
  const subjectTags = [...sharedSubjectTags];
  for (const tag of guessSubjectTags) {
    if (subjectTags.length >= settings.subjectTagNum) break;
    if (!answerSubjectTags.has(tag)) subjectTags.push(tag);
  }

  const guessCharacterTags = guess.characterTags ?? [];
  const answerCharacterTags = new Set(answer.characterTags ?? []);
  const sharedCharacterTags = guessCharacterTags
    .filter((tag) => answerCharacterTags.has(tag))
    .slice(0, settings.characterTagNum);
  const characterTags = [...sharedCharacterTags];
  for (const tag of guessCharacterTags) {
    if (characterTags.length >= settings.characterTagNum) break;
    if (!answerCharacterTags.has(tag)) characterTags.push(tag);
  }

  const guessCvTags = guess.animeVAs ?? [];
  // 原版用 `answerCVTags.includes` 而非 Set，且不截断；行为等价但保持同序。
  const answerCvTags = answer.animeVAs ?? [];
  const sharedCvTags = guessCvTags.filter((tag) => answerCvTags.includes(tag));

  return {
    guess: [...new Set([...subjectTags, ...characterTags, ...guessCvTags])],
    shared: [...new Set([...sharedSubjectTags, ...sharedCharacterTags, ...sharedCvTags])],
  };
};

// ==================== 计分 ====================

export interface CCBScoreBonuses {
  bigWin: number;
  quickGuess: number;
}

export interface CCBWinnerScore {
  totalScore: number;
  /** 计分口径的「已猜次数」，**与 `countCCBAttemptMarks` 不是同一个数**（见下）。 */
  guessCount: number;
  isBigWin: boolean;
  bonuses: CCBScoreBonuses;
}

/**
 * 胜者得分。`baseScore` 普通/同步固定 2，血战由名次动态给出。
 *
 * ⚠️ `guessCount` 的口径与 `countCCBAttemptMarks` **不同**：这里先按原版的字符类
 * `/[✌👑💀🏳️🏆]/` 剥掉结束标记（该字符类含 FE0F，会顺带把 `⏱️` 变成单码点 `⏱`），
 * 再数**码点**。实测两者对 `⏱️` 都给 1，但**空标记串会得到 0**（尝试计数也是 0）。
 * 保留两套函数是为了逐字复刻原版，不要合并。
 */
export const calculateCCBWinnerScore = ({
  guesses,
  baseScore = 0,
  totalRounds = 10,
}: {
  guesses: string;
  baseScore?: number;
  totalRounds?: number;
}): CCBWinnerScore => {
  const marks = String(guesses ?? "");
  const isBigWin = marks.includes(CCB_END_MARK.bigWin);
  const guessCount = Array.from(marks.replace(SCORE_CLEAN_PATTERN, "")).length;

  const bonuses: CCBScoreBonuses = { bigWin: 0, quickGuess: 0 };
  let totalScore = baseScore;

  if (isBigWin) {
    bonuses.bigWin = 12;
    totalScore += bonuses.bigWin;
  } else if (guessCount >= 2 && guessCount <= 3) {
    bonuses.quickGuess = 2;
  } else {
    const halfRounds = Math.ceil(totalRounds / 2);
    if (guessCount >= 4 && guessCount <= halfRounds) bonuses.quickGuess = 1;
  }

  totalScore += bonuses.quickGuess;
  return { totalScore, guessCount, isBigWin, bonuses };
};

export interface CCBSetterScore {
  score: number;
  reason: string;
}

/** 出题人得分（普通/同步）。唯一可能为负的计分项。 */
export const calculateCCBSetterScore = ({
  winnerGuesses = "",
  winnerGuessCount = 0,
  bigWinnerScore = 0,
  totalRounds = 10,
}: {
  winnerGuesses?: string;
  winnerGuessCount?: number;
  bigWinnerScore?: number;
  totalRounds?: number;
}): CCBSetterScore => {
  const hasWinner = winnerGuessCount > 0;
  const hasBigWinner = winnerGuesses.includes(CCB_END_MARK.bigWin);

  if (hasBigWinner) {
    return { score: -Math.max(1, Math.floor(bigWinnerScore / 2)), reason: "纯在送分" };
  }
  if (hasWinner) {
    if (winnerGuessCount <= 3) return { score: -1, reason: "太简单了" };
    if (winnerGuessCount > totalRounds / 2) return { score: 1, reason: "难度适中" };
    return { score: 0, reason: "" };
  }
  return { score: -1, reason: "没人猜中" };
};

/** 出题人得分（血战）：按猜中率给分，并乘以 `ceil(参战人数 / 2)`。 */
export const calculateCCBNonstopSetterScore = ({
  hasBigWinner = false,
  bigWinnerScore = 0,
  winnersCount = 0,
  totalPlayersCount = 1,
}: {
  hasBigWinner?: boolean;
  bigWinnerScore?: number;
  winnersCount?: number;
  totalPlayersCount?: number;
}): CCBSetterScore => {
  const totalPlayers = Math.max(1, totalPlayersCount);
  const playerMultiplier = Math.max(1, Math.ceil(totalPlayers / 2));

  if (hasBigWinner) {
    return { score: -Math.max(1, Math.floor(bigWinnerScore / 2)), reason: "纯在送分" };
  }
  if (winnersCount === 0) {
    return { score: -2 * playerMultiplier, reason: "无人猜中" };
  }

  const winRate = winnersCount / totalPlayers;
  if (winRate <= 0.25) return { score: 1 * playerMultiplier, reason: "难度偏高" };
  if (winRate >= 0.75) return { score: 1 * playerMultiplier, reason: "难度偏低" };
  return { score: 2 * playerMultiplier, reason: "难度适中" };
};

/**
 * 结算时按模式挑一套出题人计分口径（原版 `finalizeStandardGame` / `finalizeNonstopGame`）。
 *
 * 两个口径的入参不同，所以这里做的是**选表**而不是重新算分：
 * - 普通 / 同步只看**首个胜者**的标记与次数；
 * - 血战看**猜中率**（胜者数 ÷ 参战人数）。
 *
 * ⚠️ **只在真人出题（`CCBRoundRecord.answerIsManual`）时调用**：服务端出题的房间里
 * 没有任何玩家承担出题人，调用它等于凭空给房主加减分。
 */
export const resolveCCBSetterScore = ({
  mode,
  winnerMarks,
  winnerGuessCount,
  bigWinnerScore,
  winnersCount,
  totalPlayers,
  totalRounds,
}: {
  mode: CCBGameMode;
  /** 首个胜者的标记串；无人猜中传空串。 */
  winnerMarks: string;
  /** **计分口径**的已猜次数（不是 `countCCBAttemptMarks` 的那个数）。 */
  winnerGuessCount: number;
  /** 大赢家的实际总得分（含底分），没有大赢家传 `0`。 */
  bigWinnerScore: number;
  winnersCount: number;
  totalPlayers: number;
  totalRounds: number;
}): CCBSetterScore =>
  mode === "bloodbath"
    ? calculateCCBNonstopSetterScore({
        hasBigWinner: winnerMarks.includes(CCB_END_MARK.bigWin),
        bigWinnerScore,
        winnersCount,
        totalPlayersCount: totalPlayers,
      })
    : calculateCCBSetterScore({
        winnerGuesses: winnerMarks,
        winnerGuessCount,
        bigWinnerScore,
        totalRounds,
      });

// ==================== 次数上限 ====================

export interface CCBAttemptLimitVerdict {
  /** 已用次数是否已达到上限。 */
  exhausted: boolean;
  /** 达到上限时是否应当追加 `💀`（最后一发猜中时不追加）。 */
  shouldApplyDeath: boolean;
  attemptCount: number;
  maxAttempts: number;
}

/**
 * 次数上限判定（`enforceAttemptLimit` 的纯函数部分；标记的写入由服务端负责）。
 *
 * 已结束的实体不再追加；**最后一发猜中不判死**（原版用 `isCorrect` 参数区分，
 * 猜之前的预检固定传 `false`，因此「最后一发猜中」是安全的）。
 */
export const evaluateCCBAttemptLimit = ({
  marks,
  maxAttempts,
  isCorrect = false,
}: {
  marks: string;
  maxAttempts: number;
  isCorrect?: boolean;
}): CCBAttemptLimitVerdict => {
  const attemptCount = countCCBAttemptMarks(marks);
  const limit = Number(maxAttempts) || 10;
  if (attemptCount < limit) {
    return { exhausted: false, shouldApplyDeath: false, attemptCount, maxAttempts: limit };
  }
  if (hasCCBEndMark(marks)) {
    return { exhausted: true, shouldApplyDeath: false, attemptCount, maxAttempts: limit };
  }
  if (isCorrect) {
    return { exhausted: true, shouldApplyDeath: false, attemptCount, maxAttempts: limit };
  }
  return { exhausted: true, shouldApplyDeath: true, attemptCount, maxAttempts: limit };
};

// ==================== 大赢家 / 作品分 ====================

/**
 * 是否是大赢家（`👑`）：**首次猜测即猜中**，或**本命头像就是答案角色**。
 * 不是「唯一猜对」，也不是「第一个猜对」。
 */
export const isCCBBigWin = ({
  marksBeforeGuess,
  avatarId,
  answerId,
}: {
  /** 本次猜测**之前**的标记串（猜中后会再写入 `✔`）。 */
  marksBeforeGuess: string;
  avatarId?: number | null;
  answerId?: number | null;
}): boolean => {
  if (countCCBAttemptMarks(marksBeforeGuess) === 1) return true;
  if (answerId === undefined || answerId === null) return false;
  return avatarId !== undefined && avatarId !== null && Number(avatarId) === Number(answerId);
};

export interface CCBPartialGuessEntry {
  playerId: string;
  username?: string;
  /** 该玩家在**本局猜测历史**里的序号（原版是全局下标，只在同一玩家内比较先后）。 */
  index: number;
  team?: string | null;
  isAnswerSetter?: boolean;
  /** 猜错但猜的角色与答案有共同作品。 */
  isPartialCorrect: boolean;
  isCorrect: boolean;
}

/**
 * 作品分的获奖者：**每个队伍/单人只取最早出现的那一次** `💡`，
 * 同序号用**用户名升序**破平；出题人与旁观者排除。
 * 注意调用方还要排除本局胜者（原版在加分处才排除）。
 */
export const computeCCBPartialAwardees = (entries: CCBPartialGuessEntry[]): Set<string> => {
  const firstIndexByPlayer = new Map<string, number>();
  for (const entry of entries) {
    if (!entry || !entry.playerId) continue;
    if (!entry.isPartialCorrect || entry.isCorrect) continue;
    if (!firstIndexByPlayer.has(entry.playerId)) firstIndexByPlayer.set(entry.playerId, entry.index);
  }

  const byPlayer = new Map(entries.map((entry) => [entry.playerId, entry]));
  const bestByGroup = new Map<string, { playerId: string; index: number; username: string }>();
  for (const [playerId, index] of firstIndexByPlayer) {
    const entry = byPlayer.get(playerId);
    if (!entry) continue;
    if (entry.isAnswerSetter) continue;
    if (entry.team === "0") continue;
    const groupKey = entry.team ? `team:${entry.team}` : `solo:${playerId}`;
    const username = String(entry.username ?? "");
    const current = bestByGroup.get(groupKey);
    if (!current || index < current.index || (index === current.index && username.localeCompare(current.username) < 0)) {
      bestByGroup.set(groupKey, { playerId, index, username });
    }
  }
  return new Set([...bestByGroup.values()].map((value) => value.playerId));
};
