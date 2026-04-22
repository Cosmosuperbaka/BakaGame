import { AppError } from "./errors";
import {
  ROOM_ID_TEST_MODE,
  type BlankGuessRecord,
  type GameRound,
  type NightActionRecord,
  type RoleConfig,
  type RoleLimits,
  type RoomRecord,
  type RoundPlayerState,
  type RoundWinner,
  type VoteRecord,
} from "./model";

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
  // 上限随参与人数动态伸缩；当人数不足时 max 退回 0，UI 据此禁用编辑。
  maxUndercoverCount: playerCount >= 4 ? Math.max(1, Math.floor(playerCount / 4)) : 0,
  canEnableAngel: playerCount >= 10,
  canEnableBlank: playerCount >= 8,
});

// 用户名只做轻量修剪，唯一性由房间层保证。
export const normalizeName = (value: string): string => value.trim();

// 词语和自由文本统一做空白折叠，避免“看起来不同、实际上相同”的输入。
export const normalizeWord = (value: string): string =>
  value
    .trim()
    .replace(/\s+/g, " ");

export const normalizeWordPair = (values: [string, string]): [string, string] => {
  const normalized = values.map(normalizeWord) as [string, string];

  if (!normalized[0] || !normalized[1]) {
    throw new AppError("INVALID_WORD_PAIR", "词语不能为空");
  }

  if (normalized[0] === normalized[1]) {
    throw new AppError("INVALID_WORD_PAIR", "两个词语不能相同");
  }

  return [...normalized].sort((left, right) => left.localeCompare(right)) as [
    string,
    string,
  ];
};

// 校验阵营配置是否符合当前人数和测试模式约束。
export const validateRoleConfig = (
  config: RoleConfig,
  playerCount: number,
  testMode: boolean,
): void => {
  const limits = getRoomRoleLimits(playerCount);
  const specialCount =
    config.undercoverCount + (config.hasAngel ? 1 : 0) + (config.hasBlank ? 1 : 0);
  const civilianCount = playerCount - specialCount;

  if (
    config.undercoverCount < 1 ||
    limits.maxUndercoverCount < 1 ||
    config.undercoverCount > limits.maxUndercoverCount
  ) {
    throw new AppError("INVALID_ROLE_CONFIG", "卧底人数不在允许范围内", {
      maxUndercoverCount: limits.maxUndercoverCount,
    });
  }

  if (config.hasAngel && !limits.canEnableAngel) {
    throw new AppError("INVALID_ROLE_CONFIG", "当前人数不足以开启天使");
  }

  if (config.hasBlank && !limits.canEnableBlank) {
    throw new AppError("INVALID_ROLE_CONFIG", "当前人数不足以开启白板");
  }

  if (!testMode && civilianCount < 1) {
    throw new AppError("INVALID_ROLE_CONFIG", "至少需要保留一名平民");
  }
};

export const listPlayablePlayerIds = (room: RoomRecord): string[] =>
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

export const assignRoles = (
  playerIds: string[],
  config: RoleConfig,
  pair: [string, string],
  blankHint: string | undefined,
  random: RandomSource,
): {
  civilianWord: string;
  undercoverWord: string;
  assignments: Record<string, RoundPlayerState>;
  pair: [string, string];
} => {
  // 出题人提交的是无序词对，真正的“平民词/卧底词”映射由服务端临时决定。
  const normalizedPair = normalizeWordPair(pair);
  const shuffledWords = shuffle([...normalizedPair], random);
  const shuffledPlayers = shuffle(playerIds, random);
  const assignments: Record<string, RoundPlayerState> = {};

  const [civilianWord, undercoverWord] = shuffledWords;
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
      word: civilianWord,
      alive: true,
    };
    cursor += 1;
  }

  for (let index = 0; index < config.undercoverCount; index += 1) {
    const playerId = shuffledPlayers[cursor];
    assignments[playerId] = {
      role: "undercover",
      side: "undercover",
      word: undercoverWord,
      alive: true,
    };
    cursor += 1;
  }

  for (; cursor < shuffledPlayers.length; cursor += 1) {
    const playerId = shuffledPlayers[cursor];
    assignments[playerId] = {
      role: "civilian",
      side: "good",
      word: civilianWord,
      alive: true,
    };
  }

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

  const maxVotes = Math.max(...voteCounter.values(), 0);
  const leaders = [...voteCounter.entries()]
    .filter(([, count]) => count === maxVotes)
    .map(([playerId]) => playerId)
    .sort();

  return {
    maxVotes,
    leaders,
    counts: Object.fromEntries(voteCounter),
  };
};

export const resolveNightEliminations = (
  round: GameRound,
  actions: NightActionRecord[],
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
  occurredAt: number,
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
  assignments: Record<string, RoundPlayerState>,
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
  round: GameRound,
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
  reason: BlankGuessRecord["reason"],
): BlankGuessRecord => {
  // 白板猜词永远按“词对本身”判断，不要求前端传入固定顺序。
  const normalizedGuess = normalizeWordPair(guess);
  const roundWords = round.words;
  const success = roundWords
    ? normalizedGuess[0] === roundWords.pair[0] &&
      normalizedGuess[1] === roundWords.pair[1]
    : false;
  const playerId =
    round.blankGuessContext?.playerId ?? getBlankPlayerId(round.assignments) ?? "";

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

export const ensureRoomId = (roomId: string): string => {
  // 普通房间号要求四位数字，测试模式放行特殊字符串（大小写不敏感）。
  const normalized = roomId.trim();

  if (normalized.toLowerCase() === ROOM_ID_TEST_MODE.toLowerCase()) {
    return ROOM_ID_TEST_MODE;
  }

  if (!/^\d{4}$/.test(normalized)) {
    throw new AppError("INVALID_ROOM_ID", "房间号必须为四位数字");
  }

  return normalized;
};
