import { TEST_ROOM_ID } from "@/config/Constants";
import type { CEEPhase, CEERoomSnapshot, CEESource } from "@bakagame/shared";

/**
 * 统一房号目录保证同一时刻一个 4 位号只属于一个房间（增强房或原版房），
 * 因此会话凭据只按房号存储；上游来源与配置标识都由服务端会话表判定。
 */
export function normalizeCEERoomId(roomId: string): string {
  const trimmed = roomId.trim();
  return trimmed.toLowerCase() === TEST_ROOM_ID.toLowerCase() ? TEST_ROOM_ID : trimmed;
}

const sessionKey = (roomId: string) => `cee_session:${encodeURIComponent(normalizeCEERoomId(roomId))}`;
export function readCEESession(roomId: string): string | null {
  try { return sessionStorage.getItem(sessionKey(roomId)); }
  catch { return null; }
}

export function writeCEESession(roomId: string, token: string) {
  try { sessionStorage.setItem(sessionKey(roomId), token); }
  catch { /* 标签页存储不可用时仍允许本次连接游玩。 */ }
}

export function removeCEESession(roomId: string) {
  try { sessionStorage.removeItem(sessionKey(roomId)); }
  catch { /* 存储被浏览器禁用时无可清理的凭据。 */ }
}

export const ceeRoomPath = (roomId: string) => `/cee/room/${encodeURIComponent(normalizeCEERoomId(roomId))}`;

export const CEE_SOURCE_LABELS: Record<CEESource, string> = { native: "增强房", original: "原版房" };

/**
 * 顶栏显示的局数。两种来源的 `roundNumber` 都在进入猜测时才递增，
 * 选出题人、准备与出题阶段属于即将开始的下一局；其余阶段显示最近开始的一局，0 表示尚未开局。
 */
export function ceeDisplayRound(phase: CEEPhase, roundNumber: number): number {
  return phase === "choosingSetter" || phase === "preparing" || phase === "answering" ? roundNumber + 1 : roundNumber;
}

/**
 * 顶栏视角徽章，口径与玩家栏一致：出题人看得到答案，旁观者不参与本局。
 * 出题人在出题阶段状态仍是 `waiting`，只能按 `setterPlayerId` 判定且优先；其队友、中途加入者本局记为 `observing`。
 * 等待与选出题人阶段还没开局，玩家栏只显示准备状态，残留的出题人与观战标记不作数，只看旁观分组。
 */
export function ceePerspective(snapshot: Pick<CEERoomSnapshot, "phase" | "players" | "setterPlayerId">, playerId: string): "setter" | "observer" | null {
  const me = snapshot.players.find((player) => player.id === playerId);
  if (!me) return null;
  const inRound = snapshot.phase !== "waiting" && snapshot.phase !== "choosingSetter";
  if (inRound && snapshot.setterPlayerId === me.id) return "setter";
  return me.membership === "spectator" || (inRound && me.status === "observing") ? "observer" : null;
}
