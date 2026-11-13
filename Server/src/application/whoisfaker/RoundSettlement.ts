import { PHASE_RESULT_DISPLAY_MS } from "../../config/Constants";
import type {
  GameRound,
  RoundSummary,
  RoundWinner,
  WhoIsFakerRoomRecord,
} from "../../shared/Index";
import { clearPhaseTimer } from "./PhaseTimers";
import { publishRoom } from "./RoomPublish";
import { recordRound } from "./RoundRecording";
import { requireRound } from "./RoomAccess";
import type { WhoIsFakerContext } from "./Context";

/** 结算给分：白板阵营猜中得 2 分，好人与卧底阵营各自获胜得 1 分。 */
const roundScoreDelta = (
  winner: RoundWinner,
  side: GameRound["assignments"][string]["side"]
): number => {
  if (winner === "blank") return side === "blank" ? 2 : 0;
  if (winner === "good") return side === "good" ? 1 : 0;
  return side === "undercover" ? 1 : 0;
};

/** 当局词对进摘要；未发词的局（如中途放弃）留空。 */
const summarizeRoundWords = (words: GameRound["words"]): RoundSummary["words"] =>
  words
    ? {
        pair: [...words.pair] as [string, string],
        civilianWord: words.civilianWord,
        undercoverWord: words.undercoverWord,
        blankHint: words.blankHint,
      }
    : undefined;

export const finishRound = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  winner: RoundWinner,
  reason: string
) => {
  clearPhaseTimer(ctx, room);
  // 结算时既要给分，也要冻结当局摘要，供房间页在局后复盘。
  const round = requireRound(room);
  const awardedScores = awardRoundScores(ctx, room, round, winner);

  round.phase = "gameOver";
  ctx.gameOverAdvanceAllowedAtByRoomId.set(room.id, ctx.now() + PHASE_RESULT_DISPLAY_MS);
  round.speechMode = undefined;
  round.pendingDisconnectPlayerIds = [];
  round.questionerReconnectDeadlineAt = undefined;
  round.blankGuessContext = undefined;
  round.feedback = undefined;
  round.feedbackContinuation = undefined;
  round.summary = {
    winner,
    reason,
    awardedScores,
    revealedRoles: Object.entries(round.assignments).map(([playerId, state]) => ({
      playerId,
      role: state.role,
    })),
    descriptions: [...round.descriptions],
    blankGuesses: [...round.blankGuessRecords],
    words: summarizeRoundWords(round.words),
    voteHistory: round.voteHistory.map((entry) => ({
      day: entry.day,
      tieBreak: entry.tieBreak,
      votes: entry.votes.map((vote) => ({ ...vote })),
    })),
    history: structuredClone(round.history),
  };
  recordRound(ctx, room, round, round.summary);

  for (const player of Object.values(room.players)) {
    // 结算后统一重置为“未准备”，房主返回等待阶段后由全员重新确认。
    player.isReady = false;
  }

  ctx.touch(room);

  await ctx.log({
    type: "game.finished",
    createdAt: ctx.now(),
    roomId: room.id,
    payload: {
      winner,
      reason,
    },
  });

  // 结算必然改变阶段与摘要，这里统一发布快照；对局小结只走状态通道，
  // 调用方无需也不得再补发 game.roundSummary 事件。
  publishRoom(ctx, room);
};

/** 只给获胜阵营的玩家加分；加到分的玩家进当局摘要，其余不进。 */
const awardRoundScores = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  round: GameRound,
  winner: RoundWinner
): RoundSummary["awardedScores"] => {
  const awardedScores: RoundSummary["awardedScores"] = [];
  if (winner === "aborted") return awardedScores;

  for (const [playerId, state] of Object.entries(round.assignments)) {
    const player = room.players[playerId];
    if (!player) continue;

    const delta = roundScoreDelta(winner, state.side);
    if (delta > 0) {
      player.score += delta;
      awardedScores.push({ playerId, delta });
    }
  }

  return awardedScores;
};
