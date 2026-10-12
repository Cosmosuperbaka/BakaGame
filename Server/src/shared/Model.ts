// ==================== 平台通用常量与基础模型 ====================
// 本文件仅定义跨小游戏（WhoIsFaker、SonGuessr 等）通用的平台级基础设施与模型契约。
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

/**
 * 已登录玩家在房间内公开的账号身份：只有用户 ID 与站内头像地址，资料卡再按 ID 拉取。
 * 游戏昵称与账号昵称互不捆绑，这里不带账号昵称；QQ 号永不进入房间快照。
 */
export interface PlayerAccount {
  userId: string;
  /** 站内代理头像（`/api/account/avatar/<id>?v=<摘要>`）；首次抓取完成前为空。 */
  image: string | null;
}

// 平台注册到连接池里的最小连接抽象。
export interface ConnectionRecord {
  id: string;
  /** 握手时由会话 Cookie 解析出的账号；游客为空。 */
  account?: PlayerAccount;
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
