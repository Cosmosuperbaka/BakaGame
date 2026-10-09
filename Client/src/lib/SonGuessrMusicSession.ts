import type { SonGuessrMusicAccount } from "@/types";

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

export const SONGUESSR_MUSIC_SESSION_CHANGED = "songuessr-music-session-changed";

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
      typeof value.account.nickname !== "string"
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

const notifyChanged = () => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SONGUESSR_MUSIC_SESSION_CHANGED));
  }
};

export const getStoredSongMusicSession = (
  platform: SongMusicPlatform = "netease",
): StoredSongMusicSession | null => {
  if (typeof window === "undefined") return null;
  const keys = STORAGE_KEYS[platform] ?? STORAGE_KEYS.netease;
  return (
    parseSession(window.sessionStorage.getItem(keys.session), false) ??
    parseSession(window.localStorage.getItem(keys.local), true)
  );
};

export const getAllStoredSongMusicSessions = (): {
  netease: StoredSongMusicSession | null;
  qq: StoredSongMusicSession | null;
} => ({
  netease: getStoredSongMusicSession("netease"),
  qq: getStoredSongMusicSession("qq"),
});

export const saveSongMusicSession = (
  session: Pick<StoredSongMusicSession, "cookie" | "account">,
  persistent: boolean,
  platform?: SongMusicPlatform,
) => {
  if (typeof window === "undefined") return;
  const targetPlatform = platform ?? session.account.platform ?? "netease";
  const keys = STORAGE_KEYS[targetPlatform] ?? STORAGE_KEYS.netease;
  window.localStorage.removeItem(keys.local);
  window.sessionStorage.removeItem(keys.session);
  const serialized = JSON.stringify({ cookie: session.cookie, account: session.account });
  (persistent ? window.localStorage : window.sessionStorage).setItem(
    persistent ? keys.local : keys.session,
    serialized,
  );
  notifyChanged();
};

export const clearStoredSongMusicSession = (platform: SongMusicPlatform | "all" = "netease") => {
  if (typeof window === "undefined") return;
  if (platform === "all") {
    for (const keys of Object.values(STORAGE_KEYS)) {
      window.localStorage.removeItem(keys.local);
      window.sessionStorage.removeItem(keys.session);
    }
  } else {
    const keys = STORAGE_KEYS[platform] ?? STORAGE_KEYS.netease;
    window.localStorage.removeItem(keys.local);
    window.sessionStorage.removeItem(keys.session);
  }
  notifyChanged();
};
