import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSeatCredentials,
  clearSessionToken,
  clearSonGuessrSessionToken,
  getSavedUsername,
  getSessionToken,
  getSonGuessrSessionToken,
  normalizeRoomId,
  saveSessionToken,
  saveSonGuessrSessionToken,
  saveUsername,
} from "./Storage";

describe("storage utilities", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("clearSeatCredentials 只清座位凭证，不动昵称与别的会话数据", () => {
    saveUsername("测试玩家");
    saveSessionToken("1234", "faker");
    saveSonGuessrSessionToken("1234", "song");
    window.sessionStorage.setItem("cee_session:1234", "cee");
    window.sessionStorage.setItem("songuessr_solo_room", "9999");
    window.sessionStorage.setItem("bakagame:unrelated", "keep");

    clearSeatCredentials();

    expect(getSessionToken("1234")).toBeNull();
    expect(getSonGuessrSessionToken("1234")).toBeNull();
    expect(window.sessionStorage.getItem("cee_session:1234")).toBeNull();
    expect(window.sessionStorage.getItem("songuessr_solo_room")).toBeNull();
    expect(window.sessionStorage.getItem("bakagame:unrelated")).toBe("keep");
    expect(getSavedUsername()).toBe("测试玩家");
  });

  it("canonicalizes the test room id for routing and sessions", () => {
    expect(normalizeRoomId(" oblivionis ")).toBe("Oblivionis");
    expect(normalizeRoomId("OBLIVIONIS")).toBe("Oblivionis");
    expect(normalizeRoomId(" 1234 ")).toBe("1234");
    expect(normalizeRoomId("")).toBe("");
  });

  it("keeps usernames across tabs but scopes session tokens to the current tab", () => {
    saveUsername("测试玩家");
    saveSessionToken(" 1234 ", "token-1234");
    saveSonGuessrSessionToken(" 1234 ", "song-token-1234");

    expect(getSavedUsername()).toBe("测试玩家");
    expect(getSessionToken("1234")).toBe("token-1234");
    expect(getSonGuessrSessionToken("1234")).toBe("song-token-1234");
    expect(window.localStorage.getItem("whoisfaker_session_1234")).toBeNull();
    expect(window.sessionStorage.getItem("whoisfaker_session_1234")).toBe("token-1234");
    expect(window.sessionStorage.getItem("songuessr_session_1234")).toBe("song-token-1234");
  });

  it("normalizes the test room id and clears only the selected room", () => {
    saveSessionToken(" oblivionis ", "test-token");
    saveSessionToken("5678", "other-token");
    saveSonGuessrSessionToken(" oblivionis ", "song-test-token");

    expect(getSessionToken("OBLIVIONIS")).toBe("test-token");
    expect(getSonGuessrSessionToken("OBLIVIONIS")).toBe("song-test-token");
    clearSessionToken("Oblivionis");
    clearSonGuessrSessionToken("Oblivionis");

    expect(getSessionToken("oblivionis")).toBeNull();
    expect(getSonGuessrSessionToken("oblivionis")).toBeNull();
    expect(getSessionToken("5678")).toBe("other-token");
  });

  it("不再读取或搬迁旧版 wif_ 键：读取热路径不碰无关存储键", () => {
    window.localStorage.setItem("wif_username", "老玩家");
    window.sessionStorage.setItem("wif_session_9012", "legacy-token");

    expect(getSavedUsername()).toBe("");
    expect(getSessionToken("9012")).toBeNull();
    expect(window.localStorage.getItem("wif_username")).toBe("老玩家");
    expect(window.sessionStorage.getItem("wif_session_9012")).toBe("legacy-token");
  });
});
