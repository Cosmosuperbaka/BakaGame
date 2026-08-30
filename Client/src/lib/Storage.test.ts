import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSessionToken,
  clearSonGuessrSessionToken,
  getSavedUsername,
  getSessionToken,
  getSonGuessrSessionToken,
  saveSessionToken,
  saveSonGuessrSessionToken,
  saveUsername,
} from "./Storage";

describe("storage utilities", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("keeps usernames across tabs but scopes session tokens to the current tab", () => {
    saveUsername("测试玩家");
    saveSessionToken(" 1234 ", "token-1234");
    saveSonGuessrSessionToken(" 1234 ", "song-token-1234");

    expect(getSavedUsername()).toBe("测试玩家");
    expect(getSessionToken("1234")).toBe("token-1234");
    expect(getSonGuessrSessionToken("1234")).toBe("song-token-1234");
    expect(window.localStorage.getItem("wif_session_1234")).toBeNull();
    expect(window.sessionStorage.getItem("wif_session_1234")).toBe("token-1234");
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

  it("does not migrate a legacy localStorage token", () => {
    window.localStorage.setItem("wif_session_9012", "legacy-token");

    expect(getSessionToken("9012")).toBeNull();
    expect(window.localStorage.getItem("wif_session_9012")).toBe("legacy-token");
  });
});
