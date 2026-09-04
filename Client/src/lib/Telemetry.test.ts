import { describe, expect, it, vi } from "vitest";
import { reportTelemetry } from "./Telemetry";

describe("reportTelemetry", () => {
  it("通过服务端代理路径向 /api/monitoring/telemetry 上报数据并注入 traceId", async () => {
    let capturedUrl = "";
    let capturedOptions: RequestInit | undefined;

    const mockFetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      capturedUrl = url;
      capturedOptions = options;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });

    await reportTelemetry(
      {
        level: "error",
        message: "测试报错",
        traceId: "trace-xyz",
        metadata: { key: "value" },
      },
      { fetcher: mockFetch as unknown as typeof fetch },
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toContain("/api/monitoring/telemetry");
    expect((capturedOptions?.headers as Record<string, string>)["x-trace-id"]).toBe("trace-xyz");
    const parsedBody = JSON.parse(capturedOptions?.body as string);
    expect(parsedBody.level).toBe("error");
    expect(parsedBody.message).toBe("测试报错");
  });

  it("网络异常时不抛出错误也不中断执行", async () => {
    const failingFetch = vi
      .fn()
      .mockRejectedValue(new Error("Network connection dropped")) as unknown as typeof fetch;

    await expect(
      reportTelemetry(
        {
          message: "网络抖动测试",
        },
        { fetcher: failingFetch },
      ),
    ).resolves.toBeUndefined();
  });
});
