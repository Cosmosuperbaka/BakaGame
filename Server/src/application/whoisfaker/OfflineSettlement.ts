import { AppError } from "../../domain/Errors";
import {
  type GameRound,
  type WhoIsFakerPlayerRecord,
  type WhoIsFakerRoomRecord,
} from "../../shared/Index";
import { QUESTIONER_RECONNECT_TIMEOUT_MS } from "../../config/Constants";
import { startFallbackBlankGuessTimer } from "./BlankGuess";
import { reassignHost } from "../room/HostPolicy";
import { markSeatOffline } from "../room/SeatBinding";
import { runBots } from "./dev/BotActors";
import { countOnline } from "../room/RoomSummaries";
import { forceRemovePlayer } from "./ForcedRemoval";
import { finishRound } from "./RoundSettlement";
import { broadcastRoomEvent, publishLobby, publishRoom } from "./RoomPublish";
import { closeRoom, shouldAutoCloseWhenEmpty } from "./RoomClosure";
import {
  clearPendingDisconnect,
  enqueuePendingDisconnect,
  shouldQueueDisconnectForDecision,
} from "./PendingDisconnects";
import { normalizeRoomRoleConfig } from "./RoundRules";
import { requireRound, type WhoIsFakerSeatAt } from "./RoomAccess";
import type { WhoIsFakerContext } from "./Context";

/** 玩家离线的两种来源：连接断开与主动离开房间。 */
type PlayerOfflineReason = "disconnect" | "leave";

/** 离线处理的上下文：房主身份在清理前读一次，供各阶段共用。 */
type OfflineContext = {
  room: WhoIsFakerRoomRecord;
  playerId: string;
  player: WhoIsFakerPlayerRecord;
  reason: PlayerOfflineReason;
  wasHost: boolean;
};

export const resolveDisconnect = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  targetPlayerId: string,
  resolution: "wait" | "eliminate"
) => {
  // 只有出题人能决定掉线正式玩家是继续等待还是直接淘汰：出题人判定由命令表守卫完成，
  // 这里取出回合只为收窄类型。
  const { room, seat: player } = at;
  const round = requireRound(room);

  if (!round.pendingDisconnectPlayerIds.includes(targetPlayerId)) {
    throw new AppError("PLAYER_NOT_PENDING", "当前没有等待处理的掉线玩家");
  }
  clearPendingDisconnect(round, targetPlayerId);

  if (resolution === "eliminate") {
    await forceRemovePlayer(ctx, room, targetPlayerId, "掉线后被出题人移出");
  } else {
    ctx.appendSystemMessage(
      room,
      `${room.players[targetPlayerId]?.name ?? "玩家"} 的掉线状态已保留`
    );
    // 关键修复：若掉线者正是猜词中的白板，选择保留等待时挂载 60 秒倒计时兜底，超时自动按失败结算切回残局，杜绝死锁
    if (round.phase === "blankGuess" && round.blankGuessContext?.playerId === targetPlayerId) {
      startFallbackBlankGuessTimer(ctx, room, 60);
    }
  }

  ctx.touch(room);
  await ctx.log({
    type: "game.disconnect_resolved",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
    payload: {
      targetPlayerId,
      resolution,
    },
  });

  publishRoom(ctx, room);
  await runBots(ctx, room);

  return { resolved: true };
};

export const handlePlayerOffline = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  playerId: string,
  reason: PlayerOfflineReason
) => {
  // 这里集中处理“玩家不在线”带来的所有副作用：局外移除、局内待决、空房清理。
  const player = room.players[playerId];
  if (!player) {
    return;
  }

  const round = room.round;
  const flow: OfflineContext = {
    room,
    playerId,
    player,
    reason,
    wasHost: room.hostPlayerId === player.id,
  };

  markPlayerDisconnected(ctx, flow);

  if (!round || round.phase === "gameOver") {
    await settleOfflineOutsideRound(ctx, flow);
    return;
  }

  await settleOfflineInsideRound(ctx, flow, round);

  if (flow.wasHost && reason === "leave") {
    reassignHost(room, Object.values(room.players));
  }

  ctx.touch(room);
  await ctx.log({
    type: `player.${reason}`,
    createdAt: ctx.now(),
    roomId: room.id,
    playerId,
  });

  await publishOrCloseIfEmpty(ctx, room, reason);
};

