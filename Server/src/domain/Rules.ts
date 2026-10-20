import { timingSafeEqual } from "node:crypto";

import { AppError } from "./Errors";
import {
  ABSTAIN_TARGET_ID,
  ROOM_ID_TEST_MODE,
  isValidRoomId,
  type BlankGuessRecord,
  type GameRound,
  type NightActionRecord,
  type WhoIsFakerRole,
  type PlayerSide,
  type RoleConfig,
  type RoleLimits,
  type WhoIsFakerRoomRecord,
  type RoundPlayerState,
  type RoundWinner,
  type VoteRecord,
} from "../shared/Index";

// ==================== 纯规则函数 ====================

export interface RandomSource {
  nextInt(maxExclusive: number): number;
}

// 默认配置保证最小可玩版本：1 卧底，无天使、无白板。
export const createDefaultRoleConfig = (): RoleConfig => ({
  undercoverCount: 1,
  hasAngel: false,
  hasBlank: false,
});

export const getRoomRoleLimits = (playerCount: number): RoleLimits => ({
  // 上限随参与人数动态伸缩。不足 4 人时上限退回 1，保留编辑能力；
  // 游戏本身在人数检查阶段会阻止少于 4 人时开局。
  maxUndercoverCount: Math.max(1, Math.ceil(playerCount / 4)),
  canEnableAngel: playerCount >= 8,
  canEnableBlank: playerCount >= 8,
});

/**
 * 剥离控制字符与零宽字符：换行、\x00、零宽空格之类会让 UI 出现伪冒
 * 与换行错乱（渲染层已转义，不构成 XSS，但会让"看起来不同的名字"其实相同）。
 */
const stripControlChars = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  value.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]/g, "");

// 用户名只做轻量修剪，唯一性由房间层保证。
export const normalizeName = (value: string): string => stripControlChars(value).trim();

// 词语和自由文本统一做空白折叠，避免“看起来不同、实际上相同”的输入。
export const normalizeWord = (value: string): string =>
  stripControlChars(value).trim().replace(/\s+/g, " ");

// 词对的唯一归一口径：规范化 + 字典序排序，正式提交与白板草稿判定共用，
// 排序结果直接决定「猜中与否」的比对。排序不影响「为空」与「两词相同」两条校验，
// 所以先排后验与先验后排等价。
const normalizedWordPair = (values: [string, string]): [string, string] => {
  const normalized = [normalizeWord(values[0]), normalizeWord(values[1])];
  return normalized.sort((left, right) => left.localeCompare(right)) as [string, string];
};

export const normalizeWordPair = (values: [string, string]): [string, string] => {
  const normalized = normalizedWordPair(values);

  if (!normalized[0] || !normalized[1]) {
    throw new AppError("INVALID_WORD_PAIR", "词语不能为空");
  }

  if (normalized[0] === normalized[1]) {
    throw new AppError("INVALID_WORD_PAIR", "两个词语不能相同");
  }

  return normalized;
};

/**
 * 阵营配置违反的第一条人数约束；`undefined` 表示全部满足。
 *
 * 判定（席位是否可开）与校验（开局前报错）走同一份推导：人数上限一变，
 * 两条路径必须同步，否则会出现「判定放行、校验拒绝」的分裂结论。
 */
const findRoleConfigViolation = (
  config: RoleConfig,
  playerCount: number
): { message: string; details?: Record<string, number> } | undefined => {
  const limits = getRoomRoleLimits(playerCount);
  const specialCount =
    config.undercoverCount + (config.hasAngel ? 1 : 0) + (config.hasBlank ? 1 : 0);

  if (
    config.undercoverCount < 1 ||
    limits.maxUndercoverCount < 1 ||
    config.undercoverCount > limits.maxUndercoverCount
  ) {
    return {
      message: "卧底人数不在允许范围内",
      details: { maxUndercoverCount: limits.maxUndercoverCount },
    };
  }

  if (config.hasAngel && !limits.canEnableAngel) {
    return { message: "当前人数不足以开启天使" };
  }

  if (config.hasBlank && !limits.canEnableBlank) {
    return { message: "当前人数不足以开启白板" };
  }

  if (playerCount - specialCount < 1) {
    return { message: "至少需要保留一名平民" };
  }

  return undefined;
};

