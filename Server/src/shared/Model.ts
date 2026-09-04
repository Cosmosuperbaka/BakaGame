// ==================== 平台通用常量与基础模型 ====================
// 本文件仅定义跨小游戏（WhoIsFaker、SonGuessr、CCB 等）通用的平台级基础设施与模型契约。
// 各游戏特有模型请至对应领域文件（如 WhoIsFaker.ts, SonGuessr.ts）。

// 特殊房间号：进入测试模式，可用阶段控制器跳转、手动增减 Bot。
// 规则与普通房间完全一致，不会自动补人。
export const ROOM_ID_TEST_MODE = "Oblivionis";

/**
 * 房间号是否合法：普通房间为四位数字，测试房间号大小写不敏感。
 * 服务端 ensureRoomId 与客户端路由校验共用这一份规则。
 */
export const isValidRoomId = (roomId: string): boolean => {
  const normalized = roomId.trim();
  if (normalized.toLowerCase() === ROOM_ID_TEST_MODE.toLowerCase()) return true;
  return /^\d{4}$/.test(normalized);
};

export type RoomVisibility = "public" | "private";
export type PlayerMembership = "active" | "spectator" | "kicked";
export type ChatChannel = "main" | "ghost";

// 房间聊天与系统提示共用一个消息结构，靠 system 字段区分。
export interface ChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  createdAt: number;
  system: boolean;
  channel?: ChatChannel;
  ghostRole?: "dead" | "spectator";
}

// 平台注册到连接池里的最小连接抽象。
export interface ConnectionRecord {
  id: string;
  roomId?: string;
  playerId?: string;
  lobbySubscribed: boolean;
  send: (payload: unknown) => void;
  /** 传输层清空该连接的差量基线，下一次状态推送必须发送全量。 */
  resetStateSync?: () => void;
  /** housekeeping 调用；传输层仅在到达校准周期时发送全量状态。 */
  sendStateSyncCalibration?: (payload: unknown) => void;
  /** 发送非状态事件/ACK，统一交给传输层序列化。 */
  sendPacket?: (payload: unknown) => void;
  close: (code?: number, reason?: string) => void;
}

// ==================== 谁是卧底模型重导出（保持全库 100% 向后兼容） ====================
export * from "./WhoIsFaker";

