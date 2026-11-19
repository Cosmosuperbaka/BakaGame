import { AppError } from "../../domain/Errors";
import { normalizeName } from "../../domain/Rules";
import { assertTextAllowed } from "../../infrastructure/SensitiveText";
import type { WhoIsFakerContext } from "./Context";
import { ensureUniqueName, type WhoIsFakerSeatAt } from "./RoomAccess";
import { publishLobby, publishRoom } from "./RoomPublish";
import { normalizeRoomRoleConfig } from "./RoundRules";

/**
 * 玩家自己的三条命令：改名、切换旁观、准备。
 * 「被移出」「回合进行中」这类固定前置判定由命令表守卫完成，这里只剩依赖载荷的判定与写入。
 */

export const renamePlayer = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  nextName: string
) => {
  const { room, seat: player } = at;
  const normalized = normalizeName(nextName);

  if (!normalized) {
    throw new AppError("INVALID_NAME", "用户名不能为空");
  }

  if (player.name === normalized) {
    return { name: player.name };
  }

  assertTextAllowed(normalized);

  ensureUniqueName(room, normalized, player.id);
  player.name = normalized;
  player.lastSeenAt = ctx.now();
  ctx.touch(room);

  await ctx.log({
    type: "player.renamed",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
    payload: { name: player.name },
  });

  publishRoom(ctx, room);
  return { name: player.name };
};

export const setSpectator = async (
  ctx: WhoIsFakerContext,
  at: WhoIsFakerSeatAt,
  spectator: boolean
) => {
  // 阵营切换只允许发生在局外（由命令表守卫保证），避免游戏中角色池被动态篡改。
  const { room, seat: player } = at;

  if (spectator && !room.settings.allowSpectators) {
    throw new AppError("SPECTATOR_DISABLED", "当前房间不允许旁观");
  }

  player.membership = spectator ? "spectator" : "active";
  player.isReady = false;
  normalizeRoomRoleConfig(room);
  ctx.touch(room);

  await ctx.log({
    type: "player.membership_changed",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
    payload: { membership: player.membership },
  });

  publishRoom(ctx, room);
  publishLobby(ctx);
  return { membership: player.membership };
};

export const setReady = async (ctx: WhoIsFakerContext, at: WhoIsFakerSeatAt, ready: boolean) => {
  const { room, seat: player } = at;

  player.isReady = ready;
  ctx.touch(room);

  await ctx.log({
    type: "player.ready_changed",
    createdAt: ctx.now(),
    roomId: room.id,
    playerId: player.id,
    payload: { ready },
  });

  publishRoom(ctx, room);
  return { ready };
};
