import { afterEach, describe, expect, it, vi } from "vitest";
import { installDesktopUpdate, readDesktopUpdateStatus } from "./DesktopUpdate";

/** 装一个假的 Tauri IPC：按命令名回结果，记下调过的命令与参数。 */
const shellIpc = (handler: (command: string) => unknown) => {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    void args;
    const result = handler(command);
    if (result instanceof Error) throw result;
    return result;
  });
  window.__TAURI_INTERNALS__ = { invoke };
  return invoke;
};

afterEach(() => {
  delete window.__TAURI_INTERNALS__;
});

describe("桌面壳自动更新", () => {
  it("读状态：只认壳给的五种阶段，版本号随就绪一起带回", async () => {
    shellIpc(() => ({ state: "ready", version: "0.2.0" }));
    expect(await readDesktopUpdateStatus()).toEqual({ state: "ready", version: "0.2.0" });

    shellIpc(() => ({ state: "none" }));
    expect(await readDesktopUpdateStatus()).toEqual({ state: "none" });

    shellIpc(() => ({ state: "installed" }));
    expect(await readDesktopUpdateStatus()).toBeNull();
  });

  it("网页、旧版壳（没有这条命令）与调用失败都当不支持，不抛错", async () => {
    expect(await readDesktopUpdateStatus()).toBeNull();
    shellIpc(() => new Error("Command baka_update_status not found"));
    expect(await readDesktopUpdateStatus()).toBeNull();
  });

  it("安装命令不带任何参数：装什么由壳决定，页面给不出地址或字节", async () => {
    const invoke = shellIpc(() => null);
    expect(await installDesktopUpdate()).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]).toEqual(["baka_update_install"]);
  });

  it("壳拒绝安装或没有 IPC 时返回 false，调用方回落到下载链接", async () => {
    expect(await installDesktopUpdate()).toBe(false);
    shellIpc(() => new Error("没有已就绪的更新"));
    expect(await installDesktopUpdate()).toBe(false);
  });
});
