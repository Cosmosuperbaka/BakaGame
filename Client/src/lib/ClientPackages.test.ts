import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 模块级缓存跨用例存活：每个用例重新加载一份模块，从「还没问过」开始。
let loadClientPackages: typeof import("./ClientPackages").loadClientPackages;

beforeEach(async () => {
  vi.resetModules();
  ({ loadClientPackages } = await import("./ClientPackages"));
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
});
