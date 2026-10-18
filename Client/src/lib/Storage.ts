import { TEST_ROOM_ID } from "@/config/Constants";

/**
 * 存储键命名空间。
 *
 * 用户名（`bakagame:username`）是三个游戏共用的玩家身份，不归属任何单一玩法；
 * 会话凭据按玩法分前缀，与路由、API 路径的 `whoisfaker` / `songuessr` 口径一致。
 * 旧键 `wif_username` / `wif_session_` 只在 `migrateLegacyKeys` 里出现一次，用于一次性搬迁。
 */
export const USERNAME_KEY = "bakagame:username";
/** 猜歌音量（0–1 的字符串）。 */
export const SONG_VOLUME_KEY = "songuessr_volume";
const SESSION_PREFIX = "whoisfaker_session_";
const SONG_SESSION_PREFIX = "songuessr_session_";
const SOLO_ROOM_KEY = "songuessr_solo_room";
const LEGACY_USERNAME_KEY = "wif_username";
const LEGACY_SESSION_PREFIX = "wif_session_";

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

/**
 * 一次性搬迁历史 `wif_*` 键：把共用用户名与当前标签页的卧底会话凭据搬到新键名，随后删掉旧键。
 * 只在目标键为空时搬迁，避免覆盖新版本写入的值；存储被禁用或读写出错时静默放弃，
 * 旧键原样保留（不影响功能，只是本次没迁成）。
 * 幂等且开销极小（旧键一旦搬走就再无命中），因此每次读取都可安全调用，不依赖模块级状态。
 */
function migrateLegacyKeys(): void {
  const local = getLocalStorage();
  const session = getSessionStorage();
  if (!local && !session) return;

  try {
    const legacyName = local?.getItem(LEGACY_USERNAME_KEY);
    if (legacyName !== null && legacyName !== undefined && !local?.getItem(USERNAME_KEY)) {
      local?.setItem(USERNAME_KEY, legacyName);
    }
    local?.removeItem(LEGACY_USERNAME_KEY);

    // 会话凭据：sessionStorage 里现存的所有 wif_session_<roomId> 逐条改名。
    if (session) {
      const legacySessionKeys: string[] = [];
      for (let i = 0; i < session.length; i += 1) {
        const key = session.key(i);
        if (key && key.startsWith(LEGACY_SESSION_PREFIX)) legacySessionKeys.push(key);
      }
      for (const legacyKey of legacySessionKeys) {
        const token = session.getItem(legacyKey);
        const roomId = legacyKey.slice(LEGACY_SESSION_PREFIX.length);
        if (token !== null && !session.getItem(SESSION_PREFIX + roomId)) {
          session.setItem(SESSION_PREFIX + roomId, token);
        }
        session.removeItem(legacyKey);
      }
    }
  } catch {
    // 存储被禁用或中途失败：保留旧键，视为未搬迁。
  }
}

/**
 * 云同步偏好的变更通知（见 lib/CloudSync.ts）：写入同步范围内的本地键后派发，
 * 已登录时由云同步合并上传；云端偏好写回本地后派发 `PREFERENCES_APPLIED`，让已挂载的读取方重读。
 */
export const PREFERENCES_CHANGED = "bakagame:preferences-changed";
export const PREFERENCES_APPLIED = "bakagame:preferences-applied";

export function notifyPreferencesChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PREFERENCES_CHANGED));
}

export function getSavedUsername(): string {
  try {
    migrateLegacyKeys();
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

export function getSessionToken(roomId: string): string | null {
  try {
    migrateLegacyKeys();
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