// 纯规则谓词：判断阵营配置是否满足当前人数约束，无异常与副作用。
export const isRoleConfigSatisfied = (config: RoleConfig, playerCount: number): boolean =>
  findRoleConfigViolation(config, playerCount) === undefined;

// 校验阵营配置是否符合当前人数约束。若不符合则抛出精准业务错误。测试房间与真实房间同规则。
export const validateRoleConfig = (config: RoleConfig, playerCount: number): void => {
  const violation = findRoleConfigViolation(config, playerCount);
  if (!violation) return;
  throw new AppError("INVALID_ROLE_CONFIG", violation.message, violation.details);
};

export const listPlayablePlayerIds = (room: WhoIsFakerRoomRecord): string[] =>
  Object.values(room.players)
    .filter((player) => player.membership === "active")
    .map((player) => player.id);

// 统一洗牌实现，便于在测试里注入可预测随机源。
export const shuffle = <T>(items: T[], random: RandomSource): T[] => {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = random.nextInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }

  return result;
};

/** 本局的词对映射：随机打乱后的平民词与卧底词。 */
interface RoundWords {
  civilianWord: string;
  undercoverWord: string;
}

/** 一次身份分配的输入：参赛玩家、阵营配置、本局词对与随机源。 */
interface RoleAssignmentInput {
  playerIds: string[];
  config: RoleConfig;
  words: RoundWords;
  random: RandomSource;
}

/** 手动指定身份的阵营与词条：白板不带词，卧底拿卧底词，其余按平民词。 */
const toManualRoleState = (role: WhoIsFakerRole, words: RoundWords): RoundPlayerState => {
  const side: PlayerSide =
    role === "undercover" ? "undercover" : role === "blank" ? "blank" : "good";
  const word =
    role === "blank"
      ? undefined
      : role === "undercover"
        ? words.undercoverWord
        : words.civilianWord;

  return { role, side, word, alive: true };
};

/** 按出题人指定的身份发牌：先校验每名参赛玩家都有身份，再校验身份数量与本局配置一致。 */
const assignManualRoles = (
  input: RoleAssignmentInput,
  manualRoles: Record<string, WhoIsFakerRole>
): Record<string, RoundPlayerState> => {
  const { playerIds, config, words } = input;

  for (const pid of playerIds) {
    if (!manualRoles[pid]) {
      throw new AppError("INVALID_MANUAL_ROLES", "部分参赛玩家未指定身份");
    }
  }

  const roles = playerIds.map((pid) => manualRoles[pid]);
  const undercoverCount = roles.filter((r) => r === "undercover").length;
  const angelCount = roles.filter((r) => r === "angel").length;
  const blankCount = roles.filter((r) => r === "blank").length;

  const expectedAngelCount = config.hasAngel ? 1 : 0;
  const expectedBlankCount = config.hasBlank ? 1 : 0;

  if (
    undercoverCount !== config.undercoverCount ||
    angelCount !== expectedAngelCount ||
    blankCount !== expectedBlankCount
  ) {
    throw new AppError("INVALID_MANUAL_ROLES", "指定身份数量与当前局配置不符");
  }

  const assignments: Record<string, RoundPlayerState> = {};

  for (const pid of playerIds) {
    assignments[pid] = toManualRoleState(manualRoles[pid], words);
  }

  return assignments;
};

/** 随机发牌：洗牌后依次取白板、天使、卧底名额，剩余玩家为平民。 */
const assignShuffledRoles = (input: RoleAssignmentInput): Record<string, RoundPlayerState> => {
  const { playerIds, config, words, random } = input;
  const assignments: Record<string, RoundPlayerState> = {};
  const shuffledPlayers = shuffle(playerIds, random);
  let cursor = 0;

  if (config.hasBlank) {
    const playerId = shuffledPlayers[cursor];
    assignments[playerId] = {
      role: "blank",
      side: "blank",
      alive: true,
    };
    cursor += 1;
  }

  if (config.hasAngel) {
    const playerId = shuffledPlayers[cursor];
    assignments[playerId] = {
      role: "angel",
      side: "good",
      word: words.civilianWord,
      alive: true,
    };
    cursor += 1;
  }

  for (let index = 0; index < config.undercoverCount; index += 1) {
    const playerId = shuffledPlayers[cursor];
    assignments[playerId] = {
      role: "undercover",
      side: "undercover",
      word: words.undercoverWord,
      alive: true,
    };
    cursor += 1;
  }

  for (; cursor < shuffledPlayers.length; cursor += 1) {
    const playerId = shuffledPlayers[cursor];
    assignments[playerId] = {
      role: "civilian",
      side: "good",
      word: words.civilianWord,
      alive: true,
    };
  }

  return assignments;
};

