// 用户名 cookie 读写（静默保存）

const USERNAME_KEY = "wif_username";
const SESSION_PREFIX = "wif_session_";
const TEST_ROOM_ID = "Oblivionis";

function normalizeSessionRoomId(roomId: string): string {
  const normalized = roomId.trim();
  return normalized.toLowerCase() === TEST_ROOM_ID.toLowerCase()
    ? TEST_ROOM_ID
    : normalized;
}

export function isTestRoomId(roomId: string): boolean {
  return normalizeSessionRoomId(roomId) === TEST_ROOM_ID;
}

function getSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function getLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getSavedUsername(): string {
  try {
    return localStorage.getItem(USERNAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveUsername(name: string): void {
  try {
    localStorage.setItem(USERNAME_KEY, name);
  } catch {
    // 忽略
  }
}

export function getSessionToken(roomId: string): string | null {
  const normalizedRoomId = normalizeSessionRoomId(roomId);
  const storageKey = SESSION_PREFIX + normalizedRoomId;
  const sessionStorage = getSessionStorage();
  const localStorage = getLocalStorage();

  const sessionToken = sessionStorage?.getItem(storageKey);
  if (sessionToken) {
    return sessionToken;
  }

  const legacyToken =
    localStorage?.getItem(storageKey) ??
    (normalizedRoomId === roomId ? null : localStorage?.getItem(SESSION_PREFIX + roomId)) ??
    null;

  if (legacyToken && sessionStorage) {
    sessionStorage.setItem(storageKey, legacyToken);
    localStorage?.removeItem(storageKey);
    if (normalizedRoomId !== roomId) {
      localStorage?.removeItem(SESSION_PREFIX + roomId);
    }
  }

  return legacyToken;
}

export function saveSessionToken(roomId: string, token: string): void {
  const normalizedRoomId = normalizeSessionRoomId(roomId);
  const storageKey = SESSION_PREFIX + normalizedRoomId;
  const sessionStorage = getSessionStorage();
  const localStorage = getLocalStorage();

  try {
    sessionStorage?.setItem(storageKey, token);
    localStorage?.removeItem(storageKey);
    if (normalizedRoomId !== roomId) {
      localStorage?.removeItem(SESSION_PREFIX + roomId);
      sessionStorage?.removeItem(SESSION_PREFIX + roomId);
    }
  } catch {
    // 忽略
  }
}

export function clearSessionToken(roomId: string): void {
  const normalizedRoomId = normalizeSessionRoomId(roomId);
  const storageKey = SESSION_PREFIX + normalizedRoomId;
  const sessionStorage = getSessionStorage();
  const localStorage = getLocalStorage();

  try {
    sessionStorage?.removeItem(storageKey);
    localStorage?.removeItem(storageKey);
    if (normalizedRoomId !== roomId) {
      sessionStorage?.removeItem(SESSION_PREFIX + roomId);
      localStorage?.removeItem(SESSION_PREFIX + roomId);
    }
  } catch {
    // 忽略
  }
}
