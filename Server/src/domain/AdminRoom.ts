import type { RecordedGame } from "./GameRecord";

/** 管理后台看到的房间成员：不含会话令牌、身份与词语等对局秘密。 */
export interface AdminRoomPlayer {
  id: string;
  name: string;
  online: boolean;
  membership: string;
  host: boolean;
  bot: boolean;
  userId: string | null;
}

export interface AdminRoomView {
  game: RecordedGame;
  roomId: string;
  name: string;
  phase: string;
  visibility: "public" | "private";
  hasPassword: boolean;
  /** 测试房与猜歌单人房：不进大厅，但后台照样列出。 */
  hidden: boolean;
  roundNumber: number;
  createdAt: number;
  lastActiveAt: number;
  players: AdminRoomPlayer[];
}

/**
 * 三款游戏各自实现的后台房间控制口。房间状态只在游戏服务内部修改，
 * 后台只经由这里关房或移人，复用游戏自己的通知、换房主与结算口径。
 * 目标不存在时抛 `ROOM_NOT_FOUND` / `PLAYER_NOT_FOUND`。
 */
export interface AdminRoomControl {
  adminListRooms(): AdminRoomView[];
  adminCloseRoom(roomId: string): Promise<void>;
  adminKickPlayer(roomId: string, playerId: string): Promise<void>;
}

/** 后台关房的原因码（谁是卧底、猜歌的 `room.closed` 原因字段）与直接展示的文案（CEE）。 */
export const ADMIN_CLOSE_REASON = "admin_closed";
export const ADMIN_CLOSE_MESSAGE = "房间已被管理员关闭";
export const ADMIN_KICK_MESSAGE = "你已被管理员移出房间";
