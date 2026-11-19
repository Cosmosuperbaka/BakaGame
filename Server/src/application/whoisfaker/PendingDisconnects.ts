import type { GameRound, WhoIsFakerPlayerRecord, WhoIsFakerRoomRecord } from "../../shared/Index";
import { broadcastRoomEvent, publishRoom } from "./RoomPublish";
import { getPendingActorIds } from "./RoundRules";
import type { WhoIsFakerContext } from "./Context";

/**
 * 掉线玩家是否需要立刻暂停游戏、等出题人抉择。
 *
 * 判定标准是「当前阶段还在等这个人操作吗」：已经交过描述、投过票的玩家
 * 掉线不影响本阶段推进，暂停只会白等。这类玩家在下一个需要其操作的阶段
 * 由 requeuePendingDisconnects 重新入队。
 */
export const shouldQueueDisconnectForDecision = (
  ctx: WhoIsFakerContext,
  round: GameRound,
  player: WhoIsFakerPlayerRecord
) => {
  if (player.membership !== "active") {
    return false;
  }

  // 这两个阶段还没有分配身份，也没有「已提交」的概念，只能一律暂停。
  if (round.phase === "assigningQuestioner" || round.phase === "wordSubmission") {
    return true;
  }

  if (!round.assignments[player.id]?.alive) {
    return false;
  }

  switch (round.phase) {
    case "description":
    case "voting":
    case "tieBreak":
    case "night":
      // 普通描述、补充发言、平票 PK 与夜晚都按「本阶段还在等谁」判定，不另写一份。
      return getPendingActorIds(round).includes(player.id);
    case "blankGuess":
      // 只有正在猜词的白板本人会卡住这个阶段。
      return round.blankGuessContext?.playerId === player.id;
    default:
      return false;
  }
};

/**
 * 阶段推进后重新检查掉线玩家：上一阶段被放过的人，
 * 到了需要他操作的阶段就必须在这里补上暂停，否则会永远无人过问。
 */
export const requeuePendingDisconnects = (ctx: WhoIsFakerContext, room: WhoIsFakerRoomRecord) => {
  const round = room.round;

  if (!round || round.phase === "gameOver") {
    return;
  }

  round.pendingDisconnectPlayerIds = round.pendingDisconnectPlayerIds.filter((playerId) => {
    const player = room.players[playerId];
    return (
      player &&
      !player.online &&
      !player.isBot &&
      shouldQueueDisconnectForDecision(ctx, round, player)
    );
  });

  for (const player of Object.values(room.players)) {
    if (player.online || player.isBot) continue;
    if (round.pendingDisconnectPlayerIds.includes(player.id)) continue;
    // 出题人掉线走重连倒计时，不并入待抉择队列。
    if (round.questionerPlayerId === player.id) continue;
    if (!shouldQueueDisconnectForDecision(ctx, round, player)) continue;

    enqueuePendingDisconnect(round, player.id);
    broadcastRoomEvent(ctx, room, "game.disconnectDecisionRequested", {
      roomId: room.id,
      playerId: player.id,
    });
  }
};

export const enqueuePendingDisconnect = (round: GameRound, playerId: string) => {
  if (!round.pendingDisconnectPlayerIds.includes(playerId)) {
    round.pendingDisconnectPlayerIds.push(playerId);
  }
};

export const clearPendingDisconnect = (round: GameRound, playerId: string) => {
  round.pendingDisconnectPlayerIds = round.pendingDisconnectPlayerIds.filter(
    (pendingPlayerId) => pendingPlayerId !== playerId
  );
};

export const broadcastPhaseAndPublish = (ctx: WhoIsFakerContext, room: WhoIsFakerRoomRecord) => {
  // 阶段变了就要重新判断掉线玩家是否已成为当前阶段的阻塞点。
  requeuePendingDisconnects(ctx, room);
  publishRoom(ctx, room);
};
