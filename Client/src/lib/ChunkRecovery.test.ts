import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as recovery from "./ChunkRecovery";

const reload = vi.fn();
let uninstall: () => void;

/** 构建产物里预加载助手派发的事件：可取消，载荷是原始错误。 */
const dispatchPreloadError = () => {
  const event = new Event("vite:preloadError", { cancelable: true });
  window.dispatchEvent(event);
  return event;
};

/**
 * 模拟预加载助手对一次失败导入的处理：派发事件，被取消就吞掉错误、让导入解析成 undefined，
 * 没被取消就把错误抛出去。
 */
const failingImport = <T>(): Promise<T> => {
  const event = dispatchPreloadError();
  if (event.defaultPrevented) return Promise.resolve(undefined as T);
  return Promise.reject(new Error("Failed to fetch dynamically imported module: /a.js"));
};

/** 等几轮事件循环：挂起的 Promise 到这时仍未落定，就当它不会再落定。 */
const settledWithin = async (promise: Promise<unknown>): Promise<boolean> => {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
};

describe("分块加载失败自愈", () => {
  beforeEach(() => {
    reload.mockClear();
    window.sessionStorage.clear();
    // 「重载进行中」是模块级状态：每条用例从未重载的状态开始。
    recovery.resetChunkRecoveryForTest();
    vi.stubGlobal("location", { ...window.location, reload });
    uninstall = recovery.installChunkLoadRecovery();
  });

  afterEach(() => {
    uninstall();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("第一次失败：取消事件（错误不再抛出）并重载页面", () => {
    const event = dispatchPreloadError();
    expect(event.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(recovery.isChunkRecoveryReloading()).toBe(true);
  });

  it("重载进行中同时失败的其它分块一并取消，不再二次重载", () => {
    dispatchPreloadError();
    const second = dispatchPreloadError();
    expect(second.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("同一会话重载之后仍失败：不取消事件、不再重载，错误照常抛出交给上报", () => {
    // 门闩已在上一次页面生命周期里用掉；这一次页面从未发起过重载。
    window.sessionStorage.setItem("bakagame:chunk-retry", "1");
    const event = dispatchPreloadError();
    expect(event.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(recovery.isChunkRecoveryReloading()).toBe(false);
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

describe("loadChunk：动态导入的统一入口", () => {
  beforeEach(() => {
    reload.mockClear();
    window.sessionStorage.clear();
    recovery.resetChunkRecoveryForTest();
    vi.stubGlobal("location", { ...window.location, reload });
    uninstall = recovery.installChunkLoadRecovery();
  });

  afterEach(() => {
    uninstall();
    vi.unstubAllGlobals();
  });

  it("平时原样返回模块", async () => {
    const module = { default: "page" };
    await expect(recovery.loadChunk(() => Promise.resolve(module))).resolves.toBe(module);
  });

  it("自愈重载触发后，被取消的导入不解析成 undefined 往下传，而是挂起等重载", async () => {
    const pending = recovery.loadChunk(() => failingImport<{ default: string }>());
    expect(reload).toHaveBeenCalledTimes(1);
    expect(await settledWithin(pending)).toBe(false);
  });

  it("取成员的写法在重载进行中也不会抛「Cannot read properties of undefined」", async () => {
    const member = (async () => (await recovery.loadChunk(() => failingImport<{ x: 1 }>())).x)();
    expect(await settledWithin(member)).toBe(false);
  });

  it("重载进行中的导入失败同样挂起", async () => {
    dispatchPreloadError();
    const pending = recovery.loadChunk(() => Promise.reject(new Error("late failure")));
    expect(await settledWithin(pending)).toBe(false);
  });

  it("没有在重载（自愈已用过）时失败照常抛出，交给错误出口与上报", async () => {
    window.sessionStorage.setItem("bakagame:chunk-retry", "1");
    await expect(recovery.loadChunk(() => failingImport())).rejects.toThrow(
      "Failed to fetch dynamically imported module"
    );
    expect(reload).not.toHaveBeenCalled();
  });
});
