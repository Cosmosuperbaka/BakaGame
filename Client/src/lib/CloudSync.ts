import { useSyncExternalStore } from "react";
import { PREFERENCES_MAX_BYTES } from "@bakagame/shared/values";
import type { CloudSettings, MusicPlatform } from "@bakagame/shared";
import { api, type ApiClient } from "@/lib/Api";
import { createExternalStore } from "@/lib/ExternalStore";
import { notifyPreferencesApplied, onPreferencesChanged } from "@/lib/PreferenceBus";
import { ROOM_MEMORY_SYNC_PREFIXES } from "@/lib/RoomSettingsMemory";
import { localStore } from "@/lib/SafeStorage";
import { captureClientLog } from "@/lib/Sentry";
import {
  clearStoredSongMusicSession,
  getStoredSongMusicSession,
  onSongMusicSessionChanged,
  saveSongMusicSession,
  type StoredSongMusicSession,
} from "@/lib/SonGuessrMusicSession";
import { SONG_VOLUME_KEY, USERNAME_KEY } from "@/lib/Storage";

/**
 * 已登录时的云同步（见 Server/docs/Account.md §6）。
 *
 * 偏好：本地存储里同步范围内的键原样（字符串）放进一份扁平文档，协议是整份覆盖。
 * 登录时云端与本地逐键合并，同一键以云端为准、只在本地的键保留，合并结果写回两边。
 * 之后只上传「自上次成功同步以来本机改过的键」：上传前先拉取云端，把云端其余键（可能来自
 * 别的设备）原样带上，本机改过的键覆盖云端同名键（后写者为准），再整份上传，
 * 云端新于本机的键同时写回本机。拉取到上传之间仍有一个往返的窗口，别的设备恰好在此刻写同一份
 * 文档会被覆盖，这是整份覆盖协议下客户端能做到的上限。上传单飞，同时只有一份在途。
 *
 * 本机缓存绑定账号：换了账号登录，上一个账号留在本机的偏好与音乐账号凭据先清掉再合并，
 * 绝不上传到新账号；没有记录（游客登录音乐账号后注册）保持带入。
 *
 * 猜歌音乐账号：按平台比较，只有一边有时补到另一边；两边不同时以云端为准
 * （云端只在登录期间被改写，代表这个账号最近一次的登录）。之后本地登录或退出即上传或删除云端副本。
 * 没勾选「保存登录状态」的本机凭据不上传：它在云端视同没有，所以改成不保存会删掉云端旧副本。
 */
const PLATFORMS: MusicPlatform[] = ["netease", "qq"];
const PUSH_DELAY_MS = 2_000;

/** 云同步开关只属于本机：关闭后不再上传或读取云端，选项本身不参与同步。 */
export const CLOUD_SYNC_STORAGE_KEY = "bakagame:cloud-sync";

/** 本机记录「缓存属于哪个账号」；不在同步范围内，也不随账号切换被清掉。 */
const ACCOUNT_BINDING_KEY = "bakagame:cloud-sync-user";

const syncEnabled = createExternalStore(true);
let syncInitialized = false;

function ensureSyncPreference(): void {
  if (syncInitialized) return;
  syncInitialized = true;
  // 首次读取可能发生在渲染期的 getSnapshot 里：只写值，不通知订阅者。
  try {
    syncEnabled.write(window.localStorage.getItem(CLOUD_SYNC_STORAGE_KEY) !== "0");
  } catch {
    syncEnabled.write(true);
  }
}

export function getCloudSyncEnabled(): boolean {
  ensureSyncPreference();
  return syncEnabled.get();
}

export function setCloudSyncEnabled(next: boolean): void {
  syncEnabled.write(next);
  syncInitialized = true;
  try {
    window.localStorage.setItem(CLOUD_SYNC_STORAGE_KEY, next ? "1" : "0");
  } catch {
    // 隐私模式写不进去：本次会话仍然生效。
  }
  syncEnabled.emit();
}

