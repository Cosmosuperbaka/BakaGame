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
  type PublicStatusSnapshot,
} from "../src/shared/Status";
import type { ExternalStatusProbe } from "../src/infrastructure/ExternalStatusProbe";
import {
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
      expect(Object.keys(component).sort()).toEqual(["id", "level"]);
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

    expect(componentLevel(body, "service")).toBe("degraded");
    expect(componentLevel(body, "search")).toBe("degraded");
    expect(componentLevel(body, "dataset")).toBe("degraded");
    expect(componentLevel(body, "images")).toBe("degraded");
    expect(body.level).toBe("degraded");
  });

  test("数据缺口与外部监测未知不冒充异常，整体仍可判为正常", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bakagame-status-"));
    const dataset = join(directory, "bangumi.sqlite");
    writeFileSync(dataset, "fixture");
    try {
      const external: ExternalStatusProbe = { read: async () => null };
      const { body } = await readStatus({
        meilisearchUrl: INTERNAL_SEARCH_URL,
        datasetPath: dataset,
        imageCache: { available: true },
        externalProbe: external,
      });

      expect(componentLevel(body, "service")).toBe("operational");
      expect(componentLevel(body, "search")).toBe("operational");
      expect(componentLevel(body, "dataset")).toBe("operational");
      expect(componentLevel(body, "images")).toBe("operational");
      expect(componentLevel(body, "external")).toBe("unknown");
      expect(body.level).toBe("operational");
      expect(body.version).toBe("unknown");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("外部探针抛错时只把外部项降为未知，接口照常响应", async () => {
    const external: ExternalStatusProbe = {
      read: async () => {
        throw new Error("probe offline");
      },
    };
    const { response, body } = await readStatus({ externalProbe: external });

    expect(response.status).toBe(200);
    expect(componentLevel(body, "external")).toBe("unknown");
    expect(componentLevel(body, "service")).toBe("operational");
  });

  test("未配置搜索、数据集与图床时对应项为未知", async () => {
    const { body } = await readStatus();

    expect(componentLevel(body, "search")).toBe("unknown");
    expect(componentLevel(body, "dataset")).toBe("unknown");
    expect(componentLevel(body, "images")).toBe("unknown");
    expect(componentLevel(body, "external")).toBe("unknown");
  });

  test("短缓存合并重复请求，过期后重新探测", async () => {
    let fetches = 0;
    let clock = 1_000;
    const fetcher = (async () => {
      fetches += 1;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const app = statusRoutes({
      meilisearchUrl: INTERNAL_SEARCH_URL,
      fetcher,
      now: () => clock,
      cacheTtlMs: 15_000,
    });

    const first = (await (
      await app.handle(new Request("http://localhost/api/status"))
    ).json()) as PublicStatusSnapshot;
    clock += 5_000;
    const second = (await (
      await app.handle(new Request("http://localhost/api/status"))
    ).json()) as PublicStatusSnapshot;
    expect(fetches).toBe(1);
    expect(second.observedAt).toBe(first.observedAt);

    clock += 15_000;
    const third = (await (
      await app.handle(new Request("http://localhost/api/status"))
    ).json()) as PublicStatusSnapshot;
    expect(fetches).toBe(2);
    expect(third.observedAt).toBe(clock);
  });

  test("发布版本只解析一次，重复探测不会反复读仓库", async () => {
    let calls = 0;
    let clock = 1_000;
    const app = statusRoutes({
      version: () => {
        calls += 1;
        return `V1.0.${calls}`;
      },
      now: () => clock,
      cacheTtlMs: 0,
    });

    const first = (await (
      await app.handle(new Request("http://localhost/api/status"))
    ).json()) as PublicStatusSnapshot;
    clock += 1;
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
    const bodies = (await Promise.all(responses.map((response) => response.json()))) as
      PublicStatusSnapshot[];
    expect(bodies[0]).toEqual(bodies[1]!);
    expect(bodies[1]).toEqual(bodies[2]!);
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
