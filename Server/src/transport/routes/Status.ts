import { Elysia, t } from "elysia";
import {
  MockExternalStatusProbe,
  type ExternalStatusProbe,
} from "../../infrastructure/ExternalStatusProbe";
import type {
  PublicStatusComponent,
  PublicStatusLevel,
  PublicStatusSnapshot,
} from "../../shared/Status";

export interface StatusRoutesDependencies {
  /** 进程自身是否可服务；停机中返回 false。 */
  isServiceAvailable?: () => boolean;
  /** Meilisearch 健康探测地址；缺省时搜索状态为未知。 */
  meilisearchUrl?: string;
  /** 本地番剧数据集路径；缺省时数据集状态为未知。 */
  datasetPath?: string;
  /** 图床分片可用性；未装配图床时省略，状态显示未知。 */
  imageCache?: { available: boolean };
  /** 后端发布版本；由调用方从 changelog.json 同源处解析，缺省显示未知。 */
  version?: () => string;
  externalProbe?: ExternalStatusProbe;
  fetcher?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
}

/** 状态聚合同一时刻只跑一轮，短时缓存避免刷新页面就重新探测全部外部依赖。 */
const DEFAULT_CACHE_TTL_MS = 15_000;
const SEARCH_PROBE_TIMEOUT_MS = 1_500;

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

export const statusRoutes = ({
  isServiceAvailable,
  meilisearchUrl,
  datasetPath,
  imageCache,
  version = () => "unknown",
  externalProbe = new MockExternalStatusProbe(),
  fetcher = fetch,
  now = Date.now,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
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
      {
        id: "service",
        level: await settle(() => levelOf(isServiceAvailable?.() ?? true), "degraded"),
      },
      {
        id: "search",
        level: await settle(probeSearch, "degraded"),
      },
      {
        id: "dataset",
        level: await settle(probeDataset, "degraded"),
      },
      {
        id: "images",
        level: imageCache ? levelOf(imageCache.available) : "unknown",
      },
      {
        id: "external",
        level: await probeExternal(),
      },
    ];
    return {
      observedAt,
      version: resolveVersion(),
      // 任一公开组件异常都算整体降级；未知不冒充异常，也不冒充正常。
      level: components.some((component) => component.level === "degraded")
        ? "degraded"
        : "operational",
      components,
    };
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

  const componentSchema = t.Object({
    id: t.Union([
      t.Literal("service"),
      t.Literal("search"),
      t.Literal("dataset"),
      t.Literal("images"),
      t.Literal("external"),
    ]),
    level: t.Union([
      t.Literal("operational"),
      t.Literal("degraded"),
      t.Literal("unknown"),
    ]),
  });

  return new Elysia({ name: "public-status", normalize: false }).get(
    "/api/status",
    async ({ set }) => {
      set.headers["cache-control"] = "no-store";
      return readSnapshot();
    },
    {
      detail: {
        tags: ["System"],
        summary: "公开站点状态",
        description:
          "返回后端、搜索索引、番剧数据集、图片缓存与外部监测的归一化状态。只暴露白名单字段，不含地址、容器名、凭据或内部拓扑。",
      },
      response: t.Object({
        observedAt: t.Number(),
        level: t.Union([t.Literal("operational"), t.Literal("degraded"), t.Literal("unknown")]),
        version: t.String(),
        components: t.Array(componentSchema),
      }),
    }
  );
};
