import type { CCBSource } from "@bakagame/shared";

/**
 * 统一房号目录保证同一时刻一个 4 位号只属于一个房间（增强房或原版房），
 * 因此会话凭据只按房号存储；上游来源与配置标识都由服务端会话表判定。
 */
const sessionKey = (roomId: string) => `ccb_session:${encodeURIComponent(roomId)}`;
export function readCCBSession(roomId: string): string | null {
  try { return sessionStorage.getItem(sessionKey(roomId)); }
  catch { return null; }
}

export function writeCCBSession(roomId: string, token: string) {
  try { sessionStorage.setItem(sessionKey(roomId), token); }
  catch { /* 标签页存储不可用时仍允许本次连接游玩。 */ }
}

export function removeCCBSession(roomId: string) {
  try { sessionStorage.removeItem(sessionKey(roomId)); }
  catch { /* 存储被浏览器禁用时无可清理的凭据。 */ }
}

export const ccbRoomPath = (roomId: string) => `/ccb/room/${encodeURIComponent(roomId)}`;

export const CCB_SOURCE_LABELS: Record<CCBSource, string> = { native: "增强房", original: "原版房" };
