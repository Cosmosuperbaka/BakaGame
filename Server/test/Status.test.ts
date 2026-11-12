import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import type { AppEnv } from "../src/config/Env";
import changelog from "../../Client/src/data/changelog.json";
import { latestStableVersion } from "../src/infrastructure/Release";
import { EventLogger } from "../src/infrastructure/EventLogger";
import {
  PUBLIC_STATUS_COMPONENT_IDS,
  type PublicStatusRealtime,
  type PublicStatusSnapshot,
} from "../src/shared/Status";
import { StatusHistoryStore } from "../src/infrastructure/StatusHistoryStore";
import { StatusSampleStore, sampleBucketOf } from "../src/infrastructure/StatusSampleStore";
import type { ExternalStatusProbe } from "../src/infrastructure/ExternalStatusProbe";
import { resolveStatusFrontendUrl } from "../src/config/env/Observability";
import type {
  StatusEventFilter,
  StatusEventInput,
  StatusEventPatch,
  StatusEventRepository,
} from "../src/infrastructure/db/StatusEventRepository";
import type { PublicStatusEvent } from "../src/shared/Status";
import {
  createStatusAggregator,
  statusRoutes,
  type StatusRoutesDependencies,
} from "../src/transport/routes/Status";
import { createTestApp } from "./AppFixtures";

const INTERNAL_SEARCH_URL = "http://10.23.45.67:7700";
const DATASET_PATH = "/srv/bakagame/private/dataset.sqlite";

const readStatus = async (
  overrides: StatusRoutesDependencies = {}
): Promise<{ response: Response; body: PublicStatusSnapshot }> => {
  const app = statusRoutes({
    fetcher: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    ...overrides,
  });
  const response = await app.handle(new Request("http://localhost/api/status"));
  return { response, body: (await response.json()) as PublicStatusSnapshot };
};

const componentLevel = (body: PublicStatusSnapshot, id: string) =>
  body.components.find((component) => component.id === id)?.level;

const realtimeOf = async (deps: StatusRoutesDependencies): Promise<PublicStatusRealtime> => {
  const app = statusRoutes({ ...deps });
  const response = await app.handle(new Request("http://localhost/api/status/realtime"));
  expect(response.status).toBe(200);
  return (await response.json()) as PublicStatusRealtime;
};

