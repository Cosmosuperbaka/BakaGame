import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSessionToken,
  getSavedUsername,
  getSessionToken,
  saveSessionToken,
  saveUsername,
} from "./cookie";

describe("session storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("keeps usernames across tabs but scopes session tokens to the current tab", () => {
    saveUsername("测试玩家");
    saveSessionToken(" 1234 ", "token-1234");

    expect(getSavedUsername()).toBe("测试玩家");
    expect(getSessionToken("1234")).toBe("token-1234");
    expect(window.localStorage.getItem("wif_session_1234")).toBeNull();
    expect(window.sessionStorage.getItem("wif_session_1234")).toBe("token-1234");
  });

  it("normalizes the test room id and clears only the selected room", () => {
    saveSessionToken(" oblivionis ", "test-token");
    saveSessionToken("5678", "other-token");

    expect(getSessionToken("OBLIVIONIS")).toBe("test-token");
    clearSessionToken("Oblivionis");

    expect(getSessionToken("oblivionis")).toBeNull();
    expect(getSessionToken("5678")).toBe("other-token");
  });

  it("does not migrate a legacy localStorage token", () => {
    window.localStorage.setItem("wif_session_9012", "legacy-token");

    expect(getSessionToken("9012")).toBeNull();
    expect(window.localStorage.getItem("wif_session_9012")).toBe("legacy-token");
  });
});
