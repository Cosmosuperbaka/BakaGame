import { Elysia, t } from "elysia";
import {
  MockExternalStatusProbe,
  type ExternalStatusProbe,
} from "../../infrastructure/ExternalStatusProbe";
import type { StatusHistoryStore } from "../../infrastructure/StatusHistoryStore";
import {
  PUBLIC_STATUS_HISTORY_DAYS,
  type PublicStatusComponent,
  type PublicStatusLevel,
  type PublicStatusSnapshot,
} from "../../shared/Status";

export interface StatusProbeDependencies {
  /** 后端进程自身是否可服务；停机中返回 false。 */
  isServiceAvailable?: () => boolean;
  /** Meilisearch 健康探测地址；缺省时搜索状态为未知。 */
  meilisearchUrl?: string;
  /** 本地番剧数据集路径；缺省时数据集状态为未知。 */
  datasetPath?: string;
  /** 图床分片可用性；未装配图床时省略，状态显示未知。 */
  imageCache?: { available: boolean };
  /** 前端公开基址：服务端从外侧探一次静态站点是否可达；缺省时该组件为未知。 */
  frontendUrl?: string;
  /** 三个游戏的房间与连接汇总；未装配游戏服务时省略，状态显示未知。 */
  roomHealth?: () => { roomCount: number; connectionCount: number };
  /** 后端发布版本；由调用方从 changelog.json 同源处解析，缺省显示未知。 */
  version?: () => string;
  externalProbe?: ExternalStatusProbe;
  fetcher?: typeof fetch;
  now?: () => number;
}

export interface StatusRoutesDependencies extends StatusProbeDependencies {
  cacheTtlMs?: number;
  /** 历史账本；省略时只出当前快照，不记历史也不开历史接口。 */
  history?: StatusHistoryStore;
  /**
   * 已建好的聚合器。App 装配时传入，让 HTTP 接口与 WS 实时通道读同一份缓存、记同一本账；
   * 省略时按上面的探测依赖自建，单测因此不必先装配整个 App。
   */
  aggregator?: StatusAggregator;
}

/** 状态聚合同一时刻只跑一轮，短时缓存避免刷新页面就重新探测全部外部依赖。 */
const DEFAULT_CACHE_TTL_MS = 15_000;
const SEARCH_PROBE_TIMEOUT_MS = 1_500;
const FRONTEND_PROBE_TIMEOUT_MS = 3_000;

const levelOf = (available: boolean): PublicStatusLevel => (available ? "operational" : "degraded");

const settle = async (
  probe: () => Promise<PublicStatusLevel> | PublicStatusLevel,
  onError: PublicStatusLevel
): Promise<PublicStatusLevel> => {
  try {
    return await probe();
  } catch {
    return onError;
  }
};

/**
 * 状态聚合器：探测 → 快照 → 记历史，一处实现。
 *
 * HTTP 接口与 WS 实时通道共用同一个实例，两条路读到的才是同一份缓存与同一本账；
 * 各建一套会让页面在轮询与推送之间看到两种口径。
 */
