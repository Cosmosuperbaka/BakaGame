import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChunkLoadRecovery } from "./ChunkRecovery";

const reload = vi.fn();

/** 构建产物里预加载助手派发的事件：可取消，载荷是原始错误。 */
const dispatchPreloadError = () => {
  const event = new Event("vite:preloadError", { cancelable: true });
  window.dispatchEvent(event);
  return event;
};

describe("分块加载失败自愈", () => {
  beforeEach(() => {
    reload.mockClear();
    window.sessionStorage.clear();
    vi.stubGlobal("location", { ...window.location, reload });
    installChunkLoadRecovery();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("第一次失败：取消事件（错误不再抛出）并重载页面", () => {
    const event = dispatchPreloadError();
    expect(event.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("同一会话第二次失败：不取消事件、不再重载，错误照常抛出交给上报", () => {
    dispatchPreloadError();
    reload.mockClear();
    const event = dispatchPreloadError();
    expect(event.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("浏览器禁用存储时拿不到门闩：不取消事件、不重载，避免无限重载", () => {
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const event = dispatchPreloadError();
    vi.restoreAllMocks();
    expect(event.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
