import { describe, expect, it, vi } from "vitest";

import {
  clearStoredSongMusicSession,
  getStoredSongMusicSession,
  saveSongMusicSession,
  SONGUESSR_MUSIC_SESSION_CHANGED,
} from "./SonGuessrMusicSession";

const session = {
  cookie: "MUSIC_U=browser-only",
  account: { userId: "42", nickname: "本机账号" },
};

describe("SonGuessr browser music session", () => {
  it("stores remembered login state only in localStorage", () => {
    const changed = vi.fn();
    window.addEventListener(SONGUESSR_MUSIC_SESSION_CHANGED, changed);
    saveSongMusicSession(session, true);
    expect(window.localStorage.length).toBe(1);
    expect(window.sessionStorage.length).toBe(0);
    expect(getStoredSongMusicSession()).toEqual({ ...session, persistent: true });
    expect(changed).toHaveBeenCalledOnce();
    window.removeEventListener(SONGUESSR_MUSIC_SESSION_CHANGED, changed);
  });

  it("uses sessionStorage when the user disables saved login", () => {
    saveSongMusicSession(session, false);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(1);
    expect(getStoredSongMusicSession()).toEqual({ ...session, persistent: false });
  });

  it("clears both browser stores", () => {
    saveSongMusicSession(session, true);
    clearStoredSongMusicSession();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(getStoredSongMusicSession()).toBeNull();
  });

  it("stores and clears QQ music session independently from netease", () => {
    const qqSession = {
      cookie: "qqmusic_key=test-token",
      account: { userId: "10001", nickname: "QQ玩家", platform: "qq" as const },
    };
    saveSongMusicSession(session, true, "netease");
    saveSongMusicSession(qqSession, true, "qq");

    expect(getStoredSongMusicSession("netease")).toEqual({ ...session, persistent: true });
    expect(getStoredSongMusicSession("qq")).toEqual({ ...qqSession, persistent: true });

    clearStoredSongMusicSession("netease");
    expect(getStoredSongMusicSession("netease")).toBeNull();
    expect(getStoredSongMusicSession("qq")).toEqual({ ...qqSession, persistent: true });

    clearStoredSongMusicSession("all");
    expect(getStoredSongMusicSession("qq")).toBeNull();
  });
});
