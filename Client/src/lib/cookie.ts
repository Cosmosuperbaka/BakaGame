import { TEST_ROOM_ID } from "@/config/constants";

const USERNAME_KEY = "wif_username";
const SESSION_PREFIX = "wif_session_";

function normalizeSessionRoomId(roomId: string): string {
  const normalized = roomId.trim();
  return normalized.toLowerCase() === TEST_ROOM_ID.toLowerCase()
    ? TEST_ROOM_ID
    : normalized;
}

function getSessionKey(roomId: string): string {
  return SESSION_PREFIX + normalizeSessionRoomId(roomId);
}

function getSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
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
