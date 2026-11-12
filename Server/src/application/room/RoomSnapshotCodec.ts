import { HOST_RECONNECT_TIMEOUT_MS } from "../../config/Constants";
import type { SnapshottedRoom } from "../../shared/RoomSnapshot";
import type { RoomCore, SeatCore } from "./RoomCore";

/**
 * 停机快照导出与恢复的公共部分。玩法自己的截止平移与容器摊平（CEE 的 Map）留在各玩法，
 * 但都走这里的出口与入口。
 */

/**
 * 导出一间房：JSON 往返，顶层的 `runtime` 一律丢弃，再丢弃 `strip` 点名的顶层键。
 * 丢弃发生在序列化当中而不是之后：运行时状态里可能有句柄与循环引用，先序列化再删会在停机
 * 路径上抛错；点名的键（如带第三方凭据的账号池）也不该在序列化里走一遭。
 */
export const exportRoomJson = (room: object, strip: readonly string[] = []): SnapshottedRoom => {
  const dropped = new Set(["runtime", ...strip]);
  const json = JSON.stringify(room, function (this: unknown, key: string, value: unknown) {
    return this === room && dropped.has(key) ? undefined : value;
  });
  return JSON.parse(json) as SnapshottedRoom;
};

/** 最小可恢复形状：有非空 id，座位容器是对象。不合格的整间丢弃。 */
export const hasSnapshotShape = (raw: SnapshottedRoom, seatsKey = "players"): boolean => {
  if (!raw || typeof raw.id !== "string" || !raw.id) return false;
  const seats = raw[seatsKey];
  return typeof seats === "object" && seats !== null;
};

/**
 * 恢复的公共部分。停机不是人走了，所以「人离开多久」一类计时从恢复时刻重新起算：
 * 全员离线并清连接、lastSeenAt 取 now；清空房计时；活动时刻取 now；丢掉残留的运行时状态。
 * 房主此刻必然离线，所以只要有房主就从 now 起给一段完整的重连宽限——离线房主没有截止
 * 会被当成宽限已过，第一个回来的人就会抢走房主。
 */
export const adoptRoomCore = (room: RoomCore, seats: Iterable<SeatCore>, now: number): void => {
  for (const seat of seats) {
    seat.online = false;
    seat.connectionId = undefined;
    seat.lastSeenAt = now;
  }
  room.emptySinceAt = undefined;
  room.lastActivityAt = now;
  room.runtime = undefined;
  room.hostReconnectDeadlineAt = room.hostPlayerId ? now + HOST_RECONNECT_TIMEOUT_MS : undefined;
};

/** 截止时刻按停机时长后移（停机期间没人能操作）；空值原样透传。 */
export const shiftDeadline = <T extends number | null | undefined>(value: T, pausedMs: number): T =>
  (typeof value === "number" ? value + pausedMs : value) as T;

/**
 * 恢复循环：逐间调用玩法的 `adopt`（返回 undefined 表示丢弃），同号已在的跳过。
 * 单间抛错只交给 `onError` 并跳过这一间：一间坏房不能让整款游戏的恢复失败。
 * `onRestored` 在登记之前调用（抬发号计数器等），它抛错同样只丢这一间。
 */
export const restoreRooms = <TRoom extends { id: string }>(
  rooms: Map<string, TRoom>,
  raws: readonly SnapshottedRoom[],
  timing: { savedAt: number; now: number },
  handlers: {
    adopt(raw: SnapshottedRoom, now: number, pausedMs: number): TRoom | undefined;
    onRestored?(room: TRoom): void;
    onError(raw: SnapshottedRoom, error: unknown): void;
  }
): number => {
  // 时钟回拨按 0 处理：等价于不补偿，好过把截止推到更远的未来。
  const pausedMs = Math.max(0, timing.now - timing.savedAt);
  let restored = 0;
  for (const raw of raws) {
    try {
      const room = handlers.adopt(raw, timing.now, pausedMs);
      if (!room || rooms.has(room.id)) continue;
      handlers.onRestored?.(room);
      rooms.set(room.id, room);
      restored += 1;
    } catch (error) {
      handlers.onError(raw, error);
    }
  }
  return restored;
};
