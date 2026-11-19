import type { CEEPlayerRecord, CEERoom } from "../domain/CEEModel";
import { AppError } from "../domain/Errors";
import { isCEEAntiCheatRoom } from "../shared/Index";
import { createEvent } from "../transport/Packets";
import type { ConnectionRegistry } from "./ConnectionRegistry";

/** 旁观审批需要的房间容器能力：时钟、连接登记与按座位号取成员；由房间容器自身满足。 */
export interface SpectateContext {
  readonly now: () => number;
  readonly connections: ConnectionRegistry;
  member(room: CEERoom, id: string): CEEPlayerRecord;
}

/** 反作弊房里旁观请求的等待上限：超时自动拒绝，房主挂机不会让请求永久悬空。 */
export const CEE_SPECTATE_APPROVAL_TIMEOUT_MS = 120_000;
/** 一间房最多挂多少个待批准请求：防止刷请求骚扰房主。 */
export const CEE_SPECTATE_QUEUE_MAX = 8;

/**
 * 旁观切换。反作弊房里改为登记请求等房主批准，返回 `true` 表示进入待批准态；
 * 其它房间沿用旧口径直接生效。
 */
export function requestSpectate(
  ctx: SpectateContext,
  room: CEERoom,
  player: CEEPlayerRecord,
  spectator: boolean
): boolean {
  if (!spectator) {
    room.spectatorRequests.delete(player.id);
    player.membership = "active";
    player.ready = false;
    return false;
  }
  if (!room.allowSpectators) throw new AppError("SPECTATING_DISABLED", "该房间不允许观战");
  if (!isCEEAntiCheatRoom(room.settings)) {
    player.membership = "spectator";
    player.ready = false;
    return false;
  }
  // 旁观本身要登录：游客身份没有可追溯性，而旁观能看到出题人视角与答案。
  if (!player.account) throw new AppError("LOGIN_REQUIRED", "该房间要求全部成员已登录");
  if (player.membership === "spectator") return false;
  if (
    !room.spectatorRequests.has(player.id) &&
    room.spectatorRequests.size >= CEE_SPECTATE_QUEUE_MAX
  )
    throw new AppError("SPECTATE_QUEUE_FULL", "待房主批准的旁观请求已满");
  room.spectatorRequests.set(player.id, ctx.now());
  player.membership = "pendingSpectator";
  player.ready = false;
  return true;
}
/** 房主处理旁观请求。拒绝立即退回参与态，不等 120 秒超时；结果单独回给请求方以便提示。 */
export function approveSpectate(
  ctx: SpectateContext,
  room: CEERoom,
  id: string,
  approved: boolean
): void {
  if (!isCEEAntiCheatRoom(room.settings))
    throw new AppError("SPECTATE_NOT_PENDING", "该房间不需要批准旁观");
  if (!room.spectatorRequests.has(id))
    throw new AppError("SPECTATE_NOT_PENDING", "该旁观请求已经处理");
  const player = ctx.member(room, id);
  room.spectatorRequests.delete(id);
  player.membership = approved ? "spectator" : "active";
  const connection = player.connectionId
    ? ctx.connections.findConnection(player.connectionId)
    : undefined;
  connection?.send(createEvent("cee.player.spectateResult", { approved }));
}
export function expireSpectateRequests(room: CEERoom, now: number): boolean {
  if (room.spectatorRequests.size === 0) return false;
  let changed = false;
  for (const [playerId, requestedAt] of room.spectatorRequests)
    if (now - requestedAt >= CEE_SPECTATE_APPROVAL_TIMEOUT_MS || !room.players.has(playerId)) {
      room.spectatorRequests.delete(playerId);
      const player = room.players.get(playerId);
      if (player?.membership === "pendingSpectator") player.membership = "active";
      changed = true;
    }
  return changed;
}
