import type {
  ConnectionRecord,
  WhoIsFakerPlayerRecord,
  WhoIsFakerRoomRecord,
} from "../../shared/Index";
import { bindSeat } from "../room/SeatBinding";
import type { WhoIsFakerContext } from "./Context";
import { handlePlayerOffline } from "./OfflineSettlement";

export const attachConnection = (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  player: WhoIsFakerPlayerRecord,
  connection: ConnectionRecord
) => {
  // 目标先校验；旧席位断线状态和新绑定在首次 await 前完成，防止并发建房/同名加入穿透。
  // handlePlayerOffline 的 disconnect 分支在首个 await 前完成所有领域状态变更，
  // 它会把连接从旧席位上解下来：内核的 bindSeat 要求连接空闲，旧席位必须先按玩法规则释放。
  const previousRoom = connection.roomId ? ctx.rooms.get(connection.roomId) : undefined;
  const previousRoomUpdate =
    previousRoom &&
    connection.playerId &&
    (previousRoom.id !== room.id || connection.playerId !== player.id)
      ? handlePlayerOffline(ctx, previousRoom, connection.playerId, "disconnect")
      : Promise.resolve();

  // 房主空缺或宽限已过时，回来的人可能当场接任（也可能是另一位在线正式玩家）。
  const hostBefore = room.players[room.hostPlayerId];
  bindSeat(ctx.seatContext, room, player, connection);
  const hostAfter = room.players[room.hostPlayerId];
  if (hostAfter && hostAfter !== hostBefore) {
    ctx.appendSystemMessage(
      room,
      hostBefore
        ? `${hostBefore.name} 断线超时，房主已转移给 ${hostAfter.name}`
        : `房主已转移给 ${hostAfter.name}`
    );
  }
  return previousRoomUpdate;
};
