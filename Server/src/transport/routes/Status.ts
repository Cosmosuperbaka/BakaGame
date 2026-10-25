import { Elysia, t } from "elysia";
import {
  MockExternalStatusProbe,
  type ExternalMonitorReading,
  type ExternalStatusProbe,
} from "../../infrastructure/ExternalStatusProbe";
import type { StatusHistoryStore } from "../../infrastructure/StatusHistoryStore";
import type { StatusSampleStore } from "../../infrastructure/StatusSampleStore";
import {
  isStatusEventActive,
  type StatusEventRepository,
} from "../../infrastructure/db/StatusEventRepository";
import {
  PUBLIC_STATUS_HISTORY_DAYS,
  UPSTREAM_STATUS_COMPONENT_IDS,
  type PublicStatusComponent,
  type PublicStatusEvents,
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
  /** 本进程的部署环境标记：历史、样本与事件都按它隔离，开发实例读不到生产的账。 */
  environment?: string;
  cacheTtlMs?: number;
  /** 历史账本；省略时只出当前快照，不记历史也不开历史接口。 */
  history?: StatusHistoryStore;
  /** 实时样本账本；省略时不记样本也不开实时接口。 */
  samples?: StatusSampleStore;
  /** 状态事件仓储；省略时事件接口回空列表（未配置数据库的实例）。 */
  events?: StatusEventRepository;
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
/** 公开事件接口的回看窗口：进行中的一律返回，已结束的只保留一个月。 */
const PUBLIC_EVENTS_SINCE_MS = 30 * 86_400_000;
const PUBLIC_EVENTS_LIMIT = 100;

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

  /** 外部监测未接入或暂时取不到时保持未知，不把「不知道」写成「正常」或「异常」。 */
  const probeExternal = async (): Promise<
    Partial<Record<(typeof UPSTREAM_STATUS_COMPONENT_IDS)[number], ExternalMonitorReading>>
  > => {
    try {
      return (await externalProbe.read()) ?? {};
    } catch {
      return {};
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
    const external = await probeExternal();
    const upstreamOf = (id: (typeof UPSTREAM_STATUS_COMPONENT_IDS)[number]) => {
      const reading = external[id];
      return { level: reading?.level ?? "unknown", latencyMs: reading?.latencyMs ?? null };
    };
    const bangumi = upstreamOf("bangumi");
    const qqmusic = upstreamOf("qqmusic");
    const netease = upstreamOf("netease");
    const qq = upstreamOf("qq");
    const components: PublicStatusComponent[] = [
      { id: "frontend", level: await settle(probeFrontend, "degraded"), latencyMs: null },
      { id: "backend", level: levelOf(isServiceAvailable?.() ?? true), latencyMs: null },
      { id: "bangumi", ...bangumi },
      { id: "qqmusic", ...qqmusic },
      { id: "netease", ...netease },
      { id: "qq", ...qq },
      { id: "rooms", level: await settle(probeRooms, "degraded"), latencyMs: null },
      { id: "search", level: await settle(probeSearch, "degraded"), latencyMs: null },
      { id: "dataset", level: await settle(probeDataset, "degraded"), latencyMs: null },
      { id: "images", level: imageCache ? levelOf(imageCache.available) : "unknown", latencyMs: null },
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
 * 后台采样器：每轮让聚合器真跑一次探测（间隔远大于快照缓存，命中不了缓存），
 * 把结果记进实时样本账本。快照照常由 HTTP 与 WS 按需触发，这里只保证
 * 没人看页面时实时条带也在按自己的节奏积累。
 */
export const startStatusSampler = ({
  aggregator,
  samples,
  intervalMs,
  onError = () => {},
}: {
  aggregator: StatusAggregator;
  samples: StatusSampleStore;
  intervalMs: number;
  onError?: (error: unknown) => void;
}): (() => void) => {
  const timer = setInterval(() => {
    void aggregator
      .readSnapshot()
      .then((snapshot) => samples.record(snapshot))
      .catch(onError);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};

/**
 * 组件白名单在响应 schema 里逐字写一遍：Elysia 要按字面量推断返回类型，
 * 由常量 map 出来的联合到这里会退化成 `string`，白名单就形同虚设。
 * `Status.test.ts` 用 `PUBLIC_STATUS_COMPONENT_IDS` 反向核对这份清单，两边不会各写各的。
 */
const componentIdSchema = t.Union([
  t.Literal("frontend"),
  t.Literal("backend"),
  t.Literal("bangumi"),
  t.Literal("qqmusic"),
  t.Literal("netease"),
  t.Literal("qq"),
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
  components: t.Array(
    t.Object({ id: componentIdSchema, level: levelSchema, latencyMs: t.Nullable(t.Number()) })
  ),
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

const realtimeSchema = t.Object({
  intervalMs: t.Number(),
  windowMs: t.Number(),
  generatedAt: t.Number(),
  entries: t.Array(
    t.Object({
      id: componentIdSchema,
      uptime: t.Nullable(t.Number()),
      cells: t.Array(
        t.Object({
          start: t.Number(),
          total: t.Number(),
          ratio: t.Nullable(t.Number()),
          level: levelSchema,
          latencyMs: t.Nullable(t.Number()),
        })
      ),
    })
  ),
});

const eventSchema = t.Object({
  id: t.Number(),
  kind: t.Union([t.Literal("incident"), t.Literal("maintenance")]),
  title: t.String(),
  body: t.String(),
  status: t.String(),
  components: t.Array(componentIdSchema),
  startedAt: t.Number(),
  plannedEndAt: t.Nullable(t.Number()),
  resolvedAt: t.Nullable(t.Number()),
  updatedAt: t.Number(),
});

const eventsSchema = t.Object({
  generatedAt: t.Number(),
  events: t.Array(eventSchema),
});

/** 公开事件列表：进行中的一律返回，已结束的只看近一个月；排序留给页面。 */
const readPublicEvents = async (
  events: StatusEventRepository,
  environment: string,
  now: number
): Promise<PublicStatusEvents> => {
  const [active, recent] = await Promise.all([
    events.list(environment, { active: true, limit: PUBLIC_EVENTS_LIMIT, offset: 0 }),
    events.list(environment, {
      since: now - PUBLIC_EVENTS_SINCE_MS,
      limit: PUBLIC_EVENTS_LIMIT,
      offset: 0,
    }),
  ]);
  const seen = new Set(active.items.map((event) => event.id));
  const merged = [...active.items, ...recent.items.filter((event) => !seen.has(event.id))];
  // 进行中的按开始时间正序读作时间线，已结束的按开始时间倒序接在后面。
  merged.sort((left, right) =>
    isStatusEventActive(left) === isStatusEventActive(right)
      ? isStatusEventActive(left)
        ? left.startedAt - right.startedAt
        : right.startedAt - left.startedAt
      : isStatusEventActive(left)
        ? -1
        : 1
  );
  return { generatedAt: now, events: merged };
};

/**
 * 公开状态接口：当前快照、历史条带、实时条带与状态事件各一个只读端点，
 * 外加供 WS 复用的聚合器与后台采样器。
 *
 * 只暴露白名单字段——组件等级、延迟毫秒、观测时刻与发布版本，不含地址、容器名、
 * 凭据或内部拓扑；房间与连接数这类实时经营指标一律不出接口。
 */
export const statusRoutes = (deps: StatusRoutesDependencies) => {
  const aggregator = deps.aggregator ?? createStatusAggregator(deps);
  const environment = deps.environment ?? "development";
  const { history, samples, events } = deps;
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
          "返回前端、后端、四个上游接口（含当前延迟）与本项目内部各能力的归一化状态。只暴露白名单字段，不含地址、容器名、凭据或内部拓扑。",
      },
      response: snapshotSchema,
    }
  );

  if (!history) return routes;

  const withHistory = routes.get(
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
        description: "按北京时间自然日聚合的可用率窗口与日格，覆盖最近 30 天。",
      },
      response: historySchema,
    }
  );

  if (!samples) return withHistory;

  const withRealtime = withHistory.get(
    "/api/status/realtime",
    async ({ set }) => {
      set.headers["cache-control"] = "no-store";
      return samples.read();
    },
    {
      detail: {
        tags: ["System"],
        summary: "公开站点实时条带",
        description:
          "按采样间隔（3 分钟）聚合的近 6 小时格子：可用率、等级与平均延迟，只含本环境的数据。",
      },
      response: realtimeSchema,
    }
  );

  if (!events) return withRealtime;

  return withRealtime.get(
    "/api/status/events",
    async ({ set }) => {
      set.headers["cache-control"] = "no-store";
      return readPublicEvents(events, environment, Date.now()).catch(() => ({
        generatedAt: Date.now(),
        events: [],
      }));
    },
    {
      detail: {
        tags: ["System"],
        summary: "公开状态事件",
        description:
          "进行中的故障事件与维护窗口一律返回，已结束的回看一个月；正文与管理操作不出现在这个接口。",
      },
      response: eventsSchema,
    }
  );
};
