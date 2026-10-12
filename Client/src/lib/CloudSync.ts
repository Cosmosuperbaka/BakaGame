import { PREFERENCES_MAX_BYTES, type CloudSettings, type MusicPlatform } from "@bakagame/shared";
import { api, type ApiClient } from "@/lib/Api";
import { ROOM_MEMORY_SYNC_PREFIXES } from "@/lib/RoomSettingsMemory";
import { captureClientLog } from "@/lib/Sentry";
import {
  getStoredSongMusicSession,
  saveSongMusicSession,
  SONGUESSR_MUSIC_SESSION_CHANGED,
  type StoredSongMusicSession,
} from "@/lib/SonGuessrMusicSession";
import { PREFERENCES_APPLIED, PREFERENCES_CHANGED, SONG_VOLUME_KEY, USERNAME_KEY } from "@/lib/Storage";

/**
 * 已登录时的云同步（见 Agents/Account.md §6）。
 *
 * 偏好：本地存储里同步范围内的键原样（字符串）放进一份扁平文档整体覆盖上传。
 * 登录时云端与本地逐键合并，同一键以云端为准、只在本地的键保留，合并结果写回两边；
 * 之后本地写入经 `PREFERENCES_CHANGED` 通知，防抖后上传。
 *
 * 猜歌音乐账号：按平台比较，只有一边有时补到另一边；两边不同时以云端为准
 * （云端只在登录期间被改写，代表这个账号最近一次的登录）。之后本地登录或退出即上传或删除云端副本。
 */
const PLATFORMS: MusicPlatform[] = ["netease", "qq"];
const PUSH_DELAY_MS = 2_000;

const isSyncedKey = (key: string): boolean =>
  key === USERNAME_KEY || key === SONG_VOLUME_KEY || ROOM_MEMORY_SYNC_PREFIXES.some((prefix) => key.startsWith(prefix));

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export const readLocalPreferences = (): Record<string, string> => {
  const local = storage();
  const entries: Record<string, string> = {};
  if (!local) return entries;
  for (let index = 0; index < local.length; index += 1) {
    const key = local.key(index);
    if (!key || !isSyncedKey(key)) continue;
    const value = local.getItem(key);
    if (value !== null) entries[key] = value;
  }
  return entries;
};

const sortedJson = (entries: Record<string, string>) =>
  JSON.stringify(Object.keys(entries).sort().map((key) => [key, entries[key]]));

const cloudEntries = (preferences: CloudSettings["preferences"]): Record<string, string> => {
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(preferences?.value ?? {})) {
    if (isSyncedKey(key) && typeof value === "string") entries[key] = value;
  }
  return entries;
};

const musicFingerprint = (session: StoredSongMusicSession | null) =>
  session ? JSON.stringify([session.cookie, session.account]) : "";

const reportFailure = (what: string, error: unknown) =>
  captureClientLog(`云同步失败：${what}`, "warning", { error: error instanceof Error ? error.message : String(error) });

/** 开始同步，返回停止函数（退出登录或页面卸载时调用）。 */
export function startCloudSync(client: ApiClient = api): () => void {
  let active = true;
  let ready = false;
  let pushTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPushed = "";
  const lastMusic: Record<MusicPlatform, string> = { netease: "", qq: "" };

  const pushPreferences = async () => {
    pushTimer = undefined;
    if (!active) return;
    const entries = readLocalPreferences();
    const serialized = sortedJson(entries);
    if (serialized === lastPushed) return;
    if (new TextEncoder().encode(JSON.stringify(entries)).byteLength > PREFERENCES_MAX_BYTES) {
      captureClientLog("云同步跳过：偏好超出上限", "warning", { keys: Object.keys(entries).length });
      return;
    }
    try {
      await client.settings.savePreferences({ value: entries });
      lastPushed = serialized;
    } catch (error) {
      reportFailure("偏好", error);
    }
  };

  const schedulePush = () => {
    if (!ready || !active) return;
    if (pushTimer !== undefined) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void pushPreferences(), PUSH_DELAY_MS);
  };

  const uploadMusic = async (platform: MusicPlatform, session: StoredSongMusicSession | null) => {
    try {
      await client.settings.saveMusicSession({
        platform,
        session: session ? { cookie: session.cookie, account: session.account } : null,
      });
    } catch (error) {
      reportFailure(`音乐账号 ${platform}`, error);
    }
  };

  const onMusicChanged = () => {
    if (!ready || !active) return;
    for (const platform of PLATFORMS) {
      const session = getStoredSongMusicSession(platform);
      const fingerprint = musicFingerprint(session);
      if (fingerprint === lastMusic[platform]) continue;
      lastMusic[platform] = fingerprint;
      void uploadMusic(platform, session);
    }
  };

  const initialize = async () => {
    let cloud: CloudSettings;
    try {
      cloud = await client.settings.get();
    } catch (error) {
      reportFailure("读取云端", error);
      return;
    }
    if (!active) return;

    // 偏好：云端优先逐键合并。
    const local = readLocalPreferences();
    const remote = cloudEntries(cloud.preferences);
    const merged = { ...local, ...remote };
    const changedLocally = Object.keys(remote).filter((key) => local[key] !== remote[key]);
    if (changedLocally.length) {
      const target = storage();
      try {
        for (const key of changedLocally) target?.setItem(key, remote[key]);
      } catch {
        // 本地存储不可写：本机继续用原有偏好。
      }
      window.dispatchEvent(new Event(PREFERENCES_APPLIED));
    }
    // 云端没有文档时按空文档记：之后本地仍为空的通知不会建出空文档。
    lastPushed = sortedJson(remote);

    // 音乐账号：先记下将要成为的本地状态，写回本地触发的变更事件因此不会再上传一遍。
    const uploads: Array<[MusicPlatform, StoredSongMusicSession]> = [];
    for (const platform of PLATFORMS) {
      const localSession = getStoredSongMusicSession(platform);
      const remoteSession = cloud.music[platform];
      if (remoteSession) {
        const next = { ...remoteSession, persistent: true };
        lastMusic[platform] = musicFingerprint(next);
        if (musicFingerprint(localSession) !== lastMusic[platform]) saveSongMusicSession(remoteSession, true, platform);
      } else {
        lastMusic[platform] = musicFingerprint(localSession);
        if (localSession) uploads.push([platform, localSession]);
      }
    }

    ready = true;
    if (sortedJson(merged) !== lastPushed) void pushPreferences();
    for (const [platform, session] of uploads) void uploadMusic(platform, session);
  };

  window.addEventListener(PREFERENCES_CHANGED, schedulePush);
  window.addEventListener(SONGUESSR_MUSIC_SESSION_CHANGED, onMusicChanged);
  void initialize();

  return () => {
    active = false;
    if (pushTimer !== undefined) clearTimeout(pushTimer);
    window.removeEventListener(PREFERENCES_CHANGED, schedulePush);
    window.removeEventListener(SONGUESSR_MUSIC_SESSION_CHANGED, onMusicChanged);
  };
}
