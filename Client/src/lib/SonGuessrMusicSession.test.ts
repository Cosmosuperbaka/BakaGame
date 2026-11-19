import { describe, expect, it, vi } from "vitest";

import {
  clearStoredSongMusicSession,
  getStoredSongMusicSession,
  saveSongMusicSession,
  onSongMusicSessionChanged,
} from "./SonGuessrMusicSession";

const session = {
  cookie: "MUSIC_U=browser-only",
  account: { userId: "42", nickname: "本机账号" },
};

describe("SonGuessr browser music session", () => {
  it("stores remembered login state only in localStorage", () => {
    const changed = vi.fn();
    const stop = onSongMusicSessionChanged(changed);
    saveSongMusicSession(session, true);
    expect(window.localStorage.length).toBe(1);
    expect(window.sessionStorage.length).toBe(0);
    expect(getStoredSongMusicSession()).toEqual({ ...session, persistent: true });
    expect(changed).toHaveBeenCalledOnce();
    stop();
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

  it("存储被禁用（取存储就抛 SecurityError）时读为 null，保存与清除不抛出也不发变更通知", () => {
    const denied = () => {
      throw new DOMException("denied", "SecurityError");
    };
    const spies = [
      vi.spyOn(window, "localStorage", "get").mockImplementation(denied),
      vi.spyOn(window, "sessionStorage", "get").mockImplementation(denied),
    ];
    const changed = vi.fn();
    const stop = onSongMusicSessionChanged(changed);

    expect(getStoredSongMusicSession("netease")).toBeNull();
    expect(() => saveSongMusicSession(session, true, "qq")).not.toThrow();
    expect(() => clearStoredSongMusicSession("all")).not.toThrow();
    // 先还原再断言：测试环境的收尾钩子要清空存储，不能撞上还在抛错的存取器。
    for (const spy of spies) spy.mockRestore();
    // 保存没有真正落盘就不通知；清除总是通知，订阅方据此重读。
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
  });

  it("账号里的平台字段不是已知平台的记录视为损坏", () => {
    window.localStorage.setItem(
      "songuessr_netease_session_v1",
      JSON.stringify({ cookie: "MUSIC_U=x", account: { nickname: "甲", platform: "weird" } })
    );
    expect(getStoredSongMusicSession("netease")).toBeNull();
  });
});
