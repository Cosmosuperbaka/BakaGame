import { beforeEach, describe, expect, it, vi } from "vitest";
import { reserveSessionRecovery } from "./SessionRecovery";

describe("SessionRecovery 会话级一次性恢复门闩", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("首次调用放行并落标记，同一会话内再次调用拒绝", () => {
    expect(reserveSessionRecovery("bakagame:test")).toBe(true);
    expect(sessionStorage.getItem("bakagame:test")).toBe("1");
    expect(reserveSessionRecovery("bakagame:test")).toBe(false);
  });

  it("不同恢复点位的标记互不干扰", () => {
    expect(reserveSessionRecovery("bakagame:a")).toBe(true);
    expect(reserveSessionRecovery("bakagame:b")).toBe(true);
    expect(reserveSessionRecovery("bakagame:a")).toBe(false);
    expect(reserveSessionRecovery("bakagame:b")).toBe(false);
  });

  it("浏览器禁用存储时安全拒绝放行，绝不向上抛出", () => {
    vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    expect(reserveSessionRecovery("bakagame:c")).toBe(false);
  });
});
