import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSystemStatus, fetchSystemStatus } from "./SystemStatus";

const valid = {
  observedAt: 1_760_000_000_000,
  level: "degraded",
  version: "V1.2.3（abcdef1）",
  components: [
    { id: "service", level: "operational" },
    { id: "search", level: "degraded" },
    { id: "dataset", level: "unknown" },
    { id: "images", level: "operational" },
    { id: "external", level: "unknown" },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("公开状态接口客户端", () => {
  it("解析白名单字段", () => {
    expect(parseSystemStatus(valid)).toEqual(valid);
  });

  it("忽略未知组件与非法等级，保留已知项", () => {
    const parsed = parseSystemStatus({
      ...valid,
      components: [
        ...valid.components,
        { id: "internal-db", level: "operational" },
        { id: "service", level: "broken" },
      ],
    });

    expect(parsed.components.map((component) => component.id)).toEqual([
      "service",
      "search",
      "dataset",
      "images",
      "external",
    ]);
  });

  it("响应结构不完整时拒绝", () => {
    expect(() => parseSystemStatus({ ...valid, components: undefined })).toThrow();
    expect(() => parseSystemStatus({ ...valid, level: "ok" })).toThrow();
    expect(() => parseSystemStatus({ ...valid, observedAt: Number.NaN })).toThrow();
    expect(() => parseSystemStatus({ ...valid, version: 1 })).toThrow();
    expect(() => parseSystemStatus(null)).toThrow();
  });

  it("请求 /api/status，非 2xx 时抛错", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        urls.push(input instanceof Request ? input.url : String(input));
        return new Response(JSON.stringify(valid), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );
    await expect(fetchSystemStatus()).resolves.toEqual(valid);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/api\/status$/);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    await expect(fetchSystemStatus()).rejects.toThrow();
  });
});
