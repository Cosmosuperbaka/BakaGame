import {
  PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS,
  ROOM_EMPTY_GRACE_PERIOD_MS,
  ROOM_IDLE_TIMEOUT_MS,
  SPECTATOR_OFFLINE_GRACE_MS,
} from "../../config/Constants";
import type { RoomCore, SeatCore } from "./RoomCore";

/**
 * 巡检的公共步骤。步骤顺序与回合截止推进是玩法自己的事，这里只给出逐房隔离的遍历骨架
 * 与几个纯判定。
 */

/**
 * 逐房遍历：先把房间列表拷成数组再遍历，遍历途中删房（包括本房关掉别的房）不出错，
 * 已经不在登记里的房间跳过。`visit` 抛错或拒绝只交给 `onError`，后面的房间照常巡检——
 * 一间房的坏状态不能让整服的空房回收与截止推进一起停摆。
 * 同步的 `visit` 不会被 await：同步巡检的玩法在一次调用内跑完全部房间，时序与原来一致。
 */
export const forEachRoomIsolated = async <TRoom extends { id: string }>(
  rooms: ReadonlyMap<string, TRoom>,
  visit: (room: TRoom) => void | Promise<void>,
  onError: (room: TRoom, error: unknown) => void
): Promise<void> => {
  for (const room of [...rooms.values()]) {
    if (rooms.get(room.id) !== room) continue;
    try {
      const pending = visit(room);
      if (pending) await pending;
    } catch (error) {
      onError(room, error);
    }
  }
};

/**
 * 回收结论：`keep` 照常巡检；`grace` 空房宽限中（玩法通常只补一次校准便跳过其余步骤）；
 * `close-empty` 空房宽限已满；`close-idle` 闲置超时。
 */
export type ReclaimVerdict = "keep" | "grace" | "close-empty" | "close-idle";

/**
 * 维护 `emptySinceAt` 并给出结论。豁免（测试房）只豁免空房回收，不豁免闲置：
 * 否则那间房的记录与加出来的机器人永远不会被回收，只能靠重启释放。
 */
export const judgeReclaim = (
  room: RoomCore,
  onlineCount: number,
  now: number,
  options: { emptyRoomExempt: boolean }
): ReclaimVerdict => {
  const idle = now - room.lastActivityAt >= ROOM_IDLE_TIMEOUT_MS;
  if (onlineCount > 0 || options.emptyRoomExempt) {
    room.emptySinceAt = undefined;
    return idle ? "close-idle" : "keep";
  }
  room.emptySinceAt ??= now;
  if (now - room.emptySinceAt >= ROOM_EMPTY_GRACE_PERIOD_MS) return "close-empty";
  return idle ? "close-idle" : "grace";
};

/**
 * 闲置关房前的预警是否该发：有人在线、离闲置超时不到 `leadMs`、这一段闲置还没预警过。
 * 发出后调用 `markIdleWarningSent`；有新活动时 `lastActivityAt` 前移，下一段闲置会重新预警。
 * 提前量由调用方传入：常量今天还在猜歌的记录文件里，接入时搬到公共常量。
 */
export const isIdleWarningDue = (
  room: RoomCore,
  onlineCount: number,
  now: number,
  leadMs: number
): boolean =>
  onlineCount > 0 &&
  room.idleWarningFor !== room.lastActivityAt &&
  ROOM_IDLE_TIMEOUT_MS - (now - room.lastActivityAt) <= leadMs;

export const markIdleWarningSent = (room: RoomCore): void => {
  room.idleWarningFor = room.lastActivityAt;
};

/** 离线席位保留多久：0 分真人旁观者没有分数可保留，只留够一次刷新的时间；房主照常长保留。 */
export const offlineSeatGraceMs = (room: RoomCore, seat: SeatCore & { score?: number }): number =>
  seat.membership === "spectator" &&
  (seat.score ?? 0) === 0 &&
  seat.isBot !== true &&
  room.hostPlayerId !== seat.id
    ? SPECTATOR_OFFLINE_GRACE_MS
    : PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS;

/** 离线超过保留时长、该清出名册的真人席位（机器人不随掉线清理）。 */
export const expiredOfflineSeats = <TSeat extends SeatCore & { score?: number }>(
  room: RoomCore,
  seats: Iterable<TSeat>,
  now: number
): TSeat[] => {
  const expired: TSeat[] = [];
  for (const seat of seats) {
    if (seat.online || seat.isBot === true) continue;
    if (now - seat.lastSeenAt >= offlineSeatGraceMs(room, seat)) expired.push(seat);
  }
  return expired;
};
