import {
  hasSnapshotShape,
  adoptRoomCore,
  exportRoomJson,
  restoreRooms,
} from "../room/RoomSnapshotCodec";
import type { SnapshottedRoom } from "../../shared/RoomSnapshot";
import { issueAudioTicket } from "./AudioTicket";
import type { SonGuessrContext } from "./Context";
import type { SonGuessrRoomRecord } from "./Records";

/**
 * 导出全部房间以供停机保存。
 *
 * 两类字段挡在落盘之外：
 * - 运行时状态（`runtime`）：开局与登录的在途锁都在里面，重启后不存在任何在途操作，
 *   恢复出来的房间天然没有这些锁。
 * - 音乐账号池（`musicPool`）的每条都带着第三方 `cookie`，落盘等于把玩家的登录态写进
 *   本机文件。整段丢弃，恢复后由各贡献者重新登录，宁可少一段体验也不留凭据。
 * - 当前回合的播放地址票据：它是访问凭据，恢复时由 `adoptSnapshot` 重新签发。
 */
export function exportSnapshots(ctx: SonGuessrContext): SnapshottedRoom[] {
  const snapshots: SnapshottedRoom[] = [];
  for (const room of ctx.rooms.values()) {
    try {
      const snapshot = exportRoomJson(room, ["musicPool"]);
      const round = snapshot.currentRound;
      if (typeof round === "object" && round !== null)
        delete (round as { audioTicket?: string }).audioTicket;
      snapshots.push(snapshot);
    } catch (error) {
      ctx.options.eventLogger?.warn("猜歌房间快照导出失败，已跳过该房间", {
        roomId: room.id,
        error: String(error),
      });
    }
  }
  return snapshots;
}

/**
 * 从快照恢复房间，返回真正恢复的房间数。
 *
 * 时间字段逐个处理，不能统一 +pausedMs：截止时刻是「玩家还能操作的剩余时间」，停机期间
 * 没人能操作，所以要暂停；而掉线、空房、空闲三类计时衡量的是「人离开多久」，停机不算人走了，
 * 必须从恢复时刻重新起算。混在一起做，恢复瞬间就会清场。
 */
export function restoreSnapshots(
  ctx: SonGuessrContext,
  rooms: readonly SnapshottedRoom[],
  savedAt: number
): number {
  return restoreRooms(
    ctx.rooms,
    rooms,
    { savedAt, now: ctx.now() },
    {
      adopt: (raw, now, pausedMs) => adoptSnapshot(raw, now, pausedMs),
      onRestored: (room) => ctx.ids.absorb(room),
      onError: (raw, error) =>
        ctx.options.eventLogger?.warn("猜歌房间快照恢复失败，已跳过该房间", {
          roomId: raw.id,
          error: String(error),
        }),
    }
  );
}

function adoptSnapshot(
  raw: SnapshottedRoom,
  now: number,
  pausedMs: number
): SonGuessrRoomRecord | undefined {
  if (!hasSnapshotShape(raw)) return undefined;
  const room = raw as unknown as SonGuessrRoomRecord;

  // 全员离线、掉线与空房计时从恢复时刻起算；房主此刻必然离线，一律带一段完整的重连宽限，
  // 否则第一个回来的人会因为「离线房主没有截止」而抢走房主。
  adoptRoomCore(room, Object.values(room.players), now);
  room.updatedAt = now;
  if (room.pendingSubmitterDeadlineAt !== undefined) {
    room.pendingSubmitterDeadlineAt += pausedMs;
    if (room.pendingSubmitterAssignedAt !== undefined) room.pendingSubmitterAssignedAt += pausedMs;
  }

  const round = room.currentRound;
  if (round) {
    // 票据不落盘：恢复时一律重新签发，旧客户端手里的旧地址随停机作废，重连后拿到新的。
    round.audioTicket = issueAudioTicket();
    round.audioPreparationDeadlineAt += pausedMs;
    if (round.audioReadyDeadlineAt !== undefined) round.audioReadyDeadlineAt += pausedMs;
    if (round.hardDeadlineAt !== undefined) round.hardDeadlineAt += pausedMs;
    for (const unit of Object.values(round.players)) {
      if (unit.deadlineAt !== undefined) unit.deadlineAt += pausedMs;
      // 在途锁是运行时状态：重启后那次请求不会再有结果，留着等于把玩家永久锁死。
      unit.inFlight = undefined;
    }
  }

  return room;
}