export const assignRoles = (
  playerIds: string[],
  config: RoleConfig,
  pair: [string, string],
  blankHint: string | undefined,
  random: RandomSource,
  manualRoles?: Record<string, WhoIsFakerRole>
): {
  civilianWord: string;
  undercoverWord: string;
  assignments: Record<string, RoundPlayerState>;
  pair: [string, string];
} => {
  // 出题人提交的是无序词对，真正的“平民词/卧底词”映射由服务端临时决定。
  const normalizedPair = normalizeWordPair(pair);
  const shuffledWords = shuffle([...normalizedPair], random);
  const [civilianWord, undercoverWord] = shuffledWords;
  const input: RoleAssignmentInput = {
    playerIds,
    config,
    words: { civilianWord, undercoverWord },
    random,
  };
  // 手动指定身份不消耗随机源，随机发牌在词对之后洗牌。
  const assignments = manualRoles
    ? assignManualRoles(input, manualRoles)
    : assignShuffledRoles(input);

  if (blankHint) {
    const normalizedHint = normalizeWord(blankHint);

    if (!normalizedHint) {
      throw new AppError("INVALID_BLANK_HINT", "白板提示不能为空字符串");
    }
  }

  return {
    civilianWord,
    undercoverWord,
    assignments,
    pair: normalizedPair,
  };
};

export const computeVoteOutcome = (votes: VoteRecord[]) => {
  // 这里不直接决定出局逻辑，只负责统计票型与最高票候选。
  const voteCounter = new Map<string, number>();

  for (const vote of votes) {
    voteCounter.set(vote.targetId, (voteCounter.get(vote.targetId) ?? 0) + 1);
  }

  const abstainCount = voteCounter.get(ABSTAIN_TARGET_ID) ?? 0;
  const playerEntries = [...voteCounter.entries()].filter(
    ([playerId]) => playerId !== ABSTAIN_TARGET_ID
  );
  const maxVotes = Math.max(...playerEntries.map(([, count]) => count), 0);
  const leaders =
    maxVotes > 0
      ? playerEntries
          .filter(([, count]) => count === maxVotes)
          .map(([playerId]) => playerId)
          .sort()
      : [];

  return {
    maxVotes,
    abstainCount,
    leaders,
    counts: Object.fromEntries(voteCounter),
  };
};

export const resolveNightEliminations = (
  round: GameRound,
  actions: NightActionRecord[]
): string[] => {
  // 规则按 Project.md 直译：
  // 1. 选择“刀人”的平民自己出局
  // 2. 被卧底刀中的目标出局
  const eliminatedIds = new Set<string>();

  for (const action of actions) {
    if (action.actorRole === "civilian" && action.targetId) {
      eliminatedIds.add(action.actorId);
    }

    if (action.actorRole === "undercover" && action.targetId) {
      eliminatedIds.add(action.targetId);
    }
  }

  return [...eliminatedIds];
};

export const recordEliminations = (
  assignments: Record<string, RoundPlayerState>,
  playerIds: string[],
  reason: string,
  occurredAt: number
): void => {
  // 统一淘汰入口，避免每个阶段重复写状态变更。
  for (const playerId of playerIds) {
    const state = assignments[playerId];

    if (!state || !state.alive) {
      continue;
    }

    state.alive = false;
    state.eliminatedAt = occurredAt;
    state.eliminatedReason = reason;
  }
};

export const getAliveCounts = (assignments: Record<string, RoundPlayerState>) => {
  let good = 0;
  let undercover = 0;
  let blank = 0;

  for (const state of Object.values(assignments)) {
    if (!state.alive) {
      continue;
    }

    if (state.side === "good") {
      good += 1;
    } else if (state.side === "undercover") {
      undercover += 1;
    } else {
      blank += 1;
    }
  }

  return { good, undercover, blank };
};

