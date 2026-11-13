import { useSyncExternalStore } from "react";
import {
  getStoredSongMusicSession,
  onSongMusicSessionChanged,
  type SongMusicPlatform,
  type StoredSongMusicSession,
} from "@/lib/SonGuessrMusicSession";

/**
 * 读存储每次都解析出新对象，而外部存储的快照必须内容不变时引用不变，
 * 所以按内容缓存上一次的结果。
 */
const cache: Partial<
  Record<SongMusicPlatform, { key: string; value: StoredSongMusicSession | null }>
> = {};

function readStable(platform: SongMusicPlatform): StoredSongMusicSession | null {
  const next = getStoredSongMusicSession(platform);
  const key = next ? JSON.stringify([next.cookie, next.account, next.persistent]) : "";
  const cached = cache[platform];
  if (cached?.key === key) return cached.value;
  cache[platform] = { key, value: next };
  return next;
}

/** 本机保存的某个平台的音乐账号凭据；本机保存或清除时重新读取。 */
export function useStoredSongMusicSession(
  platform: SongMusicPlatform
): StoredSongMusicSession | null {
  return useSyncExternalStore(
    onSongMusicSessionChanged,
    () => readStable(platform),
    () => null
  );
}
