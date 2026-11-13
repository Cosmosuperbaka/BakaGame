import type { SonGuessrMusicAccount } from "@bakagame/shared";
import { localStore, sessionStore } from "@/lib/SafeStorage";
import { createSignal } from "@/lib/Signal";

export type SongMusicPlatform = "netease" | "qq";

const STORAGE_KEYS: Record<SongMusicPlatform, { local: string; session: string }> = {
  netease: {
    local: "songuessr_netease_session_v1",
    session: "songuessr_netease_session_v1_session",
  },
  qq: {
    local: "songuessr_qq_session_v1",
    session: "songuessr_qq_session_v1_session",
  },
};

const sessionChanged = createSignal();

/** 本机保存或清除任一平台的音乐账号之后通知；返回取消订阅函数。 */
export const onSongMusicSessionChanged = sessionChanged.subscribe;

export interface StoredSongMusicSession {
  cookie: string;
  account: SonGuessrMusicAccount;
  persistent: boolean;
}

const parseSession = (raw: string | null, persistent: boolean): StoredSongMusicSession | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredSongMusicSession>;
    if (
      typeof value.cookie !== "string" ||
      !value.cookie.trim() ||
      !value.account ||
      typeof value.account.nickname !== "string" ||
      (value.account.platform !== undefined &&
        value.account.platform !== "netease" &&
        value.account.platform !== "qq")
    ) {
      return null;
    }
    return {
      cookie: value.cookie,
      account: value.account,
      persistent,
    };
  } catch {
    return null;
  }
};

export const getStoredSongMusicSession = (
  platform: SongMusicPlatform = "netease"
): StoredSongMusicSession | null => {
  const keys = STORAGE_KEYS[platform];
  return (
    parseSession(sessionStore.get(keys.session), false) ??
    parseSession(localStore.get(keys.local), true)
  );
};

export const saveSongMusicSession = (
  session: Pick<StoredSongMusicSession, "cookie" | "account">,
  persistent: boolean,
  platform?: SongMusicPlatform
) => {
  const keys = STORAGE_KEYS[platform ?? session.account.platform ?? "netease"];
  const target = persistent
    ? { store: localStore, key: keys.local }
    : { store: sessionStore, key: keys.session };
  const other = persistent
    ? { store: sessionStore, key: keys.session }
    : { store: localStore, key: keys.local };
  const serialized = JSON.stringify({ cookie: session.cookie, account: session.account });
  if (target.store.get(target.key) === serialized && !other.store.get(other.key)) return;
  localStore.remove(keys.local);
  sessionStore.remove(keys.session);
  // 存储被禁用时写不进去：本次不留存，也就没有变更可通知。
  if (target.store.set(target.key, serialized)) sessionChanged.emit();
};

export const clearStoredSongMusicSession = (platform: SongMusicPlatform | "all" = "netease") => {
  const cleared = platform === "all" ? Object.values(STORAGE_KEYS) : [STORAGE_KEYS[platform]];
  for (const keys of cleared) {
    localStore.remove(keys.local);
    sessionStore.remove(keys.session);
  }
  sessionChanged.emit();
};
