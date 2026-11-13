import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson, HttpError } from "./HttpJson";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 只在被中止时才落定的假 fetch：模拟后端挂起。 */
const hangingFetch = () =>
  vi.fn(
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
      })
  );

describe("fetchJson", () => {
  it("2xx 返回解析后的 JSON，并把请求选项透传给 fetch", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: 1 })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchJson("/api/x", { label: "测试接口", init: { cache: "no-store" } })
    ).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/x"),
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) })
    );
  });

  it("非 2xx 抛带状态码的 HttpError，文案带接口名", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 }))
    );
    const error = await fetchJson("/api/x", { label: "测试接口" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 503, message: "测试接口返回 HTTP 503" });
  });

  it("后端挂起时超时后中止，不会永远悬着", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    await expect(fetchJson("/api/x", { label: "测试接口", timeoutMs: 20 })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("调用方的取消信号同样中止请求", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const controller = new AbortController();
    const pending = fetchJson("/api/x", { label: "测试接口", signal: controller.signal });
    controller.abort(new Error("页面已离开"));
    await expect(pending).rejects.toThrow("页面已离开");
  });

  it("响应头到达后回调往返毫秒数，非 2xx 不回调", async () => {
    const onRoundTrip = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}"))
    );
    await fetchJson("/api/x", { label: "测试接口", onRoundTrip });
    expect(onRoundTrip).toHaveBeenCalledOnce();

    onRoundTrip.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 }))
    );
    await fetchJson("/api/x", { label: "测试接口", onRoundTrip }).catch(() => undefined);
    expect(onRoundTrip).not.toHaveBeenCalled();
  });
});
