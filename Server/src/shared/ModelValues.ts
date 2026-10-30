// ==================== 平台通用纯值 ====================
// 客户端从这里取值；本文件不得引入任何 schema 构造模块。

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
