import { protocolErrorCode } from "@bakagame/shared";

/**
 * 恢复房间命中永久错误（见共享 `PERMANENT_ROOM_ERROR_CODES`）时给玩家看的说明。
 * 卧底与猜歌只是提示通道不同（队列 / 单槽），文案口径只有这一份。
 */
export const permanentRoomErrorMessage = (error: unknown): string => {
  const code = protocolErrorCode(error);
  if (code === "SESSION_NOT_FOUND" || code === "SESSION_INVALID") return "会话已失效，请重新加入";
  if (code === "PLAYER_KICKED") return "你已被移出房间";
  return "房间已解散或不存在";
};
