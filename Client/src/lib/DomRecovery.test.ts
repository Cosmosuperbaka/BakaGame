import { beforeEach, describe, expect, it, vi } from "vitest";
import { isDomInvariantError, recoverFromDomInvariant } from "./DomRecovery";

const DOM_RECOVERY_KEY = "bakagame:dom-recovery";
const REMOVE_CHILD_MESSAGE =
  "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.";
const INSERT_BEFORE_MESSAGE =
  "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.";

const reloadMock = vi.fn();

describe("DomRecovery 第三方扩展破坏 DOM 后的自愈", () => {
  beforeEach(() => {
    sessionStorage.clear();
    reloadMock.mockClear();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload: reloadMock },
    });
  });

  it("识别 removeChild 与 insertBefore 两类父子节点不变量破坏", () => {
    expect(isDomInvariantError(new DOMException(REMOVE_CHILD_MESSAGE, "NotFoundError"))).toBe(true);
    expect(isDomInvariantError(new Error(INSERT_BEFORE_MESSAGE))).toBe(true);
  });

  it("不误伤普通业务异常与非法入参", () => {
    expect(isDomInvariantError(new Error("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(isDomInvariantError(new TypeError("Failed to fetch dynamically imported module"))).toBe(false);
    expect(isDomInvariantError(undefined)).toBe(false);
    expect(isDomInvariantError(null)).toBe(false);
    expect(isDomInvariantError(REMOVE_CHILD_MESSAGE)).toBe(false);
  });

  it("命中时自动重载，且同一会话内只重载一次", () => {
    const error = new DOMException(REMOVE_CHILD_MESSAGE, "NotFoundError");

    expect(recoverFromDomInvariant(error)).toBe(true);
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(DOM_RECOVERY_KEY)).toBe("1");

    expect(recoverFromDomInvariant(error)).toBe(false);
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("未命中时既不重载也不写入会话标记", () => {
    expect(recoverFromDomInvariant(new Error("普通业务异常"))).toBe(false);
    expect(reloadMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(DOM_RECOVERY_KEY)).toBeNull();
  });
});
