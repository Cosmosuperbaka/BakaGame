import type { SonGuessrContext } from "./Context";
import type {
  SonGuessrPlayerRecord,
  SonGuessrRoomRecord,
  SonGuessrRoundPlayerState,
} from "./Records";
import { activePlayers, canTestSubmitterGuess, isTestRoom } from "./RoomAccess";

/** 出题人的队友：他出题时连同他一起观战的在队玩家。 */
export const teammateIds = (room: SonGuessrRoomRecord, submitterId: string): string[] => {
  const team = room.players[submitterId]?.team ?? null;
  if (team === null) return [];
  return activePlayers(room)
    .filter((candidate) => candidate.id !== submitterId && candidate.team === team)
    .map((candidate) => candidate.id);
};

/**
 * 可以担任出题人的玩家：在线真人，且他出题后（连同队友一起观战）还留得下在线的猜歌玩家。
 * 测试房的出题人自己也能猜，只看前一条。
 */
export const submitterCandidates = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord
): SonGuessrPlayerRecord[] => {
  const testRoom = isTestRoom(ctx, room);
  return Object.values(room.players).filter((candidate) => {
    if (!candidate.online || candidate.membership === "kicked" || candidate.isBot) return false;
    if (testRoom) return true;
    const observers = new Set([candidate.id, ...teammateIds(room, candidate.id)]);
    return activePlayers(room).some((player) => player.online && !observers.has(player.id));
  });
};

/**
 * 保证处于进行中回合的正式非出题玩家持有合法的回合状态（自愈机制）。
 * 覆盖场景：切轮瞬间短暂断线、重连或状态异步，杜绝玩家缺失回合状态被误判为操作完成。
 */
export const ensureRoundPlayerState = (
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  player: SonGuessrPlayerRecord
): SonGuessrRoundPlayerState | undefined => {
  if (room.phase !== "playing" || !room.currentRound) return undefined;
  const round = room.currentRound;
  if (player.membership !== "active") return undefined;
  if (player.id === round.submitterPlayerId && !canTestSubmitterGuess(ctx, room, player.id)) {
    return undefined;
  }
  if (round.observerIds.includes(player.id)) return undefined;
  let state = round.players[player.id];
  if (!state) {
    // 有队伍时并回队友那一份，不另起一套次数。
    const teammate =
      player.team === null
        ? undefined
        : Object.entries(round.players).find(
            ([id]) =>
              id !== round.submitterPlayerId &&
              room.players[id]?.team === player.team &&
              !room.players[id]?.isBot
          );
    state = teammate?.[1] ?? {
      memberIds: [],
      guessesUsed: 0,
      correct: false,
      gaveUp: false,
      deadlineAt: undefined,
    };
    state.memberIds.push(player.id);
    round.players[player.id] = state;
    round.audioReady[player.id] ??= false;
  }
  return state;
};

/** 清空逐轮结果。标记只描述当前这一轮，换轮与回到等待时都不该留下上一轮的结局。 */
export const clearRoundMarks = (room: SonGuessrRoomRecord): void => {
  for (const player of Object.values(room.players)) player.roundMarks = [];
};
