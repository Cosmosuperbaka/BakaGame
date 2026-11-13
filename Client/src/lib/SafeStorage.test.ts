import { afterEach, describe, expect, it, vi } from "vitest";
import { localStore, sessionStore } from "./SafeStorage";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("安全存储访问", () => {
  it("读写删与按前缀枚举", () => {
    expect(localStore.set("a:1", "x")).toBe(true);
    localStore.set("a:2", "y");
    localStore.set("b:1", "z");
    expect(localStore.get("a:1")).toBe("x");
    expect(localStore.get("none")).toBeNull();
    expect(localStore.keys("a:").sort()).toEqual(["a:1", "a:2"]);
    expect(localStore.keys()).toHaveLength(3);
    localStore.remove("a:1");
    expect(localStore.get("a:1")).toBeNull();
  });

  it("两个存储互不相通", () => {
    localStore.set("k", "local");
    expect(sessionStore.get("k")).toBeNull();
  });

  it("存储被禁用（取存储本身抛 SecurityError）时读为 null、写为 false、枚举为空，且不抛出", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(localStore.get("k")).toBeNull();
    expect(localStore.set("k", "v")).toBe(false);
    expect(() => localStore.remove("k")).not.toThrow();
    expect(localStore.keys("k")).toEqual([]);
  });

  it("写满时 set 返回 false", () => {
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(sessionStore.set("k", "v")).toBe(false);
  });
});
