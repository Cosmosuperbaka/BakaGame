import type { CCBSource } from "@bakagame/shared";

const sessionKey = (source: CCBSource, serverKey: string, roomId: string) =>
  `ccb_session:${source}:${encodeURIComponent(serverKey)}:${encodeURIComponent(roomId)}`;

export function readCCBSession(source: CCBSource, serverKey: string, roomId: string): string | null {
  try { return sessionStorage.getItem(sessionKey(source, serverKey, roomId)); }
  catch { return null; }
}

export function writeCCBSession(source: CCBSource, serverKey: string, roomId: string, token: string) {
  try { sessionStorage.setItem(sessionKey(source, serverKey, roomId), token); }
  catch { /* 标签页存储不可用时仍允许本次连接游玩。 */ }
}

export function removeCCBSession(source: CCBSource, serverKey: string, roomId: string) {
  try { sessionStorage.removeItem(sessionKey(source, serverKey, roomId)); }
  catch { /* 存储被浏览器禁用时无可清理的凭据。 */ }
}

export const ccbRoomPath = (source: CCBSource, roomId: string) =>
  `/ccb/room/${source}/${encodeURIComponent(roomId)}`;

export const CCB_SOURCE_LABELS: Record<CCBSource, string> = { native: "增强房", original: "原版房" };
