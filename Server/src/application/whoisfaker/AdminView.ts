import { ADMIN_CLOSE_REASON, type AdminRoomView } from "../../domain/AdminRoom";
import { AppError } from "../../domain/Errors";
import { adminRoomView, countOnline, requireAdminRoom } from "../room/RoomSummaries";
import type { WhoIsFakerContext } from "./Context";
import { closeRoom } from "./RoomClosure";
import { kickPlayer } from "./RoomLifecycle";

/** 运维视角：健康快照与后台的房间列表、关房、移人。 */
export const getHealthSnapshot = (ctx: WhoIsFakerContext) => {
  return {
    roomCount: ctx.rooms.size,
    connectionCount: ctx.connectionRegistry.stats.totalConnections,
    onlinePlayerCount: [...ctx.rooms.values()].reduce(
      (sum, room) => sum + countOnline(Object.values(room.players)),
      0
    ),
  };
};

export const adminListRooms = (ctx: WhoIsFakerContext): AdminRoomView[] => {
  return [...ctx.rooms.values()].map((room) =>
    adminRoomView(room, Object.values(room.players), {
      game: "faker",
      name: room.settings.name,
      phase: room.round?.phase ?? "waiting",
      visibility: room.settings.visibility,
      hidden: ctx.testRooms.isTestRoom(room.id),
      roundNumber: room.roundCount ?? 0,
    })
  );
};

export const adminCloseRoom = async (ctx: WhoIsFakerContext, roomId: string): Promise<void> => {
  await closeRoom(ctx, requireAdminRoom(ctx.rooms, roomId), ADMIN_CLOSE_REASON);
};

export const adminKickPlayer = async (
  ctx: WhoIsFakerContext,
  roomId: string,
  playerId: string
): Promise<void> => {
  const room = requireAdminRoom(ctx.rooms, roomId);
  const target = room.players[playerId];
  if (!target || target.membership === "kicked")
    throw new AppError("PLAYER_NOT_FOUND", "目标玩家不存在");
  await kickPlayer(ctx, room, target, "管理员");
};
