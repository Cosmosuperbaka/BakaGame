import { QUESTIONER_RECONNECT_TIMEOUT_MS } from "../../config/Constants";
import { describeError } from "../../infrastructure/EventLogger";
import type { WhoIsFakerRoomRecord } from "../../shared/Index";
import type { SnapshottedRoom } from "../../shared/RoomSnapshot";
import {
  adoptRoomCore,
  exportRoomJson,
  hasSnapshotShape,
  restoreRooms,
} from "../room/RoomSnapshotCodec";
import type { WhoIsFakerContext } from "./Context";
import { armPhaseTimer } from "./PhaseTimers";

/**
 * 导出全部房间以供停机保存。
 *
 * 走内核的 JSON 往返出口而不是浅拷贝：房间记录将来若混进函数或句柄，浅拷贝会让序列化在
 * 停机路径上抛错，而那段恰恰最不能失败；往返顺带剔除 undefined，落盘内容与线上视图一致。
 */
export const exportSnapshots = (ctx: WhoIsFakerContext): SnapshottedRoom[] => {
  const snapshots: SnapshottedRoom[] = [];
  for (const room of ctx.rooms.values()) {
    try {
      snapshots.push(exportRoomJson(room));
    } catch (error) {
      ctx.options.eventLogger?.warn("房间快照导出失败，已跳过该房间", {
        roomId: room.id,
        ...describeError(error),
      });
    }
  }
  return snapshots;
};

/**
 * 从快照恢复房间，返回真正恢复的房间数。
 *
 * 关键不是「把对象塞回 Map」，而是把**停机期间流逝的时间**处理干净：
 * 停机时没人在操作，若照原样保留绝对时间戳，倒计时会在恢复瞬间集体到点、
 * 掉线清理会立刻命中，表现为「服务健康、日志正常，但用户回来房间全没了」。
 * 所以下面每个时间字段都要按自己的语义单独处理，不能统一 +pausedMs 了事。
 */
export const restoreSnapshots = (
  ctx: WhoIsFakerContext,
  rooms: readonly SnapshottedRoom[],
  savedAt: number
): number => {
  return restoreRooms(
    ctx.rooms,
    rooms,
    { savedAt, now: ctx.now() },
    {
      adopt: (raw, now, pausedMs) => adoptSnapshot(raw, now, pausedMs),
      onRestored: (room) => {
        // 对局记录的开局时间没有进快照：用快照写入时刻当下界，比按恢复时刻起算更接近真实。
        if (room.round) ctx.roundStartedAtById.set(room.round.id, savedAt);
        ctx.ids.absorb(room);
        // 倒计时只在房间真正登记时才重挂：被判重复而跳过的房间不能留下孤儿定时器。
        const timer = room.round?.phaseTimer;
        if (timer) armPhaseTimer(ctx, room, timer, timer.endsAt - ctx.now());
      },
      onError: (raw, error) =>
        ctx.options.eventLogger?.warn("房间快照恢复失败，已跳过该房间", {
          roomId: raw.id,
          ...describeError(error),
        }),
    }
  );
};

/** 单间恢复：形状校验 + 时间字段重算 + 重建倒计时。任何一步不合预期就整间丢弃。 */
const adoptSnapshot = (
  raw: SnapshottedRoom,
  now: number,
  pausedMs: number
): WhoIsFakerRoomRecord | undefined => {
  if (!hasSnapshotShape(raw)) return undefined;
  const room = raw as unknown as WhoIsFakerRoomRecord;

  // 全员离线、掉线与空房计时从恢复时刻起算：lastSeenAt 留着停机前的值，重启超过 3 分钟
  // 就会在第一次巡检时把全员踢掉，玩家还没机会重连。房主此刻必然离线，一律带一段完整的
  // 重连宽限，否则第一个回来的人会因为「离线房主没有截止」而抢走房主。
  adoptRoomCore(room, Object.values(room.players), now);
  room.updatedAt = now;

  const round = room.round;
  if (round) {
    // 倒计时暂停：停机期间没人能发言或投票，直接按原截止时刻结算等于用故障惩罚玩家。
    if (round.phaseTimer) round.phaseTimer.endsAt += pausedMs;
    if (round.questionerReconnectDeadlineAt !== undefined) {
      round.questionerReconnectDeadlineAt = now + QUESTIONER_RECONNECT_TIMEOUT_MS;
    }
  }

  return room;
};
