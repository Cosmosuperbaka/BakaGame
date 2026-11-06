import { protocolErrorCode } from "@bakagame/shared/values";
import { serverRestartedRecently } from "@/lib/TabSession";

/**
 * 恢复房间命中永久错误（见共享 `PERMANENT_ROOM_ERROR_CODES`）时给玩家看的说明。
 * 三款游戏只是提示通道不同，文案口径只有这一份。
 */
export const permanentRoomErrorMessage = (error: unknown): string => {
  const code = protocolErrorCode(error);
  if (code === "SESSION_NOT_FOUND" || code === "SESSION_INVALID")
    return "原座位已失效，可能掉线过久或房间已重建";
  if (code === "PLAYER_KICKED") return "你已被移出房间";
  return serverRestartedRecently() ? "服务器已重启，房间未能恢复" : "房间已解散或不存在";
};

/**
 * 恢复失败后这间房还能不能回去。座位失效时房间还在，页面照常重新加入；房间没了或人被移出时
 * 必须退回大厅：继续走「房号不存在就开一间」只会悄悄造出一间同号空房，
 * 后面刷新的人再撞上这间新房，就成了他们的「座位失效」。
 */
export const roomIsGone = (error: unknown): boolean => {
  const code = protocolErrorCode(error);
  return code === "ROOM_NOT_FOUND" || code === "PLAYER_KICKED";
};
