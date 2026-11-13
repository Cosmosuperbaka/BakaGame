import { dissolveRoom } from "../room/SeatBinding";
import type { SonGuessrContext } from "./Context";
import { wakeMusicPoolWaiters } from "./MusicPool";
import type { SonGuessrRoomRecord } from "./Records";

export function closeRoom(ctx: SonGuessrContext, room: SonGuessrRoomRecord, reason: string) {
  // 房间销毁 = 这一局结束：收尾对局记录、通知并解绑全部连接，随后清玩法旁表、删房、刷新大厅。
  dissolveRoom(ctx.kernel, room, { roomId: room.id, reason });
  room.musicPool = [];
  // 房间没了：叫醒仍在等号的请求，让它们下一轮检查直接返回无租约。
  wakeMusicPoolWaiters(ctx, room.id);
  ctx.rooms.delete(room.id);
  ctx.publishLobby();
}
