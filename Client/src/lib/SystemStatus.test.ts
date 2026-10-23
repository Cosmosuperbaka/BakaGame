import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseSystemStatus,
  fetchSystemStatus,
  parseStatusHistory,
  fetchStatusHistory,
} from "./SystemStatus";

const valid = {
  observedAt: 1_760_000_000_000,
  level: "degraded",
  version: "V1.2.3（abcdef1）",
  components: [
    { id: "frontend", level: "operational" },
    { id: "backend", level: "operational" },
    { id: "upstream", level: "unknown" },
    { id: "rooms", level: "operational" },
    { id: "search", level: "degraded" },
    { id: "dataset", level: "unknown" },
    { id: "images", level: "operational" },
  ],
};

const validHistory = {
  days: 3,
  generatedAt: 1_760_000_000_000,
  entries: [
    {
      id: "backend",
      uptime: [{ days: 7, ratio: 0.5 }],
      cells: [
        { day: "2026-10-21", total: 12, ratio: 1, level: "operational" },
        { day: "2026-10-22", total: 12, ratio: 0.5, level: "degraded" },
        // 没有样本的一天：total 0 且 ratio 为 null，页面读作无数据而不是 0%。
        { day: "2026-10-23", total: 0, ratio: null, level: "unknown" },
      ],
    },
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
        { id: "backend", level: "broken" },
      ],
    });

    expect(parsed.components.map((component) => component.id)).toEqual(
      valid.components.map((component) => component.id)
    );
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

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 }))
    );
    await expect(fetchSystemStatus()).rejects.toThrow();
  });
});

describe("公开状态历史客户端", () => {
  it("解析日格与窗口可用率", () => {
    expect(parseStatusHistory(validHistory)).toEqual(validHistory);
  });

  it("比例越界时夹回 0–1，null 原样保留为无数据", () => {
    const parsed = parseStatusHistory({
      ...validHistory,
      entries: [
        {
          id: "backend",
          uptime: [{ days: 7, ratio: 1.8 }],
          cells: [
            { day: "2026-10-21", total: 3, ratio: -0.2, level: "degraded" },
            { day: "2026-10-22", total: 0, ratio: null, level: "unknown" },
          ],
        },
      ],
    });
    expect(parsed.entries[0].uptime[0].ratio).toBe(1);
    expect(parsed.entries[0].cells[0].ratio).toBe(0);
    expect(parsed.entries[0].cells[1].ratio).toBeNull();
  });

  it("丢弃白名单外的组件与形状不合的格子，不把整份历史读失败", () => {
    const parsed = parseStatusHistory({
      ...validHistory,
      entries: [
        { id: "internal-db", uptime: [], cells: [] },
        {
          id: "backend",
          uptime: [{ ratio: 0.5 }],
          cells: [
            { day: "2026-10-21", total: 12, ratio: 1, level: "operational" },
            { day: "2026-10-22", total: 12, ratio: 1, level: "broken" },
            null,
          ],
        },
      ],
    });
    expect(parsed.entries.map((entry) => entry.id)).toEqual(["backend"]);
    expect(parsed.entries[0].uptime).toEqual([]);
    expect(parsed.entries[0].cells.map((cell) => cell.day)).toEqual(["2026-10-21"]);
  });

  it("历史结构不完整时拒绝，请求非 2xx 时抛错", async () => {
    expect(() => parseStatusHistory({ days: 3 })).toThrow();
    expect(() => parseStatusHistory(null)).toThrow();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 }))
    );
    await expect(fetchStatusHistory()).rejects.toThrow();
  });

  it("请求 /api/status/history", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        urls.push(input instanceof Request ? input.url : String(input));
        return new Response(JSON.stringify(validHistory), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );
    await expect(fetchStatusHistory()).resolves.toEqual(validHistory);
    expect(urls[0]).toMatch(/\/api\/status\/history$/);
  });
});