describe("公开状态接口", () => {
  test("只返回白名单字段，不泄露地址、路径与内部标识", async () => {
    const { response, body } = await readStatus({
      meilisearchUrl: `${INTERNAL_SEARCH_URL}/`,
      datasetPath: DATASET_PATH,
      imageCache: { available: true },
      version: () => "V1.2.3（abcdef1）",
      now: () => 1_700_000_000_000,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(body).sort()).toEqual(["components", "level", "observedAt", "version"]);
    expect(body.observedAt).toBe(1_700_000_000_000);
    expect(body.version).toBe("V1.2.3（abcdef1）");
    expect(body.components.map((component) => component.id)).toEqual([
      ...PUBLIC_STATUS_COMPONENT_IDS,
    ]);
    for (const component of body.components) {
      expect(Object.keys(component).sort()).toEqual(["id", "latencyMs", "level"]);
    }

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("10.23.45.67");
    expect(serialized).not.toContain("/srv/bakagame");
    expect(serialized).not.toContain(INTERNAL_SEARCH_URL);
    expect(serialized).not.toContain(DATASET_PATH);
  });

  test("服务停机、搜索失败、数据集缺失都显示为异常", async () => {
    const { body } = await readStatus({
      isServiceAvailable: () => false,
      meilisearchUrl: INTERNAL_SEARCH_URL,
      fetcher: (async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
      datasetPath: join(tmpdir(), `missing-dataset-${crypto.randomUUID()}.sqlite`),
      imageCache: { available: false },
    });

    expect(componentLevel(body, "backend")).toBe("degraded");
    expect(componentLevel(body, "search")).toBe("degraded");
    expect(componentLevel(body, "dataset")).toBe("degraded");
    expect(componentLevel(body, "images")).toBe("degraded");
    expect(body.level).toBe("degraded");
  });

  test("外部监测按组件拆开读，未映射的上游不冒充结论，延迟跟着等级走", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bakagame-status-"));
    const dataset = join(directory, "bangumi.sqlite");
    writeFileSync(dataset, "fixture");
    try {
      const external: ExternalStatusProbe = {
        read: async () => ({
          bangumi: { level: "operational", latencyMs: 180 },
          qqmusic: { level: "degraded", latencyMs: null },
        }),
      };
      const { body } = await readStatus({
        meilisearchUrl: INTERNAL_SEARCH_URL,
        datasetPath: dataset,
        imageCache: { available: true },
        externalProbe: external,
      });

      expect(componentLevel(body, "backend")).toBe("operational");
      expect(body.components.find((item) => item.id === "bangumi")).toEqual({
        id: "bangumi",
        level: "operational",
        latencyMs: 180,
      });
      expect(componentLevel(body, "qqmusic")).toBe("degraded");
      // 未映射的组件读作未知，延迟没有读数。
      expect(body.components.find((item) => item.id === "qq")).toEqual({
        id: "qq",
        level: "unknown",
        latencyMs: null,
      });
      // 任一上游异常都把整体拉成异常。
      expect(body.level).toBe("degraded");
      expect(body.version).toBe("unknown");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("外部探针抛错时只把上游各项降为未知，接口照常响应", async () => {
    const external: ExternalStatusProbe = {
      read: async () => {
        throw new Error("probe offline");
      },
    };
    const { response, body } = await readStatus({ externalProbe: external });

    expect(response.status).toBe(200);
    expect(componentLevel(body, "bangumi")).toBe("unknown");
    expect(componentLevel(body, "backend")).toBe("operational");
  });

  test("未配置搜索、数据集与图床时对应项为未知", async () => {
    const { body } = await readStatus();

    expect(componentLevel(body, "search")).toBe("unknown");
    expect(componentLevel(body, "dataset")).toBe("unknown");
    expect(componentLevel(body, "images")).toBe("unknown");
    expect(componentLevel(body, "bangumi")).toBe("unknown");
  });

  test("短缓存合并重复请求，过期后重新探测", async () => {
    let fetches = 0;
    let at = 1_000;
    const fetcher = (async () => {
      fetches += 1;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const app = statusRoutes({
      meilisearchUrl: INTERNAL_SEARCH_URL,
      fetcher,
      now: () => at,
      cacheTtlMs: 15_000,
    });

    const first = (await (
      await app.handle(new Request("http://localhost/api/status"))
    ).json()) as PublicStatusSnapshot;
    at += 5_000;
    const second = (await (
      await app.handle(new Request("http://localhost/api/status"))
    ).json()) as PublicStatusSnapshot;
    expect(fetches).toBe(1);
    expect(second.observedAt).toBe(first.observedAt);

    at += 15_000;
    const third = (await (
      await app.handle(new Request("http://localhost/api/status"))
    ).json()) as PublicStatusSnapshot;
    expect(fetches).toBe(2);
    expect(third.observedAt).toBe(at);
  });

  test("发布版本只解析一次，重复探测不会反复读仓库", async () => {
    let calls = 0;
    let at = 1_000;
    const app = statusRoutes({
      version: () => {
        calls += 1;
        return `V1.0.${calls}`;
      },
      now: () => at,
      cacheTtlMs: 0,
    });

    const first = (await (
      await app.handle(new Request("http://localhost/api/status"))
    ).json()) as PublicStatusSnapshot;
    at += 1;
    const second = (await (
      await app.handle(new Request("http://localhost/api/status"))
    ).json()) as PublicStatusSnapshot;

    expect(calls).toBe(1);
    expect(first.version).toBe("V1.0.1");
    expect(second.version).toBe("V1.0.1");
    expect(second.observedAt).toBe(1_001);
  });

  test("并发请求共用同一轮探测", async () => {
    let fetches = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = (async () => {
      fetches += 1;
      await gate;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const app = statusRoutes({ meilisearchUrl: INTERNAL_SEARCH_URL, fetcher });

    const requests = [
      app.handle(new Request("http://localhost/api/status")),
      app.handle(new Request("http://localhost/api/status")),
      app.handle(new Request("http://localhost/api/status")),
    ];
    release();
    const responses = await Promise.all(requests);
    expect(fetches).toBe(1);
    const bodies = (await Promise.all(
      responses.map((response) => response.json())
    )) as PublicStatusSnapshot[];
    expect(bodies[0]).toEqual(bodies[1]!);
    expect(bodies[1]).toEqual(bodies[2]!);
  });
});

describe("公开状态实时条带", () => {
  test("样本按采样间隔聚合格子，延迟求均值，窗口外的裁掉", async () => {
    const now = 1_700_000_000_000;
    const samples = new StatusSampleStore({ environment: "production", now: () => now });
    const history = new StatusHistoryStore({ environment: "production", now: () => now });
    const snapshot = (
      observedAt: number,
      bangumiLatency: number,
      qqmusicLevel: "operational" | "degraded"
    ): PublicStatusSnapshot => ({
      observedAt,
      level: "operational",
      version: "V1.2.3",
      components: [
        { id: "bangumi", level: "operational", latencyMs: bangumiLatency },
        { id: "qqmusic", level: qqmusicLevel, latencyMs: null },
        { id: "backend", level: "operational", latencyMs: null },
      ],
    });
    // 当前格两次采样（延迟均值 150），上一格一次（延迟 300、qqmusic 异常）。
    samples.record(snapshot(now - 190_000, 300, "degraded"));
    samples.record(snapshot(now, 100, "operational"));
    samples.record(snapshot(now, 200, "operational"));

    const realtime = await realtimeOf({ samples, history, now: () => now });
    expect(realtime.intervalMs).toBe(180_000);
    const bangumi = realtime.entries.find((entry) => entry.id === "bangumi");
    const current = bangumi?.cells.find((cell) => cell.start === sampleBucketOf(now));
    expect(current).toMatchObject({ total: 2, ratio: 1, level: "operational", latencyMs: 150 });
    const previous = bangumi?.cells.find((cell) => cell.start === sampleBucketOf(now - 190_000));
    expect(previous).toMatchObject({ total: 1, ratio: 1, level: "operational", latencyMs: 300 });
    const qqmusic = realtime.entries.find((entry) => entry.id === "qqmusic");
    const previousQq = qqmusic?.cells.find((cell) => cell.start === sampleBucketOf(now - 190_000));
    expect(previousQq).toMatchObject({ total: 1, ratio: 0, level: "degraded" });
    // 内部组件没有延迟口径，读作 null 而不是 0ms。
    const backend = realtime.entries.find((entry) => entry.id === "backend");
    expect(backend?.cells.every((cell) => cell.latencyMs === null)).toBe(true);
  });

  test("实时格子的可用率只算有结论样本，unknown 不进分母", async () => {
    const now = 1_700_000_000_000;
    const samples = new StatusSampleStore({ environment: "production", now: () => now });
    const history = new StatusHistoryStore({ environment: "production", now: () => now });
    const backendSnapshot = (levels: ("operational" | "degraded" | "unknown")[]) => ({
      observedAt: now,
      level: "operational" as const,
      version: "V1.2.3",
      components: levels.map((level) => ({ id: "backend" as const, level, latencyMs: null })),
    });
    // 全 unknown：没有结论，格子与窗口都不给比例。
    samples.record(backendSnapshot(["unknown", "unknown"]));
    let realtime = await realtimeOf({ samples, history, now: () => now });
    let backend = realtime.entries.find((entry) => entry.id === "backend");
    expect(backend?.uptime).toBeNull();
    expect(backend?.cells[0]).toMatchObject({ total: 2, ratio: null, level: "unknown" });

    // 混入 unknown：分母只数有结论的样本。
    samples.record(backendSnapshot(["operational"]));
    realtime = await realtimeOf({ samples, history, now: () => now });
    backend = realtime.entries.find((entry) => entry.id === "backend");
    expect(backend?.uptime).toBe(1);
    expect(backend?.cells[0]).toMatchObject({ total: 3, ratio: 1, level: "operational" });

    // 有降级即降级，unknown 依旧不拉低比例。
    samples.record(backendSnapshot(["degraded", "unknown"]));
    realtime = await realtimeOf({ samples, history, now: () => now });
    backend = realtime.entries.find((entry) => entry.id === "backend");
    expect(backend?.uptime).toBeCloseTo(1 / 2);
    expect(backend?.cells[0]).toMatchObject({ total: 5, ratio: 1 / 2, level: "degraded" });
  });
});

describe("前端与搜索探测", () => {
  test("operational 时给出非负整数延迟，降级不给延迟", async () => {
    const fetcher = (async () =>
      new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as unknown as typeof fetch;
    const { body } = await readStatus({
      frontendUrl: "https://frontend.example.com/",
      meilisearchUrl: INTERNAL_SEARCH_URL,
      fetcher,
    });
    for (const id of ["frontend", "search"]) {
      const component = body.components.find((item) => item.id === id);
      expect(component?.level).toBe("operational");
      expect(Number.isInteger(component?.latencyMs)).toBe(true);
      expect((component?.latencyMs ?? -1) >= 0).toBe(true);
    }
  });

  test("前端非 HTML 或 5xx 时读作降级，延迟为空", async () => {
    const fetcher = (async () =>
      new Response(null, {
        status: 503,
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;
    const { body } = await readStatus({
      frontendUrl: "https://frontend.example.com/",
      fetcher,
    });
    const frontend = body.components.find((item) => item.id === "frontend");
    expect(frontend).toEqual({ id: "frontend", level: "degraded", latencyMs: null });
  });

  test("前端探测不自动跟随跳转：跳离本站即降级，且只请求一次", async () => {
    const calls: { url: string; redirect: RequestInit["redirect"] }[] = [];
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), redirect: init?.redirect });
      return new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example.com/" },
      });
    }) as unknown as typeof fetch;
    const { body } = await readStatus({
      frontendUrl: "https://frontend.example.com/",
      fetcher,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].redirect).toBe("manual");
    expect(body.components.find((item) => item.id === "frontend")?.level).toBe("degraded");
  });
});

describe("前端探测地址兜底", () => {
  test("显式配置优先，否则取 CLIENT_URL 第一个 http(s) 来源", () => {
    expect(resolveStatusFrontendUrl("https://a.example.com", "https://b.example.com")).toBe(
      "https://a.example.com"
    );
    // 名单里排在前面的本机与内网来源让位给公网来源：探它们只会在容器里连不上。
    expect(
      resolveStatusFrontendUrl(
        undefined,
        "http://localhost:5173, http://192.168.1.8:5173, https://c.example.com/app"
      )
    ).toBe("https://c.example.com/");
    // 只有本机来源（本地开发）时退回第一个 http(s) 来源。
    expect(resolveStatusFrontendUrl(undefined, "http://localhost:5173")).toBe(
      "http://localhost:5173/"
    );
    expect(resolveStatusFrontendUrl("   ", "ws://d.example.com, https://e.example.com")).toBe(
      "https://e.example.com/"
    );
    expect(resolveStatusFrontendUrl(undefined, "ws://d.example.com, not a url")).toBeUndefined();
    expect(resolveStatusFrontendUrl(undefined, undefined)).toBeUndefined();
  });
});

/** 事件仓储的内存替身：环境过滤在行上自记，行为与 SQL 版一致。 */
class MemoryStatusEventRepository implements StatusEventRepository {
  readonly rows = new Map<number, PublicStatusEvent & { environment: string }>();
  private nextId = 1;

  async list(environment: string, filter: StatusEventFilter) {
    const items = [...this.rows.values()]
      .filter((event) => event.environment === environment)
      .filter((event) => (filter.kind ? event.kind === filter.kind : true))
      .filter((event) =>
        filter.active !== undefined
          ? (event.resolvedAt === null && event.status !== "done") === filter.active
          : true
      )
      .filter((event) => (filter.since !== undefined ? event.startedAt >= filter.since : true))
      .sort((left, right) => right.startedAt - left.startedAt);
    return {
      items: items.slice(filter.offset, filter.offset + filter.limit),
      total: items.length,
    };
  }

  async get(environment: string, id: number) {
    const row = this.rows.get(id);
    return row && row.environment === environment ? row : null;
  }

  async create(environment: string, input: StatusEventInput) {
    const id = this.nextId++;
    const event = {
      ...input,
      environment,
      id,
      updatedAt: Date.now(),
    } as PublicStatusEvent & { environment: string };
    this.rows.set(id, event);
    return event;
  }

  async update(environment: string, id: number, patch: StatusEventPatch) {
    const row = await this.get(environment, id);
    if (!row) throw new Error("not found");
    const next = { ...row, ...patch, updatedAt: Date.now() };
    this.rows.set(id, next);
    return next;
  }

  async remove(environment: string, id: number) {
    const row = await this.get(environment, id);
    if (row) this.rows.delete(id);
  }
}

describe("公开状态事件接口", () => {
  test("进行中的一律返回，已结束的回看一个月，不同环境互不可见", async () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    const events = new MemoryStatusEventRepository();
    const history = new StatusHistoryStore({ environment: "production", now: () => now });
    const samples = new StatusSampleStore({ environment: "production", now: () => now });
    const base = {
      kind: "incident" as const,
      title: "上游异常",
      body: "Bangumi API 超时",
      status: "investigating" as const,
      components: ["bangumi" as const],
      plannedEndAt: null,
      resolvedAt: null,
    };
    await events.create("production", { ...base, startedAt: now - 3_600_000 });
    await events.create("production", {
      ...base,
      status: "resolved",
      startedAt: now - 5 * 86_400_000,
      resolvedAt: now - 5 * 86_400_000 + 600_000,
    });
    await events.create("production", {
      ...base,
      status: "resolved",
      startedAt: now - 40 * 86_400_000,
      resolvedAt: now - 40 * 86_400_000 + 600_000,
    });
    await events.create("development", { ...base, startedAt: now - 1_000 });

    const app = statusRoutes({ environment: "production", history, samples, events });
    const response = await app.handle(new Request("http://localhost/api/status/events"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: PublicStatusEvent[] };
    // 进行中的排最前，接着是近一个月内结束的；40 天前的与开发环境的不出现。
    expect(body.events).toHaveLength(2);
    expect(body.events[0].title).toBe("上游异常");
    expect(body.events[0].resolvedAt).toBeNull();
    expect(body.events[1].resolvedAt).not.toBeNull();
  });

  test("读取事件失败时降级为空列表，并把故障交给 onError 留痕", async () => {
    const failures: Array<[string, unknown]> = [];
    class BrokenEvents extends MemoryStatusEventRepository {
      override async list(): Promise<never> {
        throw new Error("仓储不可用");
      }
    }
    const now = Date.parse("2026-10-25T12:00:00Z");
    const app = statusRoutes({
      environment: "production",
      history: new StatusHistoryStore({ environment: "production", now: () => now }),
      samples: new StatusSampleStore({ environment: "production", now: () => now }),
      events: new BrokenEvents(),
      onError: (scope, error) => failures.push([scope, error]),
    });
    const response = await app.handle(new Request("http://localhost/api/status/events"));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { events: unknown[] }).events).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0][0]).toBe("status-events");
  });
});

describe("状态聚合并行探测", () => {
  test("外部监测读取与搜索探测并行：总耗时取最慢的一项，而不是各项之和", async () => {
    const delayMs = 150;
    const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));
    const aggregator = createStatusAggregator({
      meilisearchUrl: "http://127.0.0.1:9/",
      fetcher: (async () => {
        await wait();
        return new Response("{}");
      }) as unknown as typeof fetch,
      externalProbe: {
        read: async () => {
          await wait();
          return {};
        },
      } as unknown as ExternalStatusProbe,
    });
    const startedAt = performance.now();
    await aggregator.readSnapshot();
    expect(performance.now() - startedAt).toBeLessThan(delayMs * 1.8);
  });
});

test("完整应用装配后 /api/status 可访问，版本号与 changelog.json 同源", async () => {
  const env: AppEnv = {
    maintenanceToken: "test-maintenance-token",
    clientUrl: "http://localhost:5173",
    serverUrl: "http://127.0.0.1",
    serverListenHost: "127.0.0.1",
    serverPort: 0,
    bangumiApiUrl: "https://api.bgm.tv",
    bangumiImageUrl: "",
  };
  const { app } = createTestApp({
    env,
    whoIsFakerService: new WhoIsFakerService({ eventLogger: new EventLogger() }),
    logger: new EventLogger(),
  });

  const response = await app.handle(new Request("http://localhost/api/status"));
  expect(response.status).toBe(200);
  const body = (await response.json()) as PublicStatusSnapshot;
  expect(body.components.map((component) => component.id)).toEqual([
    ...PUBLIC_STATUS_COMPONENT_IDS,
  ]);
  // 版本号与更新日志同一真相源：状态页展示的正是 changelog.json 中的最大稳定版本。
  expect(typeof body.version).toBe("string");
  expect(body.version.startsWith(`V${latestStableVersion(changelog)}`)).toBe(true);
});
