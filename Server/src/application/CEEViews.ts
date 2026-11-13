import type {
  CEEGuess,
  CEEPrivateState,
  CEERoomSnapshot,
  CEERoomSummary,
  CEESpectateRequest,
} from "../shared/CEE";
import {
  type CEEPlayerRecord,
  type CEERoom,
  type CEERound,
  type CEEUnit,
} from "../domain/CEEModel";
import { bannedCharacterIdsFor, maskGuessTags } from "../domain/CEEPickRules";
import type { TestRoomPolicy } from "../domain/TestRooms";
import { canSeeRoundSecrets } from "../domain/Visibility";
import {
  canStartCEERound,
  ceeSetsRound,
  ceeImageHintAvailability,
  ceeRemainingAttempts,
  ceeSetterCandidates,
  getCEEUnit,
} from "../domain/CEERound";
import { isCEEAntiCheatRoom } from "../shared/Index";

/** 大厅人数与其它游戏同口径：只计在线成员，参与与旁观分开统计。 */
export function ceeRoomSummary(room: CEERoom): CEERoomSummary {
  const online = [...room.players.values()].filter((player) => player.online);
  return {
    roomId: room.id,
    source: "native",
    name: room.name,
    phase: room.phase,
    playerCount: online.filter((player) => player.membership === "active").length,
    spectatorCount: online.filter((player) => player.membership === "spectator").length,
    hasPassword: Boolean(room.passwordHash),
    allowSpectators: room.allowSpectators,
    bakaAntiCheat: isCEEAntiCheatRoom(room.settings),
    allowAgents: room.settings.allowAgents === true,
  };
}
/** 待批准请求按发起时间升序，房主端才能稳定地从上往下处理。 */
function ceeSpectateRequests(room: CEERoom): CEESpectateRequest[] {
  if (!isCEEAntiCheatRoom(room.settings)) return [];
  return [...room.spectatorRequests.entries()]
    .map(([playerId, requestedAt]) => ({
      playerId,
      name: room.players.get(playerId)?.name ?? "",
      requestedAt,
    }))
    .filter((request) => request.name)
    .sort((a, b) => a.requestedAt - b.requestedAt);
}
export function ceeSnapshot(
  room: CEERoom,
  isMcpControlled?: (playerId: string) => boolean
): CEERoomSnapshot {
  return {
    roomId: room.id,
    source: "native",
    name: room.name,
    visibility: room.visibility,
    hasPassword: Boolean(room.passwordHash),
    allowSpectators: room.allowSpectators,
    bakaAntiCheat: isCEEAntiCheatRoom(room.settings),
    hostPlayerId: room.hostPlayerId,
    phase: room.phase,
    settings: room.settings,
    roundNumber: room.roundNumber,
    syncRound: room.round?.syncRound ?? 0,
    setterPlayerId: room.setterPlayerId,
    phaseDeadlineAt: room.phaseDeadlineAt,
    chat: room.chat,
    roundSummary: room.summary,
    upstreamConnected: true,
    spectateRequests: ceeSpectateRequests(room),
    players: [...room.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      online: player.online,
      ready: player.ready,
      team: player.team,
      membership: player.membership,
      score: player.score,
      status: player.status,
      attempts: player.attempts,
      marks: player.marks,
      syncCompleted: player.syncCompleted,
      ...(player.isAgent ? { isAgent: true } : {}),
      ...(isMcpControlled?.(player.id) ? { mcpControlled: true } : {}),
      account: player.account,
    })),
  };
}
function visibleGuesses(room: CEERoom, player: CEEPlayerRecord, observing: boolean): CEEGuess[] {
  const round = room.round;
  if (!round) return [];
  const unit = getCEEUnit(room, player);
  return round.guesses
    .filter((guess) => observing || unit?.memberIds.includes(guess.playerId))
    .map((guess) =>
      maskGuessTags(guess, (tagText) => {
        const owners = round.tagOwners.get(tagText);
        return !observing && room.phase !== "settled" && Boolean(owners && !owners.has(player.id));
      })
    );
}
/** 是否还能提交猜测：本局未结束，同步模式下还需等本轮完成。 */
function canSubmitCEEGuess(round: CEERound, unit: CEEUnit): boolean {
  return !unit.ended && (!round.settings.syncMode || !unit.completed);
}
/** 全局 BP 下该玩家视角的禁用角色编号：规则本体在 CEEPickRules，这里只把房间设置换成判定上下文。 */
function bannedIdsOf(round: CEERound | null, player: CEEPlayerRecord): number[] {
  if (!round) return [];
  return bannedCharacterIdsFor(round.guesses, {
    playerId: player.id,
    globalPick: round.settings.globalPick,
    syncMode: round.settings.syncMode,
    nonstopMode: round.settings.nonstopMode,
    syncRound: round.syncRound,
  });
}
/** 待批准旁观者的私有状态：只说得出「在等批准」，其余全部为空。 */
function emptyCEEPrivateState(player: CEEPlayerRecord, spectatePending: boolean): CEEPrivateState {
  return {
    playerId: player.id,
    canGuess: false,
    canSurrender: false,
    canStart: false,
    canSetAnswer: false,
    setterCandidateIds: [],
    guesses: [],
    answer: null,
    hints: [],
    imageHintAvailable: false,
    imageHintLevel: 0,
    deadlineAt: null,
    bannedCharacterIds: [],
    spectatePending,
  };
}
export function ceePrivateState(
  room: CEERoom,
  player: CEEPlayerRecord,
  testRooms: TestRoomPolicy
): CEEPrivateState {
  const round = room.round;
  const spectatePending = player.membership === "pendingSpectator";
  // 待批准旁观按「尚未入房」处理：私有状态整体清空，否则请求者能提前看到答案与全场猜测。
  if (spectatePending) return emptyCEEPrivateState(player, true);
  const unit = getCEEUnit(room, player);
  const observing = room.phase === "settled" || player.status !== "playing";
  // 答完的正式玩家（猜中、用尽、认输）与出题一方照旧看得到答案；本局不在参与名单里的人
  // （旁观者、中途加入者、开局时不在线者）是旁观位：局中是否可见由房间开关决定，揭晓后恒可见。
  const bystander =
    Boolean(round) && !ceeSetsRound(room, player) && !round!.participants.includes(player.id);
  const seesSecrets =
    observing &&
    (!bystander ||
      canSeeRoundSecrets(
        { setsRound: false, spectator: true },
        room.phase === "guessing",
        room.settings.spectatorsSeeAnswers ?? false
      ));
  const remaining = ceeRemainingAttempts(round, unit);
  const inGame = room.phase === "guessing" && Boolean(unit) && player.status === "playing";
  const canGuess = inGame && Boolean(round && unit && canSubmitCEEGuess(round, unit));
  const isHost = player.id === room.hostPlayerId;
  const imageHint = ceeImageHintAvailability(room, player);
  return {
    playerId: player.id,
    canGuess,
    canSurrender: inGame && !unit!.ended,
    // 随机出题在等待阶段需其他参与者准备（结算阶段再来一轮直接沿用在线参与者）；
    // 手动出题开始后先进入选人阶段，出题人不必准备，有可选的出题人即可。
    // 单人不能开局，只有测试房允许房主一个人试玩。
    canStart: canStartCEERound(room, player, testRooms),
    canSetAnswer: room.phase === "answering" && player.id === room.setterPlayerId,
    setterCandidateIds:
      room.phase === "choosingSetter" && isHost
        ? ceeSetterCandidates(room).map((candidate) => candidate.id)
        : [],
    guesses: visibleGuesses(room, player, seesSecrets),
    answer: round && seesSecrets ? round.answer : null,
    hints:
      round && inGame
        ? round.hints.filter(
            (_, index) =>
              round.settings.useHints[index]! > 0 && remaining <= round.settings.useHints[index]!
          )
        : [],
    imageHintAvailable: imageHint.available,
    imageHintLevel: imageHint.level,
    deadlineAt: canGuess ? unit!.deadlineAt : null,
    // 旁观位不能猜测，禁选名单对他只会泄漏他人猜过什么。
    bannedCharacterIds: bystander && !seesSecrets ? [] : bannedIdsOf(round, player),
    spectatePending: false,
  };
}
