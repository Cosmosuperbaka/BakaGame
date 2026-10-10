import { beforeEach, describe, expect, it } from "vitest";

import {
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

  it("migrates legacy wif_ keys to the namespaced keys once", () => {
    window.localStorage.setItem("wif_username", "老玩家");
    window.sessionStorage.setItem("wif_session_9012", "legacy-token");

    expect(getSavedUsername()).toBe("老玩家");
    expect(getSessionToken("9012")).toBe("legacy-token");
    expect(window.localStorage.getItem("bakagame:username")).toBe("老玩家");
    expect(window.sessionStorage.getItem("whoisfaker_session_9012")).toBe("legacy-token");
    expect(window.localStorage.getItem("wif_username")).toBeNull();
    expect(window.sessionStorage.getItem("wif_session_9012")).toBeNull();
  });

  it("does not overwrite a newer value when migrating", () => {
    window.localStorage.setItem("wif_username", "老玩家");
    saveUsername("新玩家");

    expect(getSavedUsername()).toBe("新玩家");
  });

  it("keeps the legacy localStorage token untouched", () => {
    window.localStorage.setItem("wif_session_3456", "legacy-token");

    expect(getSessionToken("3456")).toBeNull();
    expect(window.localStorage.getItem("wif_session_3456")).toBe("legacy-token");
  });
});
