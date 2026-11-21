import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 模块级缓存跨用例存活：每个用例重新加载一份模块，从「还没问过」开始。
let loadClientPackages: typeof import("./ClientPackages").loadClientPackages;
let packagePlatformOf: typeof import("./ClientPackages").packagePlatformOf;

beforeEach(async () => {
  vi.resetModules();
  ({ loadClientPackages, packagePlatformOf } = await import("./ClientPackages"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const packages = [
  { platform: "windows", url: "https://example.com/a.exe", arch: "x64", available: true },
];

const respond = (body: unknown, status = 200) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  );

describe("客户端安装包列表", () => {
  it("只收形状合规的条目，请求成功即缓存同一份", async () => {
    respond({ packages: [...packages, { platform: "linux" }] });
    const first = await loadClientPackages();
    expect(first).toEqual({ packages, failed: false });
    expect(await loadClientPackages()).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("读失败不进缓存，下次可以重试", async () => {
    respond({}, 503);
    expect(await loadClientPackages()).toMatchObject({ packages: [], failed: true });
    respond({ packages });
    expect(await loadClientPackages()).toEqual({ packages, failed: false });
  });

  it("后端挂起时超时后按读失败处理，不让下载弹窗一直转圈", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
          })
      )
    );
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("超时", "TimeoutError")), 20);
      return controller.signal;
    });
    expect(await loadClientPackages()).toMatchObject({ packages: [], failed: true });

    respond({ packages });
    expect(await loadClientPackages()).toEqual({ packages, failed: false });
  });

  it("macOS 条目与 Windows、安卓一样收下，不认识的平台照旧丢掉", async () => {
    const mac = {
      platform: "macos",
      url: "https://example.com/a.dmg",
      arch: "Intel 与 Apple 芯片",
      available: false,
    };
    respond({ packages: [...packages, mac, { ...mac, platform: "linux" }] });
    expect(await loadClientPackages()).toEqual({ packages: [...packages, mac], failed: false });
  });

  it("壳该拿的包：移动壳只有安卓，桌面壳按自报平台分 Windows 与 macOS，认不出的按 Windows", () => {
    expect(packagePlatformOf("mobile", "android")).toBe("android");
    expect(packagePlatformOf("mobile", "macos")).toBe("android");
    expect(packagePlatformOf("desktop", "macos")).toBe("macos");
    expect(packagePlatformOf("desktop", "windows")).toBe("windows");
    expect(packagePlatformOf("desktop", undefined)).toBe("windows");
    expect(packagePlatformOf("desktop", "linux")).toBe("windows");
  });
});