export function useCloudSyncEnabled(): boolean {
  return useSyncExternalStore(syncEnabled.subscribe, getCloudSyncEnabled, () => true);
}

const isSyncedKey = (key: string): boolean =>
  key === USERNAME_KEY ||
  key === SONG_VOLUME_KEY ||
  ROOM_MEMORY_SYNC_PREFIXES.some((prefix) => key.startsWith(prefix));

export const readLocalPreferences = (): Record<string, string> => {
  const entries: Record<string, string> = {};
  for (const key of localStore.keys()) {
    if (!isSyncedKey(key)) continue;
    const value = localStore.get(key);
    if (value !== null) entries[key] = value;
  }
  return entries;
};

const sortedJson = (entries: Record<string, string>) =>
  JSON.stringify(
    Object.keys(entries)
      .sort()
      .map((key) => [key, entries[key]])
  );

const cloudEntries = (preferences: CloudSettings["preferences"]): Record<string, string> => {
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(preferences?.value ?? {})) {
    if (isSyncedKey(key) && typeof value === "string") entries[key] = value;
  }
  return entries;
};

/**
 * 能进云端的只有玩家勾选了「保存登录状态」的凭据：没勾选的凭据只在本标签页的会话存储里，
 * 界面对玩家的承诺就是它不会离开浏览器。本机是临时凭据时，云端视同没有。
 */
const cloudBoundMusicSession = (platform: MusicPlatform): StoredSongMusicSession | null => {
  const session = getStoredSongMusicSession(platform);
  return session?.persistent ? session : null;
};

const musicFingerprint = (session: StoredSongMusicSession | null) =>
  session ? JSON.stringify([session.cookie, session.account]) : "";

const reportFailure = (what: string, error: unknown) =>
  captureClientLog(`云同步失败：${what}`, "warning", {
    error: error instanceof Error ? error.message : String(error),
  });

/** 自基线以来本机新增或改过的键；删除不算改动（应用本身不会删同步键，清站点数据不该抹云端）。 */
const dirtyEntries = (
  local: Record<string, string>,
  baseline: Record<string, string>
): Record<string, string> =>
  Object.fromEntries(Object.entries(local).filter(([key, value]) => baseline[key] !== value));

/** 云端值写回本机（`keep` 里的键保留本机值）；返回是否真的改了本机，据此通知已挂载的读取方重读。 */
const applyRemoteEntries = (
  remote: Record<string, string>,
  local: Record<string, string>,
  keep: Record<string, string>
): boolean => {
  const changed = Object.keys(remote).filter((key) => !(key in keep) && local[key] !== remote[key]);
  if (!changed.length) return false;
  // 本地存储不可写时本机继续用原有偏好。
  for (const key of changed) localStore.set(key, remote[key]);
  return true;
};

/** 换了账号登录：上一个账号的同步键与音乐账号凭据一律清掉，再记下新账号。 */
const bindAccount = (userId: string): void => {
  // 存储不可用时没有本机缓存可串，也就无需隔离：读到 null 即按「没有归属记录」处理。
  const bound = localStore.get(ACCOUNT_BINDING_KEY);
  if (bound !== null && bound !== userId) {
    for (const key of Object.keys(readLocalPreferences())) localStore.remove(key);
    clearStoredSongMusicSession("all");
    notifyPreferencesApplied();
  }
  localStore.set(ACCOUNT_BINDING_KEY, userId);
};