// 白板玩家在一局里最多一个，这里返回其玩家 ID。
export const getBlankPlayerId = (assignments: Record<string, RoundPlayerState>) =>
  Object.entries(assignments).find(([, state]) => state.role === "blank")?.[0];

// 白板猜错后，再按好人/卧底常规胜负条件结算。
export const getWinnerAfterBlankFailure = (
  assignments: Record<string, RoundPlayerState>
): Exclude<RoundWinner, "blank" | "aborted"> | undefined => {
  const alive = getAliveCounts(assignments);

  if (alive.undercover === 0) {
    return "good";
  }

  if (alive.undercover >= alive.good) {
    return "undercover";
  }

  return undefined;
};

export const shouldEnterFinalBlankGuess = (
  round: GameRound
): {
  shouldGuess: boolean;
  deferredWinner?: Exclude<RoundWinner, "blank" | "aborted">;
  blankPlayerId?: string;
} => {
  // 只要白板仍存活，且局面已经满足常规结束条件，就先补一次白板猜词。
  const blankPlayerId = getBlankPlayerId(round.assignments);

  if (!blankPlayerId || round.blankGuessUsed) {
    return { shouldGuess: false };
  }

  const blankState = round.assignments[blankPlayerId];

  if (!blankState.alive) {
    return { shouldGuess: false };
  }

  const deferredWinner = getWinnerAfterBlankFailure(round.assignments);

  if (!deferredWinner) {
    return { shouldGuess: false };
  }

  return {
    shouldGuess: true,
    deferredWinner,
    blankPlayerId,
  };
};

export const evaluateBlankGuess = (
  round: GameRound,
  guess: [string, string],
  createdAt: number,
  reason: BlankGuessRecord["reason"]
): BlankGuessRecord => {
  return evaluateBlankGuessDraft(round, normalizeWordPair(guess), createdAt, reason);
};

// 草稿允许空词、同词及尚未完成的输入；到期必须得到确定的失败记录，而非抛出词对校验错误。
// 正式提交仍由 evaluateBlankGuess 严格校验。
export const evaluateBlankGuessDraft = (
  round: GameRound,
  guess: [string, string],
  createdAt: number,
  reason: BlankGuessRecord["reason"]
): BlankGuessRecord => {
  const normalizedGuess = normalizedWordPair(guess);
  const roundWords = round.words;
  const validPair =
    Boolean(normalizedGuess[0] && normalizedGuess[1]) && normalizedGuess[0] !== normalizedGuess[1];
  const success =
    roundWords && validPair
      ? normalizedGuess[0] === roundWords.pair[0] && normalizedGuess[1] === roundWords.pair[1]
      : false;
  const playerId = round.blankGuessContext?.playerId ?? getBlankPlayerId(round.assignments) ?? "";

  if (!playerId) {
    throw new AppError("BLANK_NOT_FOUND", "当前没有白板玩家");
  }

  return {
    playerId,
    guessedWords: normalizedGuess,
    success,
    createdAt,
    reason,
  };
};

/**
 * 会话令牌的常量时间比较。
 *
 * 令牌本身是 128bit 随机值，实际被爆破的成本极高；这里补上常量时间比较
 * 是为了不留下"逐字节提前返回"这类可被计时侧信道利用的写法。
 */
export const safeEqualToken = (left?: string, right?: string): boolean => {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    left.length === 0 ||
    right.length === 0
  ) {
    return left === right;
  }
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) {
    timingSafeEqual(leftBytes, leftBytes);
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
};

export const ensureRoomId = (roomId: string): string => {
  // 校验规则来自 shared 的 isValidRoomId，客户端路由用的是同一份。
  const normalized = roomId.trim();

  if (normalized.toLowerCase() === ROOM_ID_TEST_MODE.toLowerCase()) {
    return ROOM_ID_TEST_MODE;
  }

  if (!isValidRoomId(normalized)) {
    throw new AppError("INVALID_ROOM_ID", "房间号必须为四位数字");
  }

  return normalized;
};
