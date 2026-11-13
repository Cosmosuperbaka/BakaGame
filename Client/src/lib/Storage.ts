import { TEST_ROOM_ID } from "@/config/Constants";
import { notifyPreferencesChanged } from "@/lib/PreferenceBus";

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

function getSessionKey(roomId: string): string {
  return SESSION_PREFIX + normalizeRoomId(roomId);
}

function getSongSessionKey(roomId: string): string {
  return SONG_SESSION_PREFIX + normalizeRoomId(roomId);
}

function getSessionStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function getLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getSavedUsername(): string {
  try {
    return getLocalStorage()?.getItem(USERNAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveUsername(name: string): void {
  try {
    getLocalStorage()?.setItem(USERNAME_KEY, name);
    notifyPreferencesChanged();
  } catch {
    // 忽略
  }
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
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const seatKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        key &&
        (key === SOLO_ROOM_KEY ||
          key.startsWith(SESSION_PREFIX) ||
          key.startsWith(SONG_SESSION_PREFIX) ||
          key.startsWith(CEE_SESSION_PREFIX))
      )
        seatKeys.push(key);
    }
    for (const key of seatKeys) storage.removeItem(key);
  } catch {
    // 存储被禁用时没有可清理的凭证。
  }
}

export function getSessionToken(roomId: string): string | null {
  try {
    return getSessionStorage()?.getItem(getSessionKey(roomId)) ?? null;
  } catch {
    return null;
  }
}

export function saveSessionToken(roomId: string, token: string): void {
  try {
    getSessionStorage()?.setItem(getSessionKey(roomId), token);
  } catch {
    // 忽略
  }
}

export function clearSessionToken(roomId: string): void {
  try {
    getSessionStorage()?.removeItem(getSessionKey(roomId));
  } catch {
    // 忽略
  }
}

export function getSonGuessrSessionToken(roomId: string): string | null {
  try {
    return getSessionStorage()?.getItem(getSongSessionKey(roomId)) ?? null;
  } catch {
    return null;
  }
}

export function saveSonGuessrSessionToken(roomId: string, token: string): void {
  try {
    getSessionStorage()?.setItem(getSongSessionKey(roomId), token);
  } catch {
    // 忽略浏览器禁用存储的情况。
  }
}

export function clearSonGuessrSessionToken(roomId: string): void {
  try {
    getSessionStorage()?.removeItem(getSongSessionKey(roomId));
  } catch {
    // 忽略浏览器禁用存储的情况。
  }
}

/** 单人模式房间号：刷新页面后仍可重连同一局，退出单人模式时清除。 */
export function getSongSoloRoomId(): string | null {
  try {
    return getSessionStorage()?.getItem(SOLO_ROOM_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveSongSoloRoomId(roomId: string): void {
  try {
    getSessionStorage()?.setItem(SOLO_ROOM_KEY, roomId);
  } catch {
    // 忽略浏览器禁用存储的情况。
  }
}

export function clearSongSoloRoomId(): void {
  try {
    getSessionStorage()?.removeItem(SOLO_ROOM_KEY);
  } catch {
    // 忽略浏览器禁用存储的情况。
  }
}
