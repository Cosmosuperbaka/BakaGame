import { TEST_ROOM_ID } from "@/config/Constants";
import { notifyPreferencesChanged } from "@/lib/PreferenceBus";
import { localStore, sessionStore } from "@/lib/SafeStorage";

/**
 * 存储键命名空间。
 *
 * 用户名（`bakagame:username`）是三个游戏共用的玩家身份，不归属任何单一玩法；
 * 会话凭据按玩法分前缀，与路由、API 路径的 `whoisfaker` / `songuessr` 口径一致。
 */
export const USERNAME_KEY = "bakagame:username";
/** 猜歌音量（0–1 的字符串）。 */
export const SONG_VOLUME_KEY = "songuessr_volume";
const SESSION_PREFIX = "whoisfaker_session_";
const SONG_SESSION_PREFIX = "songuessr_session_";
export const CEE_SESSION_PREFIX = "cee_session:";
const SOLO_ROOM_KEY = "songuessr_solo_room";

/**
 * 房号规范化：去掉首尾空白，测试房号统一成服务端使用的规范大小写。
 * 服务端 `ensureRoomId` 做同一件事，会话键与房间页都必须用规范化结果，
 * 否则小写直链（如 /whoisfaker/room/oblivionis）拿到的快照房号与路由参数不等。
 */
export function normalizeRoomId(roomId: string): string {
  const normalized = roomId.trim();
  return normalized.toLowerCase() === TEST_ROOM_ID.toLowerCase() ? TEST_ROOM_ID : normalized;
}

/**
 * 按房号存放的座位令牌：键 = 前缀 + 规范化房号，存在标签页存储里，关标签页即灭。
 * 三种凭据（卧底、猜歌）形态相同，只差前缀。
 */
const createRoomTokenStore = (prefix: string) => ({
  get: (roomId: string): string | null => sessionStore.get(prefix + normalizeRoomId(roomId)),
  save: (roomId: string, token: string): void => {
    sessionStore.set(prefix + normalizeRoomId(roomId), token);
  },
  clear: (roomId: string): void => sessionStore.remove(prefix + normalizeRoomId(roomId)),
});

const whoIsFakerTokens = createRoomTokenStore(SESSION_PREFIX);
const sonGuessrTokens = createRoomTokenStore(SONG_SESSION_PREFIX);

export function getSavedUsername(): string {
  return localStore.get(USERNAME_KEY) ?? "";
}

export function saveUsername(name: string): void {
  if (localStore.set(USERNAME_KEY, name)) notifyPreferencesChanged();
}

/**
 * 直链进房且本地没存过名字时的兜底用户名：与另外两个游戏一致，不弹设置用户名弹窗。
 * 用 4 位随机数避免同房重名，长度落在协议上限（32）内。
 */
export function guestName(): string {
  return `玩家${Math.floor(1000 + Math.random() * 9000)}`;
}

/**
 * 丢掉本标签页的全部座位凭证：这份存储是从别的标签页继承来的，留着就会坐到人家的座位上。
 * 昵称在 localStorage，本就是跨标签页共用的，不受影响。
 */
export function clearSeatCredentials(): void {
  const seatKeys = [SESSION_PREFIX, SONG_SESSION_PREFIX, CEE_SESSION_PREFIX].flatMap((prefix) =>
    sessionStore.keys(prefix)
  );
  for (const key of [...seatKeys, SOLO_ROOM_KEY]) sessionStore.remove(key);
}

export const getSessionToken = whoIsFakerTokens.get;
export const saveSessionToken = whoIsFakerTokens.save;
export const clearSessionToken = whoIsFakerTokens.clear;

export const getSonGuessrSessionToken = sonGuessrTokens.get;
export const saveSonGuessrSessionToken = sonGuessrTokens.save;
export const clearSonGuessrSessionToken = sonGuessrTokens.clear;

/** 单人模式房间号：刷新页面后仍可重连同一局，退出单人模式时清除。 */
export function getSongSoloRoomId(): string | null {
  return sessionStore.get(SOLO_ROOM_KEY);
}

export function saveSongSoloRoomId(roomId: string): void {
  sessionStore.set(SOLO_ROOM_KEY, roomId);
}

export function clearSongSoloRoomId(): void {
  sessionStore.remove(SOLO_ROOM_KEY);
}