/** 开始同步，返回停止函数（退出登录或页面卸载时调用）。 */
export function startCloudSync(userId: string, client: ApiClient = api): () => void {
  let active = true;
  let ready = false;
  let pushTimer: ReturnType<typeof setTimeout> | undefined;
  /** 上次成功同步时本机与云端一致的偏好；与它不同的本机键才是需要上传的。 */
  let baseline: Record<string, string> = {};
  let inFlight: Promise<void> | null = null;
  let pushAgain = false;
  const lastMusic: Record<MusicPlatform, string> = { netease: "", qq: "" };

  const pushOnce = async () => {
    if (!active || !ready || !Object.keys(dirtyEntries(readLocalPreferences(), baseline)).length) {
      return;
    }
    let cloud: CloudSettings;
    try {
      cloud = await client.settings.get();
    } catch (error) {
      reportFailure("读取云端", error);
      return;
    }
    if (!active) return;
    // 云端读回之后，「取本机」与「写回本机」之间没有 await，本机不会被别处改动穿插。
    const remote = cloudEntries(cloud.preferences);
    const local = readLocalPreferences();
    const dirty = dirtyEntries(local, baseline);
    if (applyRemoteEntries(remote, local, dirty)) notifyPreferencesApplied();
    const document = { ...remote, ...dirty };
    if (sortedJson(document) !== sortedJson(remote)) {
      if (new TextEncoder().encode(JSON.stringify(document)).byteLength > PREFERENCES_MAX_BYTES) {
        captureClientLog("云同步跳过：偏好超出上限", "warning", {
          keys: Object.keys(document).length,
        });
        return;
      }
      try {
        await client.settings.savePreferences({ value: document });
      } catch (error) {
        reportFailure("偏好", error);
        return;
      }
    }
    baseline = document;
  };

  /** 上传单飞：在途期间的新请求只置位，结束后补推一次（补推时没有新改动就什么都不发）。 */
  const pushPreferences = (): Promise<void> => {
    if (inFlight) {
      pushAgain = true;
      return inFlight;
    }
    inFlight = (async () => {
      do {
        pushAgain = false;
        await pushOnce();
      } while (pushAgain && active);
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const schedulePush = () => {
    if (!ready || !active) return;
    if (pushTimer !== undefined) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = undefined;
      void pushPreferences();
    }, PUSH_DELAY_MS);
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
      const session = cloudBoundMusicSession(platform);
      const fingerprint = musicFingerprint(session);
      if (fingerprint === lastMusic[platform]) continue;
      lastMusic[platform] = fingerprint;
      void uploadMusic(platform, session);
    }
  };

  /** 登录时偏好以云端为准逐键写回本机；只在本机的键留在原处，随后作为改动上传。 */
  const mergePreferences = (cloud: CloudSettings) => {
    const remote = cloudEntries(cloud.preferences);
    if (applyRemoteEntries(remote, readLocalPreferences(), {})) notifyPreferencesApplied();
    // 云端没有文档时按空文档记：之后本地仍为空的通知不会建出空文档。
    baseline = remote;
  };

  /**
   * 音乐账号：先记下将要成为的本地状态，写回本地触发的变更通知因此不会再上传一遍。
   * 返回只在本机有、需要补到云端的账号。
   */
  const reconcileMusic = (cloud: CloudSettings) => {
    const uploads: Array<[MusicPlatform, StoredSongMusicSession]> = [];
    for (const platform of PLATFORMS) {
      const localSession = getStoredSongMusicSession(platform);
      const uploadable = cloudBoundMusicSession(platform);
      const remoteSession = cloud.music[platform];
      if (remoteSession) {
        const next = { ...remoteSession, persistent: true };
        lastMusic[platform] = musicFingerprint(next);
        if (musicFingerprint(localSession) !== lastMusic[platform])
          saveSongMusicSession(remoteSession, true, platform);
      } else {
        lastMusic[platform] = musicFingerprint(uploadable);
        if (uploadable) uploads.push([platform, uploadable]);
      }
    }
    return uploads;
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
    mergePreferences(cloud);
    const uploads = reconcileMusic(cloud);
    ready = true;
    void pushPreferences();
    for (const [platform, session] of uploads) void uploadMusic(platform, session);
  };

  // 换号清理必须在一切读取与上传之前同步完成：拉取云端失败，也不能让上一个账号的数据留着等下一次上传。
  bindAccount(userId);
  const stopPreferences = onPreferencesChanged(schedulePush);
  const stopMusic = onSongMusicSessionChanged(onMusicChanged);
  void initialize();

  return () => {
    active = false;
    if (pushTimer !== undefined) clearTimeout(pushTimer);
    stopPreferences();
    stopMusic();
  };
}
