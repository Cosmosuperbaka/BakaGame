import { ROOM_EXPIRING_WARNING_MS } from "../../config/Constants";
import { describeError } from "../../infrastructure/EventLogger";
import {
  expiredOfflineSeats,
  forEachRoomIsolated,
  isIdleWarningDue,
  judgeReclaim,
  markIdleWarningSent,
} from "../room/RoomJanitor";
import { resolveHostGrace } from "../room/HostPolicy";
import { countOnline } from "../room/RoomSummaries";
import { broadcastRoomEvent } from "./Chat";
import { publishRoomCalibration, type SonGuessrContext } from "./Context";
import { reassignRemovedHost, settleHostChange } from "./Membership";
import { clearMusicSession } from "./MusicAuth";
import { scheduleMusicSessionRefresh } from "./MusicSessionRefresh";
import type { SonGuessrRoomRecord } from "./Records";
import { isTestRoom } from "./RoomAccess";
import { closeRoom } from "./RoomClosure";
import { settlePlayingRound } from "./RoundEngine";
import { releasePendingSubmitter } from "./RoundFlow";

/** 巡检的房间回收结论：`skip` 整间跳过、`grace` 已补校准并跳过、`keep` 继续后续阶段。 */
type RoomReclaim = "skip" | "grace" | "keep";

export async function runHousekeeping(ctx: SonGuessrContext): Promise<void> {
  const currentTime = ctx.now();
  await forEachRoomIsolated(
    ctx.rooms,
    (room) => sweepRoom(ctx, room, currentTime),
    (room, error) =>
      ctx.options.eventLogger?.warn("猜歌房间巡检失败，已跳过该房间", {
        roomId: room.id,
        ...describeError(error),
      })
  );
  scheduleMusicSessionRefresh(ctx, currentTime);
}

/** 单间房的巡检：回收判定之后才做离线清理、房主改选与回合推进。 */
function sweepRoom(ctx: SonGuessrContext, room: SonGuessrRoomRecord, currentTime: number): void {
  if (reclaimIdleRoom(ctx, room, currentTime) !== "keep") return;
  cleanupOfflinePlayers(ctx, room, currentTime);
  resolveHost(ctx, room, currentTime);
  expirePendingSubmitter(ctx, room, currentTime);
  settlePlayingRound(ctx, room, currentTime);
  publishRoomCalibration(ctx, room);
}

/**
 * 无人房间与空闲房间的回收：测试房间只豁免「无人立即回收」，仍受空闲超时约束，
 * 无人房间先给一段宽限期，宽限期内只补一次校准便跳过其余巡检阶段。
 * 闲置关房前提前一段时间预警：每一段闲置只预警一次，有新活动后重新计。
 */
function reclaimIdleRoom(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  currentTime: number
): RoomReclaim {
  const onlineCount = countOnline(Object.values(room.players));
  const emptyRoomExempt = isTestRoom(ctx, room);
  if (isIdleWarningDue(room, onlineCount, currentTime, ROOM_EXPIRING_WARNING_MS)) {
    markIdleWarningSent(room);
    broadcastRoomEvent(ctx, room, "song.room.expiring", { roomId: room.id, idle: true });
  }
  const verdict = judgeReclaim(room, onlineCount, currentTime, { emptyRoomExempt });
  switch (verdict) {
    case "grace":
      publishRoomCalibration(ctx, room);
      return "grace";
    case "close-empty":
    case "close-idle":
      closeRoom(ctx, room, onlineCount === 0 ? "empty" : "idle_timeout");
      return "skip";
    case "keep":
      // 测试房常态就是一间等人加入的空房：没人时不推进任何巡检阶段。
      return emptyRoomExempt && onlineCount === 0 ? "skip" : "keep";
  }
}

/** 清理离线超过保留时长的真人玩家；被清掉的是房主时先移交，房间空了立即回收。 */
function cleanupOfflinePlayers(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  currentTime: number
): void {
  for (const player of expiredOfflineSeats(room, Object.values(room.players), currentTime)) {
    delete room.players[player.id];
    // 掉线超过宽限：人和他贡献的号一起清出房间（宽限内号仍在，房主面板也能看到）。
    clearMusicSession(ctx, room, player.id);
    if (room.hostPlayerId === player.id) reassignRemovedHost(room);
    ctx.touch(room);
    if (countOnline(Object.values(room.players)) === 0 && !isTestRoom(ctx, room)) {
      closeRoom(ctx, room, "empty");
    } else {
      ctx.publishRoom(room);
      ctx.publishLobby();
    }
  }
}

/** 出题时限到点：退回选出题人阶段并在房间公告里说明，免得全房以为页面自己跳回去了。 */
function expirePendingSubmitter(
  ctx: SonGuessrContext,
  room: SonGuessrRoomRecord,
  currentTime: number
): void {
  const playerId = room.pendingSubmitterPlayerId;
  if (room.phase !== "submittingSong" || !playerId) return;
  const deadlineAt = room.pendingSubmitterDeadlineAt;
  if (deadlineAt === undefined || currentTime < deadlineAt) return;
  const submitter = room.players[playerId];
  const target = room.settings.questionType === "anime" ? "番剧" : "歌曲";
  releasePendingSubmitter(
    ctx,
    room,
    playerId,
    `${submitter ? `出题人 ${submitter.name}` : "出题人"} 没有在时限内选好${target}，请重新指定出题人`
  );
  ctx.touch(room);
  ctx.publishRoom(room);
}

/** 巡检每跳调用：房主空缺或离线宽限已过时改选，选不到就保持现状、下一跳再试。 */
function resolveHost(ctx: SonGuessrContext, room: SonGuessrRoomRecord, currentTime: number) {
  const previousHostId = room.hostPlayerId;
  const { changed } = resolveHostGrace(room, Object.values(room.players), currentTime);
  if (!changed) return;
  settleHostChange(room, previousHostId);
  ctx.touch(room);
  ctx.publishRoom(room);
  ctx.publishLobby();
}