export const createStatusAggregator = ({
  isServiceAvailable,
  meilisearchUrl,
  datasetPath,
  imageCache,
  frontendUrl,
  roomHealth,
  version = () => "unknown",
  externalProbe = new MockExternalStatusProbe(),
  fetcher = fetch,
  now = Date.now,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  history,
}: StatusRoutesDependencies) => {
  let cached: { at: number; snapshot: PublicStatusSnapshot } | undefined;
  let inflight: Promise<PublicStatusSnapshot> | undefined;

  const probeSearch = async (): Promise<PublicStatusLevel> => {
    if (!meilisearchUrl) return "unknown";
    const response = await fetcher(`${meilisearchUrl.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(SEARCH_PROBE_TIMEOUT_MS),
    });
    return levelOf(response.ok);
  };

  const probeDataset = (): PublicStatusLevel => {
    if (!datasetPath) return "unknown";
    // 这里只回答「数据集文件是否还在」；用 fs 读一次即可，不为此启动常驻轮询。
    return levelOf(Bun.file(datasetPath).size > 0);
  };

  const probeExternal = async (): Promise<PublicStatusLevel> => {
    try {
      // 外部监测未接入或暂时取不到时保持未知，不把「不知道」写成「正常」或「异常」。
      return (await externalProbe.read()) ?? "unknown";
    } catch {
      return "unknown";
    }
  };

  /** 前端可达性：静态外壳要真的吐出 HTML，拿到 SPA 兜底页之外的 200 才算活着。 */
  const probeFrontend = async (): Promise<PublicStatusLevel> => {
    if (!frontendUrl) return "unknown";
    const response = await fetcher(frontendUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(FRONTEND_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return "degraded";
    return /text\/html/i.test(response.headers.get("content-type") ?? "")
      ? "operational"
      : "degraded";
  };

  /**
   * 房间服务只看「三个游戏的对局服务是否装配并在跑」，不输出房间数与连接数：
   * 精确在线数是可被无限轮询的实时经营指标，公开状态页只给等级。
   */
  const probeRooms = (): PublicStatusLevel => {
    if (!roomHealth) return "unknown";
    return levelOf(Boolean(roomHealth()));
  };

  let resolvedVersion: string | undefined;
  const resolveVersion = (): string => {
    if (resolvedVersion !== undefined) return resolvedVersion;
    try {
      resolvedVersion = version();
    } catch {
      return "unknown";
    }
    return resolvedVersion;
  };

  const buildSnapshot = async (): Promise<PublicStatusSnapshot> => {
    const observedAt = now();
    const components: PublicStatusComponent[] = [
      { id: "frontend", level: await settle(probeFrontend, "degraded") },
      { id: "backend", level: levelOf(isServiceAvailable?.() ?? true) },
      { id: "upstream", level: await probeExternal() },
      { id: "rooms", level: await settle(probeRooms, "degraded") },
      { id: "search", level: await settle(probeSearch, "degraded") },
      { id: "dataset", level: await settle(probeDataset, "degraded") },
      { id: "images", level: imageCache ? levelOf(imageCache.available) : "unknown" },
    ];
    const snapshot: PublicStatusSnapshot = {
      observedAt,
      version: resolveVersion(),
      // 任一公开组件异常都算整体降级；未知不冒充异常，也不冒充正常。
      level: components.some((component) => component.level === "degraded")
        ? "degraded"
        : "operational",
      components,
    };
    // 只有真正跑了一轮探测才记账：缓存命中重复写会把同一次观测算成多个样本。
    history?.record(snapshot);
    return snapshot;
  };

  const readSnapshot = async (): Promise<PublicStatusSnapshot> => {
    const at = now();
    if (cached && at - cached.at < cacheTtlMs) return cached.snapshot;
    inflight ??= buildSnapshot()
      .then((snapshot) => {
        cached = { at: snapshot.observedAt, snapshot };
        return snapshot;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };

  return { readSnapshot, history };
};

export type StatusAggregator = ReturnType<typeof createStatusAggregator>;

/**
 * 组件白名单在响应 schema 里逐字写一遍：Elysia 要按字面量推断返回类型，
 * 由常量 map 出来的联合到这里会退化成 `string`，白名单就形同虚设。
 * `Status.test.ts` 用 `PUBLIC_STATUS_COMPONENT_IDS` 反向核对这份清单，两边不会各写各的。
 */
const componentIdSchema = t.Union([
  t.Literal("frontend"),
  t.Literal("backend"),
  t.Literal("upstream"),
  t.Literal("rooms"),
  t.Literal("search"),
  t.Literal("dataset"),
  t.Literal("images"),
]);

const levelSchema = t.Union([
  t.Literal("operational"),
  t.Literal("degraded"),
  t.Literal("unknown"),
]);

const snapshotSchema = t.Object({
  observedAt: t.Number(),
  level: levelSchema,
  version: t.String(),
  components: t.Array(t.Object({ id: componentIdSchema, level: levelSchema })),
});

const historySchema = t.Object({
  days: t.Number(),
  generatedAt: t.Number(),
  entries: t.Array(
    t.Object({
      id: componentIdSchema,
      uptime: t.Array(
        t.Object({
          days: t.Number(),
          ratio: t.Nullable(t.Number()),
        })
      ),
      cells: t.Array(
        t.Object({
          day: t.String(),
          total: t.Number(),
          ratio: t.Nullable(t.Number()),
          level: levelSchema,
        })
      ),
    })
  ),
});

/**
 * 公开状态接口：当前快照与历史条带各一个只读端点，外加供 WS 复用的聚合器。
 *
 * 只暴露白名单字段——组件等级、观测时刻与发布版本，不含地址、容器名、凭据或内部拓扑；
 * 房间与连接数这类实时经营指标一律不出接口。
 */
export const statusRoutes = (deps: StatusRoutesDependencies) => {
  const aggregator = deps.aggregator ?? createStatusAggregator(deps);
  const routes = new Elysia({ name: "public-status", normalize: false }).get(
    "/api/status",
    async ({ set }) => {
      set.headers["cache-control"] = "no-store";
      return aggregator.readSnapshot();
    },
    {
      detail: {
        tags: ["System"],
        summary: "公开站点状态",
        description:
          "返回前端、后端、上游监测与本项目内部各能力的归一化状态。只暴露白名单字段，不含地址、容器名、凭据或内部拓扑。",
      },
      response: snapshotSchema,
    }
  );

  if (!deps.history) return routes;

  return routes.get(
    "/api/status/history",
    async ({ set }) => {
      set.headers["cache-control"] = "no-store";
      return (
        aggregator.history?.read(PUBLIC_STATUS_HISTORY_DAYS) ?? {
          days: PUBLIC_STATUS_HISTORY_DAYS,
          generatedAt: Date.now(),
          entries: [],
        }
      );
    },
    {
      detail: {
        tags: ["System"],
        summary: "公开站点状态历史",
        description: "按北京时间自然日聚合的可用率窗口与日格，覆盖最近 90 天。",
      },
      response: historySchema,
    }
  );
};
