import { NOOP_GAME_RECORDER, type GameRecordEvent } from "../../domain/GameRecord";
import type { GameRound, RoundSummary, WhoIsFakerRoomRecord } from "../../shared/Index";
import type { WhoIsFakerContext } from "./Context";

/** 结算快照转成对局记录：摘要放胜负与词对，时间线按时间合并发言与全局历史。 */
export const recordRound = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  summary: RoundSummary
) => {
  const startedAt = ctx.roundStartedAtById.get(round.id) ?? ctx.now();
  ctx.roundStartedAtById.delete(round.id);
  const deltas = new Map(summary.awardedScores.map((item) => [item.playerId, item.delta]));
  const nameOf = (playerId: string) => room.players[playerId]?.name ?? playerId;
  const timeline: GameRecordEvent[] = [
    ...summary.descriptions.map((item) => ({
      at: item.createdAt,
      type: "description",
      playerId: item.playerId,
      name: item.playerName,
      kind: item.kind,
      text: item.text,
    })),
    ...(summary.history ?? []).map((entry): GameRecordEvent => {
      switch (entry.kind) {
        case "vote":
          return {
            at: entry.createdAt,
            type: "vote",
            day: entry.day,
            tieBreak: entry.tieBreak ?? false,
            votes: entry.votes.map((vote) => ({ ...vote })),
            eliminated: entry.eliminatedPlayerIds.map(nameOf),
          };
        case "night":
          return {
            at: entry.createdAt,
            type: "night",
            day: entry.day,
            actions: entry.actions.map((action) => ({ ...action })),
            eliminated: entry.eliminatedPlayerIds.map(nameOf),
          };
        case "blankGuess":
          return {
            at: entry.createdAt,
            type: "blankGuess",
            day: entry.day,
            name: nameOf(entry.playerId),
            guessedWords: [...entry.guessedWords],
            success: entry.success,
          };
        case "removal":
          return {
            at: entry.createdAt,
            type: "removal",
            day: entry.day,
            name: nameOf(entry.playerId),
            reason: entry.reason,
          };
      }
    }),
  ].sort((left, right) => left.at - right.at);
  (ctx.options.gameRecorder ?? NOOP_GAME_RECORDER).record({
    game: "faker",
    roomId: room.id,
    roomCreatedAt: room.createdAt,
    roundNumber: room.roundCount ?? 1,
    startedAt,
    endedAt: ctx.now(),
    players: Object.keys(round.assignments).flatMap((playerId) => {
      const player = room.players[playerId];
      return player
        ? [
            {
              playerId,
              userId: player.account?.userId ?? null,
              name: player.name,
              score: deltas.get(playerId) ?? 0,
            },
          ]
        : [];
    }),
    summary: {
      winner: summary.winner,
      reason: summary.reason,
      words: summary.words ?? null,
      questioner: round.questionerPlayerId ? nameOf(round.questionerPlayerId) : null,
      roles: summary.revealedRoles.map((item) => ({
        name: nameOf(item.playerId),
        role: item.role,
      })),
      days: round.day,
    },
    timeline,
  });
};
