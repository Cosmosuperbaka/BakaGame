import type { WhoIsFakerRoomRecord } from "../../shared/Index";
import { dissolveRoom } from "../room/SeatBinding";
import type { WhoIsFakerContext } from "./Context";
import { publishLobby } from "./RoomPublish";

/**
 * 房间销毁 = 这一局结束：收尾对局记录、通知并解绑全部连接、清本房全部定时器，
 * 随后清玩法旁表、删房、记日志、刷新大厅。巡检、离线结算、后台三处共用。
 */
export const closeRoom = async (
  ctx: WhoIsFakerContext,
  room: WhoIsFakerRoomRecord,
  reason: string
) => {
  dissolveRoom(ctx.seatContext, room, { roomId: room.id, reason });

  ctx.rooms.delete(room.id);
  if (room.round) ctx.roundStartedAtById.delete(room.round.id);
  ctx.publishedPhaseKeyByRoomId.delete(room.id);
  ctx.gameOverAdvanceAllowedAtByRoomId.delete(room.id);
  await ctx.log({
    type: "room.closed",
    createdAt: ctx.now(),
    roomId: room.id,
    payload: {
      reason,
    },
  });
  publishLobby(ctx);
};

/**
 * 空房是否应当自动关闭。测试房间要能在最后一人刷新页面后仍然存在，
 * 否则每次刷新都会丢掉正在调试的房间状态。
 */
export const shouldAutoCloseWhenEmpty = (ctx: WhoIsFakerContext, room: WhoIsFakerRoomRecord) => {
  return !ctx.testRooms.isTestRoom(room.id);
};
