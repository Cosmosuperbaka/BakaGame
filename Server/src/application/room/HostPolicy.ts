import { HOST_RECONNECT_TIMEOUT_MS } from "../../config/Constants";
import { AppError } from "../../domain/Errors";
import type { RoomCore, SeatCore } from "./RoomCore";

/**
 * 房主不变量：房主要么是名册内在线（或离线但仍在重连宽限内）的真人，要么房间处于「待选」
 * （`hostPlayerId` 为空串或指向已离开的人）。待选状态由两条路收口：巡检每跳调用
 * `resolveHostGrace` 重试改选；任何真人上线时 `healHostOnAttach` 当场改选。
 *
 * 候选只挑在线真人：active 优先，同级按入房先后。离线成员不当选——他上线之前没人能
 * 操作房主功能，而他上线时 `healHostOnAttach` 自会把房主交给他。
 */

export interface TransferTargetError {
  code: string;
  message: string;
}

export const INVALID_TRANSFER_TARGET: TransferTargetError = {
  code: "INVALID_TARGET",
  message: "只能转让给在线正式玩家",
};

const toList = <TSeat>(seats: Iterable<TSeat>): readonly TSeat[] =>
  Array.isArray(seats) ? seats : [...seats];

const seatById = <TSeat extends SeatCore>(seats: readonly TSeat[], id: string) =>
  id ? seats.find((seat) => seat.id === id) : undefined;

const isEligible = (seat: SeatCore): boolean =>
  seat.online && seat.isBot !== true && seat.membership !== "kicked";

const outranks = (candidate: SeatCore, best: SeatCore): boolean => {
  const candidateActive = candidate.membership === "active";
  if (candidateActive !== (best.membership === "active")) return candidateActive;
  return candidate.joinedAt < best.joinedAt;
};

/**
 * 现任房主是否需要有人接任：不在名册、被踢、是机器人，或离线且宽限已过。
 * 离线却没有截止时刻按「宽限已过」处理：房主离线就必须带着截止（`startHostGrace`），
 * 缺了它说明这个房主从来没有被给过宽限，不能让他无限期占着位置。
 */
const needsSuccessor = (room: RoomCore, host: SeatCore | undefined, now: number): boolean => {
  if (!host || host.membership === "kicked" || host.isBot === true) return true;
  if (host.online) return false;
  const deadline = room.hostReconnectDeadlineAt;
  return deadline === undefined || now >= deadline;
};

const assignHost = (room: RoomCore, next: SeatCore): void => {
  room.hostPlayerId = next.id;
  room.hostReconnectDeadlineAt = undefined;
};

/** `hostPlayerId` 指向名册内未被踢的成员。 */
export const isHostSeated = (room: RoomCore, seats: Iterable<SeatCore>): boolean => {
  const host = seatById(toList(seats), room.hostPlayerId);
  return host !== undefined && host.membership !== "kicked";
};

/** 只挑在线真人：active 优先，同级按 joinedAt。没有返回 undefined。 */
export const pickNextHost = <TSeat extends SeatCore>(seats: Iterable<TSeat>): TSeat | undefined => {
  let best: TSeat | undefined;
  for (const seat of seats) {
    if (isEligible(seat) && (!best || outranks(seat, best))) best = seat;
  }
  return best;
};

/** 房主掉线：开始重连宽限。 */
export const startHostGrace = (room: RoomCore, now: number): void => {
  room.hostReconnectDeadlineAt = now + HOST_RECONNECT_TIMEOUT_MS;
};

/**
 * 房主被移除（离开、被踢、被清理）后调用。现任仍在名册时不动。
 * 选到：写 hostPlayerId、清截止、返回新房主；选不到：hostPlayerId 置空串（待选）。
 */
export const reassignHost = <TSeat extends SeatCore>(
  room: RoomCore,
  seats: Iterable<TSeat>
): TSeat | undefined => {
  const list = toList(seats);
  const current = seatById(list, room.hostPlayerId);
  if (current && current.membership !== "kicked") return undefined;
  const next = pickNextHost(list);
  if (next) {
    assignHost(room, next);
  } else {
    room.hostPlayerId = "";
    room.hostReconnectDeadlineAt = undefined;
  }
  return next;
};

/**
 * 巡检每跳调用。房主在线：清截止。房主空缺、悬空，或离线且宽限已过：尝试改选；
 * 选不到时离线房主保持现状（下一跳再试），悬空的指针清成待选。
 * 返回是否发生了变更与新旧房主（供玩法写公告）。
 */
export const resolveHostGrace = <TSeat extends SeatCore>(
  room: RoomCore,
  seats: Iterable<TSeat>,
  now: number
): { changed: boolean; previous?: TSeat; next?: TSeat } => {
  const list = toList(seats);
  const host = seatById(list, room.hostPlayerId);
  if (host && isEligible(host)) {
    room.hostReconnectDeadlineAt = undefined;
    return { changed: false };
  }
  if (!needsSuccessor(room, host, now)) return { changed: false };
  const next = pickNextHost(list);
  if (next) {
    assignHost(room, next);
    return { changed: true, previous: host, next };
  }
  if (!host || host.membership === "kicked") {
    const changed = room.hostPlayerId !== "";
    room.hostPlayerId = "";
    room.hostReconnectDeadlineAt = undefined;
    return { changed, previous: host };
  }
  return { changed: false };
};

/**
 * 座位上线时调用（`bindSeat` 末尾）。回来的是房主本人：清截止。
 * 房主空缺、悬空，或离线且宽限已过：当场按候选规则改选（回来的人此刻在线，必然有人当选）。
 * 返回回来的这个座位是否成了房主。
 */
export const healHostOnAttach = (
  room: RoomCore,
  seats: Iterable<SeatCore>,
  seat: SeatCore,
  now: number
): boolean => {
  if (room.hostPlayerId === seat.id) {
    room.hostReconnectDeadlineAt = undefined;
    return false;
  }
  if (!isEligible(seat)) return false;
  const list = toList(seats);
  if (!needsSuccessor(room, seatById(list, room.hostPlayerId), now)) return false;
  const next = pickNextHost(list);
  if (!next) return false;
  assignHost(room, next);
  return next.id === seat.id;
};

/**
 * 手动转让的目标校验：在线、active、非机器人。
 * TODO(行为统一)：猜歌回 `INVALID_TARGET`，CEE 回 `INVALID_PLAYER`，卧底今天不校验在线与真人
 * （接入即修）。接入时 CEE 传自己的现值；统一错误码后删掉 `error` 参数。
 */
export function assertTransferTarget(
  target: SeatCore | undefined,
  error: TransferTargetError = INVALID_TRANSFER_TARGET
): asserts target is SeatCore {
  if (!target || !target.online || target.membership !== "active" || target.isBot === true) {
    throw new AppError(error.code, error.message);
  }
}

/** 手动转让：校验目标后改写房主，转让即清重连截止。「不能转给自己」等玩法文案由调用方先判。 */
export const transferHost = (
  room: RoomCore,
  target: SeatCore | undefined,
  error: TransferTargetError = INVALID_TRANSFER_TARGET
): void => {
  assertTransferTarget(target, error);
  assignHost(room, target);
};
