// ==================== 平台通用常量与基础模型 ====================
// 本文件仅定义跨小游戏（WhoIsFaker、SonGuessr 等）通用的平台级基础设施与模型契约。
// 各游戏特有模型请至对应领域文件（如 WhoIsFaker.ts, SonGuessr.ts）。

import { Type as t, type Static, type TSchema } from "@sinclair/typebox";

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

/**
 * 房间可见性：三款游戏同一个契约，类型与运行时校验只在这里写一次。
 * 游戏侧的建房/改设置载荷一律引用 `RoomVisibilitySchema`，不再各自抄一遍字面量。
 */
export const RoomVisibilitySchema = t.Union([t.Literal("public"), t.Literal("private")]);
export type RoomVisibility = Static<typeof RoomVisibilitySchema>;
export type PlayerMembership = "active" | "spectator" | "kicked";
export type ChatChannel = "main" | "ghost";

/**
 * 「房间或会话已不可恢复」的错误码：命中这些码时客户端必须退出房间并清掉本地凭据，
 * 不能把它当成一次可重连的网络抖动。三款游戏在这一组码上口径一致，所以只在平台层写一次；
 * 玩法专属的会话码（例如 CEE 连到原版服务器的那几个）由各自领域自行追加，不并回这张表。
 */
export const PERMANENT_ROOM_ERROR_CODES = [
  "ROOM_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "SESSION_INVALID",
  "PLAYER_KICKED",
] as const;

/** 码表是字面量元组：消费端分支可以穷尽它，新增码时漏改会在编译期暴露。 */
export type PermanentRoomErrorCode = (typeof PERMANENT_ROOM_ERROR_CODES)[number];

export const isPermanentRoomErrorCode = (code: string): boolean =>
  PERMANENT_ROOM_ERROR_CODES.some((known: string) => known === code);

/**
 * 协议错误体的 code。客户端 store 一律从这里取而不是各自写 `as` 断言：
 * 断言散在调用点上时，错误对象形态一变就会静默读到 undefined，判定跟着悄悄翻转。
 */
export const protocolErrorCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

/** 命中永久码：重试与换 token 都救不回来，房间侧状态只能整体丢弃。 */
export const isPermanentRoomError = (error: unknown): boolean => {
  const code = protocolErrorCode(error);
  return code !== undefined && isPermanentRoomErrorCode(code);
};

// 房间聊天与系统提示共用一个消息结构，靠 system 字段区分。
export interface ChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  text: string;
  createdAt: number;
  system: boolean;
  /** 点过 +1 的玩家 ID；同一人重复点即撤销，长度就是去重后的计数。 */
  plusOneBy?: string[];
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

/**
 * 一次成功的通道证明落在连接上的最小结论：谁（`clientId`）、什么平台、哪个版本。
 * 验签细节留在传输层，业务层只问「有没有」，不再二次判断签名。
 */
export interface ClientChannelProof {
  clientId: string;
  clientType: "desktop" | "mobile";
  clientVersion: string;
  keyProtection: "hardware" | "software";
  /**
   * 自检软失败命中一次时为可疑：放行但如实标记，供后续行为特征与人工复核参考。
   * `software` 表示该平台没有硬件级密钥保护，只作标记不影响准入。
   */
  integrity?: "clean" | "suspect";
  /** 低于服务端最低支持版本：普通房不受影响，反作弊房据此回 `CLIENT_OUTDATED`。 */
  outdated?: boolean;
}

// 平台注册到连接池里的最小连接抽象。
export interface ConnectionRecord {
  id: string;
  /** 握手时由会话 Cookie 解析出的账号；游客为空。 */
  account?: PlayerAccount;
  /**
   * 握手时解析出的来源地址，按地址聚合的配额用它分桶。
   * 连接号由服务端每次握手新发，重连即换新桶，所以只按连接计的额度会被多开连接线性放大。
   */
  clientIp?: string;
  /**
   * 已验签通过的客户端通道证明：只有壳（桌面 / 移动）能给出，浏览器与自写客户端为空。
   * 反作弊房据此拒绝 Web 接入，普通房不读这个字段，因而对现有玩家零影响。
   */
  clientChannel?: ClientChannelProof;
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

/**
 * 客户端指令信封的运行时骨架，与 `Protocol.ts` 的 `ClientEnvelope` 同一契约。
 *
 * 每款游戏只提供 `type` 与 `payload`，信封字段与其上限在这里唯一维护：三个玩法逐字抄
 * 三份时，改一处不会传导到另两处（信封的严格性、字段上限正是最容易漂移的地方）。
 * 与静态类型不同源的 nullable 信封变体（CEE 线路层）按各自领域文档保持现状。
 */
export const createClientEnvelopeSchema = <TType extends string, TPayload extends TSchema>(
  type: TType,
  payload: TPayload
) =>
  t.Object(
    {
      id: t.String({ minLength: 1, maxLength: 128 }),
      type: t.Literal(type),
      traceId: t.Optional(t.String({ maxLength: 128 })),
      roomId: t.Optional(t.String({ maxLength: 32 })),
      sessionToken: t.Optional(t.String({ maxLength: 128 })),
      payload,
    },
    { additionalProperties: false }
  );
