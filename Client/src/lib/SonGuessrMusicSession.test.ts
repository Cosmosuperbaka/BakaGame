import { describe, expect, it, vi } from "vitest";

import {
  clearStoredSongMusicSession,
  getStoredSongMusicSession,
  saveSongMusicSession,
  SON_MUSIC_SESSION_CHANGED,
} from "./SonGuessrMusicSession";

const session = {
  cookie: "MUSIC_U=browser-only",
  account: { userId: "42", nickname: "本机账号" },
};

describe("SonGuessr browser music session", () => {
  it("stores remembered login state only in localStorage", () => {
    const changed = vi.fn();
    window.addEventListener(SON_MUSIC_SESSION_CHANGED, changed);
    saveSongMusicSession(session, true);
    expect(window.localStorage.length).toBe(1);
    expect(window.sessionStorage.length).toBe(0);
    expect(getStoredSongMusicSession()).toEqual({ ...session, persistent: true });
    expect(changed).toHaveBeenCalledOnce();
    window.removeEventListener(SON_MUSIC_SESSION_CHANGED, changed);
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
});
