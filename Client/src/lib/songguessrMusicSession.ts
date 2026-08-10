import type { SongGuessrMusicAccount } from "@/types";

const LOCAL_KEY = "songguessr_netease_session_v1";
const SESSION_KEY = "songguessr_netease_session_v1_session";

export const SONG_MUSIC_SESSION_CHANGED = "songguessr-music-session-changed";

export interface StoredSongMusicSession {
  cookie: string;
  account: SongGuessrMusicAccount;
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

const notifyChanged = () => window.dispatchEvent(new Event(SONG_MUSIC_SESSION_CHANGED));

export const getStoredSongMusicSession = (): StoredSongMusicSession | null =>
  parseSession(window.sessionStorage.getItem(SESSION_KEY), false) ??
  parseSession(window.localStorage.getItem(LOCAL_KEY), true);

export const saveSongMusicSession = (
  session: Pick<StoredSongMusicSession, "cookie" | "account">,
  persistent: boolean,
) => {
  window.localStorage.removeItem(LOCAL_KEY);
  window.sessionStorage.removeItem(SESSION_KEY);
  const serialized = JSON.stringify({ cookie: session.cookie, account: session.account });
  (persistent ? window.localStorage : window.sessionStorage).setItem(
    persistent ? LOCAL_KEY : SESSION_KEY,
    serialized,
  );
  notifyChanged();
};

export const clearStoredSongMusicSession = () => {
  window.localStorage.removeItem(LOCAL_KEY);
  window.sessionStorage.removeItem(SESSION_KEY);
  notifyChanged();
};