/**
 * 标记离线并解绑连接；整房都没人在线时才起空房计时（测试房豁免），
 * 房主掉线时由内核给出重连截止时刻。
 */
const markPlayerDisconnected = (ctx: WhoIsFakerContext, flow: OfflineContext) => {
  markSeatOffline(ctx.seatContext, flow.room, flow.player, {
    emptyRoomExempt: !shouldAutoCloseWhenEmpty(ctx, flow.room),
  });
};

/** 局外掉线：显式离开的真人无条件移出房间，房主离开后重选房主。 */
const settleOfflineOutsideRound = async (ctx: WhoIsFakerContext, flow: OfflineContext) => {
  const room = flow.room;
  if (flow.reason === "leave" && !flow.player.isBot) {
    // 玩家显式离开时，无条件将其从房间列表中清理
    delete room.players[flow.player.id];
  }

  if (flow.wasHost && flow.reason === "leave") {
    // 离开者的席位已删除，房主指针悬空，按候选规则（在线正式玩家优先、同级按加入先后）重新选人。
    reassignHost(room, Object.values(room.players));
  }

  normalizeRoomRoleConfig(room);
  ctx.touch(room);
  await publishOrCloseIfEmpty(ctx, room, flow.reason);
};

/** 局内掉线：出题人显式离开即终止本局，其余按掉线淘汰决策处理。 */
const settleOfflineInsideRound = async (
  ctx: WhoIsFakerContext,
  flow: OfflineContext,
  round: GameRound
) => {
  if (flow.reason === "leave") {
    await removeLeavingPlayer(ctx, flow, round);
    return;
  }

  await queueOfflineDecision(ctx, flow, round);
};

/** 出题人主动退出直接终止本局，其余玩家按离开强制移出。 */
const removeLeavingPlayer = async (
  ctx: WhoIsFakerContext,
  flow: OfflineContext,
  round: GameRound
) => {
  const room = flow.room;
  const player = flow.player;
  if (round.questionerPlayerId === player.id) {
    await finishRound(ctx, room, "aborted", "出题人主动退出房间，本局已终止");
  } else {
    await forceRemovePlayer(ctx, room, player.id, "leave");
  }

  if (!player.isBot) {
    delete room.players[player.id];
  }
};

/** 出题人掉线留出重连窗口；其余玩家由全房决定是否进入淘汰投票。 */
const queueOfflineDecision = async (
  ctx: WhoIsFakerContext,
  flow: OfflineContext,
  round: GameRound
) => {
  const room = flow.room;
  const player = flow.player;
  if (round.questionerPlayerId === player.id) {
    round.questionerReconnectDeadlineAt = ctx.now() + QUESTIONER_RECONNECT_TIMEOUT_MS;
    ctx.appendSystemMessage(room, "出题人已掉线，系统开始等待其重新连接");
    return;
  }

  if (shouldQueueDisconnectForDecision(ctx, round, player)) {
    enqueuePendingDisconnect(round, player.id);
    broadcastRoomEvent(ctx, room, "game.disconnectDecisionRequested", {
      roomId: room.id,
      playerId: flow.playerId,
    });
  }
};

/** 显式离开可能让房间只剩空壳：空了就关房，否则照常广播快照与大厅。 */
const publishOrCloseIfEmpty = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  reason: PlayerOfflineReason
) => {
  if (reason === "leave" && countOnline(Object.values(room.players)) === 0) {
    await closeRoom(ctx, room, "empty");
    return;
  }

  publishRoom(ctx, room);
  publishLobby(ctx);
};
