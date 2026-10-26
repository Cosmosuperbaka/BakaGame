import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseSystemStatus,
  fetchSystemStatus,
  parseStatusHistory,
  fetchStatusHistory,
  parseStatusRealtime,
  fetchStatusRealtime,
  parseStatusEvents,
  fetchStatusEvents,
} from "./SystemStatus";

const valid = {
  observedAt: 1_760_000_000_000,
  level: "degraded",
  version: "V1.2.3（abcdef1）",
  components: [
    { id: "frontend", level: "operational", latencyMs: null },
    { id: "backend", level: "operational", latencyMs: null },
    { id: "bangumi", level: "operational", latencyMs: 180 },
    { id: "qqmusic", level: "unknown", latencyMs: null },
    { id: "rooms", level: "operational", latencyMs: null },
    { id: "search", level: "degraded", latencyMs: null },
  ],
};

const validHistory = {
  days: 3,
  generatedAt: 1_760_000_000_000,
  entries: [
    {
      id: "backend",
      uptime: [{ days: 30, ratio: 0.5 }],
      cells: [
        { day: "2026-10-21", total: 12, ratio: 1, level: "operational" },
        { day: "2026-10-22", total: 12, ratio: 0.5, level: "degraded" },
        // 没有样本的一天：total 0 且 ratio 为 null，页面读作无数据而不是 0%。
        { day: "2026-10-23", total: 0, ratio: null, level: "unknown" },
      ],
    },
  ],
};

const validRealtime = {
  intervalMs: 180_000,
  windowMs: 21_600_000,
  generatedAt: 1_760_000_000_000,
  entries: [
    {
      id: "bangumi",
      uptime: 0.5,
      cells: [
        { start: 1_759_999_992_000, total: 2, ratio: 1, level: "operational", latencyMs: 150 },
        { start: 1_760_000_172_000, total: 1, ratio: 0, level: "degraded", latencyMs: null },
      ],
    },
  ],
};

const validEvents = {
  generatedAt: 1_760_000_000_000,
  events: [
    {
      id: 1,
      kind: "incident",
      title: "搜索索引不可用",
      body: "Meilisearch 重启中。",
      status: "investigating",
      components: ["search"],
      startedAt: 1_759_999_000_000,
      plannedEndAt: null,
      resolvedAt: null,
      updatedAt: 1_759_999_000_000,
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const stubFetch = (body: unknown, urls: string[]) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    })
  );
};

describe("公开状态接口客户端", () => {
  it("解析白名单字段", () => {
    expect(parseSystemStatus(valid)).toEqual(valid);
  });

  it("忽略未知组件与非法等级，非法延迟读作 null，保留已知项", () => {
    const parsed = parseSystemStatus({
      ...valid,
      components: [
        ...valid.components,
        { id: "internal-db", level: "operational", latencyMs: null },
        { id: "backend", level: "broken", latencyMs: null },
        { id: "qq", level: "operational", latencyMs: Number.NaN },
      ],
    });

    // 白名单外的组件被丢弃；backend 等级非法整项丢弃；qq 的非法延迟读作 null 但组件保留。
    expect(parsed.components.map((component) => component.id)).toEqual([
      ...valid.components.map((component) => component.id),
      "qq",
    ]);
    expect(parsed.components.find((component) => component.id === "bangumi")?.latencyMs).toBe(180);
    expect(parsed.components.find((component) => component.id === "qq")?.latencyMs).toBeNull();
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
    stubFetch(valid, urls);
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
          uptime: [{ days: 30, ratio: 1.8 }],
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
    stubFetch(validHistory, urls);
    await expect(fetchStatusHistory()).resolves.toEqual(validHistory);
    expect(urls[0]).toMatch(/\/api\/status\/history$/);
  });
});

describe("公开实时条带客户端", () => {
  it("解析窗口参数与样本格", () => {
    expect(parseStatusRealtime(validRealtime)).toEqual(validRealtime);
  });

  it("丢弃白名单外组件与形状不合的格子，非法延迟读作 null", () => {
    const parsed = parseStatusRealtime({
      ...validRealtime,
      entries: [
        { id: "internal-db", uptime: 1, cells: [] },
        {
          id: "qq",
          uptime: 2,
          cells: [
            { start: 1, total: 1, ratio: 1, level: "operational", latencyMs: -3 },
            { start: 2, total: "many", ratio: 1, level: "operational", latencyMs: 5 },
            null,
          ],
        },
      ],
    });
    expect(parsed.entries.map((entry) => entry.id)).toEqual(["qq"]);
    expect(parsed.entries[0].cells).toEqual([
      { start: 1, total: 1, ratio: 1, level: "operational", latencyMs: null },
    ]);
  });

  it("结构不完整时拒绝，请求非 2xx 时抛错", async () => {
    expect(() => parseStatusRealtime({ entries: [] })).toThrow();
    expect(() => parseStatusRealtime(null)).toThrow();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 }))
    );
    await expect(fetchStatusRealtime()).rejects.toThrow();
  });

  it("请求 /api/status/realtime", async () => {
    const urls: string[] = [];
    stubFetch(validRealtime, urls);
    await expect(fetchStatusRealtime()).resolves.toEqual(validRealtime);
    expect(urls[0]).toMatch(/\/api\/status\/realtime$/);
  });
});

describe("公开状态事件客户端", () => {
  it("解析事件清单并重新过组件白名单", () => {
    expect(parseStatusEvents(validEvents)).toEqual(validEvents.events);
  });

  it("丢弃非法事件与白名单外组件，不拖垮其余条目", () => {
    const parsed = parseStatusEvents({
      ...validEvents,
      events: [
        ...validEvents.events,
        { id: "two", kind: "incident" },
        {
          id: 3,
          kind: "maintenance",
          title: "数据库维护",
          body: "迁移实例",
          status: "scheduled",
          components: ["search", "internal-db"],
          startedAt: 5,
          plannedEndAt: 6,
          resolvedAt: null,
          updatedAt: 5,
        },
      ],
    });
    expect(parsed.map((event) => event.id)).toEqual([1, 3]);
    expect(parsed[1].components).toEqual(["search"]);
  });

  it("结构不完整时拒绝，请求非 2xx 时抛错", async () => {
    expect(() => parseStatusEvents({ events: "none" })).toThrow();
    expect(() => parseStatusEvents(null)).toThrow();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 }))
    );
    await expect(fetchStatusEvents()).rejects.toThrow();
  });

  it("请求 /api/status/events", async () => {
    const urls: string[] = [];
    stubFetch(validEvents, urls);
    await expect(fetchStatusEvents()).resolves.toEqual(validEvents.events);
    expect(urls[0]).toMatch(/\/api\/status\/events$/);
  });
});
