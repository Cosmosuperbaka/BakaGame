import { ROOM_EXPIRING_WARNING_MS } from "../../config/Constants";
import { describeError } from "../../infrastructure/EventLogger";
import type { WhoIsFakerRoomRecord } from "../../shared/Index";
import { resolveHostGrace } from "../room/HostPolicy";
import {
  forEachRoomIsolated,
  isIdleWarningDue,
  judgeReclaim,
  markIdleWarningSent,
  offlineSeatGraceMs,
} from "../room/RoomJanitor";
import { countOnline } from "../room/RoomSummaries";
import type { WhoIsFakerContext } from "./Context";
import { forceRemovePlayer } from "./ForcedRemoval";
import { handlePhaseTimeout } from "./PhaseTimeouts";
import { closeRoom, shouldAutoCloseWhenEmpty } from "./RoomClosure";
import {
  broadcastRoomEvent,
  publishLobby,
  publishRoom,
  publishRoomCalibration,
} from "./RoomPublish";
import { normalizeRoomRoleConfig } from "./RoundRules";
import { finishRound } from "./RoundSettlement";

export const runHousekeeping = async (ctx: WhoIsFakerContext): Promise<void> => {
  // 统一处理空房清理、闲置超时和出题人掉线超时。
  const currentTime = ctx.now();
  // 逐房隔离：一间房的状态异常不能让迭代顺序里靠后的房间本轮都不被清理。
  await forEachRoomIsolated(
    ctx.rooms,
    (room) => housekeepRoom(ctx, room, currentTime),
    (room, error) =>
      ctx.options.eventLogger.error("房间巡检失败", {
        roomId: room.id,
        ...describeError(error),
      })
  );
};

const housekeepRoom = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  currentTime: number
): Promise<void> => {
  if (await reclaimIdleRoom(ctx, room, currentTime)) return;
  await removeOfflinePlayers(ctx, room, currentTime);
  await handOverStalledRoles(ctx, room, currentTime);
  await finishExpiredPhaseTimer(ctx, room, currentTime);
  publishRoomCalibration(ctx, room);
};

/**
 * 空房与闲置回收，返回本房是否已关闭。
 * 闲置关房前提前一段时间预警，每一段闲置只预警一次，有新活动后重新计。
 * 测试房只豁免「空房回收」：测试房常态是一间等人加入的空房，但长期闲置的测试房
 * 与它加出来的机器人仍要回收，否则只能靠重启释放。
 */
const reclaimIdleRoom = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  currentTime: number
): Promise<boolean> => {
  const onlineCount = countOnline(Object.values(room.players));
  if (isIdleWarningDue(room, onlineCount, currentTime, ROOM_EXPIRING_WARNING_MS)) {
    markIdleWarningSent(room);
    broadcastRoomEvent(ctx, room, "room.expiring", {
      roomId: room.id,
      reason: "idle_timeout",
    });
  }
  const verdict = judgeReclaim(room, onlineCount, currentTime, {
    emptyRoomExempt: !shouldAutoCloseWhenEmpty(ctx, room),
  });
  // 空房宽限内（grace）与 keep 一样继续后面的步骤：宽限只决定要不要关，不暂停回合推进。
  if (verdict === "close-empty") {
    await closeRoom(ctx, room, "empty");
    return true;
  }
  if (verdict === "close-idle") {
    await closeRoom(ctx, room, "idle_timeout");
    return true;
  }
  return false;
};

/** 清理离线超过保留时长的玩家：时长按席位而定，见 `offlineSeatGraceMs`。 */
const removeOfflinePlayers = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  currentTime: number
) => {
  for (const player of Object.values(room.players)) {
    if (
      player.online ||
      player.isBot ||
      currentTime - player.lastSeenAt < offlineSeatGraceMs(room, player)
    ) {
      continue;
    }
    // 被踢记录在踢人当时已完成强制移除，这里只清掉占位。
    if (player.membership !== "kicked" && room.round && room.round.phase !== "gameOver") {
      if (room.round.questionerPlayerId === player.id) {
        await finishRound(ctx, room, "aborted", "出题人掉线超时，本局已结束");
      } else {
        await forceRemovePlayer(ctx, room, player.id, "timeout");
      }
    }
    delete room.players[player.id];
    normalizeRoomRoleConfig(room);
    ctx.touch(room);
  }
};

/**
 * 房主与出题人各自的重连截止时刻到了就交接或结束本局。
 * 房主每一跳都过内核的不变量检查：宽限已过、空缺或悬空时按候选规则改选，选不到下一跳再试。
 */
const handOverStalledRoles = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  currentTime: number
) => {
  await settleHostGrace(ctx, room, currentTime);

  if (
    room.round?.questionerReconnectDeadlineAt &&
    currentTime >= room.round.questionerReconnectDeadlineAt
  ) {
    await finishRound(ctx, room, "aborted", "出题人掉线超时，本局已结束");
  }
};

const finishExpiredPhaseTimer = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  currentTime: number
) => {
  const activeTimer = room.round?.phaseTimer;
  if (!activeTimer || currentTime < activeTimer.endsAt) return;

  await handlePhaseTimeout(
    ctx,
    room.id,
    activeTimer.phase,
    activeTimer.speechMode,
    activeTimer.tieBreakStage
  );
};

const settleHostGrace = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  currentTime: number
) => {
  const { changed, previous, next } = resolveHostGrace(
    room,
    Object.values(room.players),
    currentTime
  );
  if (!changed) return;

  ctx.touch(room);
  if (next) {
    ctx.appendSystemMessage(
      room,
      previous
        ? `${previous.name} 断线超时，房主已转移给 ${next.name}`
        : `房主已转移给 ${next.name}`
    );
    await ctx.log({
      type: "room.host_transferred",
      createdAt: ctx.now(),
      roomId: room.id,
      payload: {
        previousHostId: previous?.id,
        nextHostId: next.id,
        reason: "disconnect_timeout",
      },
    });
  }

  publishRoom(ctx, room);
  publishLobby(ctx);
};
