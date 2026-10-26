import { AppError } from "../../domain/Errors";
import { UPSTREAM_STATUS_COMPONENT_IDS, type UpstreamStatusComponentId } from "../../shared/Status";

/** 控制台 ANSI 颜色的三档策略；`auto` 只在 TTY 上着色。 */
export type LogConsoleColor = "auto" | "always" | "never";

/** 结构化日志里的操作范围：`errors` 只记失败与慢操作，`all` 记录每次请求。 */
export type LogOperations = "errors" | "all";

/**
 * 遥测与运维凭据（T1）：全部是引导项，必须在建库之前就有值。
 * 分层口径见 `Agents/Conventions.md` §5。
 */
export interface EnvObservability {
  otelEndpoint?: string;
  otelHeaders?: Record<string, string>;
  otelServiceName?: string;
  otelServiceNamespace?: string;
  otelDeploymentEnvironment?: string;
  /**
   * HTTP 文档页（`/openapi`）是否挂载。缺省视为开启（测试与本地开发装配 env 时不必逐个声明），
   * 生产由 `loadEnv` 依 `DEPLOYMENT_ENVIRONMENT` 关掉。
   */
  openapiEnabled?: boolean;
  maintenanceToken?: string;
  sentryDsn?: string;
  sentryAllowedProjectIds?: string[];
  /** 管理后台概览代查 Sentry 用的只读令牌（org:read、project:read、event:read）；不配则后台显示未配置。 */
  sentryApiToken?: string;
  /** Better Stack Uptime 只读 API 令牌；不配则公开状态页的外部监测显示未知。 */
  betterStackApiKey?: string;
  /**
   * 上游组件 → Better Stack monitor ID 的映射（`bangumi=<id>,qqmusic=<id>,…`）。
   * 未列出的组件显示未知：monitor 与组件的对应是部署事实，不靠名称猜测。
   */
  betterStackMonitorMap?: Partial<Record<UpstreamStatusComponentId, string>>;
  /**
   * 前端公开基址：状态页的「前端」一格由服务端从外侧探这个地址得到。
   * 不配则显示未知——后端无法凭「自己还活着」推断静态站点可达。
   */
  statusFrontendUrl?: string;
  /** 链路采样率：只认 `0`–`1` 之间的数，其余按未配置处理，缺省值由消费方套用。 */
  sentryTracesSampleRate?: number;
  /** 本地 OTel JSONL 日志目录；缺省 `Server/storage/logs`。 */
  logDirectory?: string;
  /** 结构化日志中的操作范围；控制台始终不会逐条打印成功操作。 */
  logOperations?: LogOperations;
  /** 控制台颜色策略；缺省 auto（仅 TTY 着色）。 */
  logConsoleColor?: LogConsoleColor;
  /** 操作慢于该毫秒数时进入结构化日志并显示在控制台；缺省 1000。 */
  logSlowOperationMs?: number;
  /**
   * 部署环境标记是否被**显式注入**（见 `resolveDeploymentEnvironment` 的四个来源，任一为非空值）。
   * 判「这台是不是生产」要看这个，不看解析结果：一次环境变量漏配会把生产实例静默回落成
   * development——心跳停报、事件与本地开发流量同池，事后从数据里分不出来。
   * 消费方是 `infrastructure/Sentry.ts` 的初始化门：配了遥测凭据却缺显式标记即拒绝启动（缺省即安全失败）。
   */
  deploymentMarkerExplicit?: boolean;
}

/** 缺省采样率：没配、配错或配成 0–1 之外的数都落回这里。 */
export const DEFAULT_SENTRY_TRACES_SAMPLE_RATE = 0.2;

const parseSampleRate = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
};

const parseConsoleColor = (raw: string | undefined): LogConsoleColor | undefined => {
  const value = raw?.trim().toLowerCase();
  return value === "auto" || value === "always" || value === "never" ? value : undefined;
};

const parseSlowOperationMs = (raw: string | undefined): number | undefined => {
  const value = Number(raw?.trim());
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
};

const parseOtelResourceAttributes = (raw?: string): Record<string, string> => {
  if (!raw) return {};
  const attrs: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      const key = part.slice(0, eqIdx).trim();
      let value = part.slice(eqIdx + 1).trim();
      try {
        value = decodeURIComponent(value);
      } catch {
        // fallback
      }
      attrs[key] = value;
    }
  }
  return attrs;
};

const parseOtelHeaders = (raw?: string): Record<string, string> | undefined => {
  if (!raw) return undefined;
  const headers: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      const key = part.slice(0, eqIdx).trim();
      let value = part.slice(eqIdx + 1).trim();
      try {
        value = decodeURIComponent(value);
      } catch {
        // 解码异常时退回原始值
      }
      headers[key] = value;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
};

/**
 * 环境标记的四个来源，按优先级排好并 trim：`""`（照 `.env.example` 抄下来的空赋值）
 * 视同未设置，不允许空串顶掉后续兜底、把事件标成无名环境。
 */
const deploymentMarkerChain = (): string[] => {
  const resourceAttrs = parseOtelResourceAttributes(Bun.env.OTEL_RESOURCE_ATTRIBUTES);
  return [
    Bun.env.DEPLOYMENT_ENVIRONMENT,
    Bun.env.OTEL_DEPLOYMENT_ENVIRONMENT,
    resourceAttrs["deployment.environment"],
    Bun.env.NODE_ENV,
  ].map((value) => value?.trim() ?? "");
};

/** 环境解析：显式环境变量优先，缺省 development；不按操作系统猜测。 */
export const resolveDeploymentEnvironment = (): string =>
  deploymentMarkerChain().find(Boolean) ?? "development";

/**
 * `BETTERSTACK_MONITOR_MAP` 形如 `bangumi=12345,qqmusic=67890`：
 * 只认上游组件白名单里的键与纯数字 monitor ID，写错的键直接拒绝启动，
 * 拼错键只会让状态页悄悄显示未知——那比启动失败更难排查。
 */
const parseBetterStackMonitorMap = (
  raw: string | undefined
): Partial<Record<UpstreamStatusComponentId, string>> | undefined => {
  const text = raw?.trim();
  if (!text) return undefined;
  const map: Partial<Record<UpstreamStatusComponentId, string>> = {};
  for (const part of text.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eqIdx = entry.indexOf("=");
    const key = eqIdx > 0 ? entry.slice(0, eqIdx).trim() : "";
    const value = eqIdx > 0 ? entry.slice(eqIdx + 1).trim() : "";
    if (!(UPSTREAM_STATUS_COMPONENT_IDS as readonly string[]).includes(key)) {
      throw new AppError(
        "CONFIG_ERROR",
        `BETTERSTACK_MONITOR_MAP 含未知组件 ${key || entry}（可用：${UPSTREAM_STATUS_COMPONENT_IDS.join(", ")}）`
      );
    }
    if (!/^\d+$/.test(value)) {
      throw new AppError(
        "CONFIG_ERROR",
        `BETTERSTACK_MONITOR_MAP 里 ${key} 的 monitor ID 必须是数字`
      );
    }
    map[key as UpstreamStatusComponentId] = value;
  }
  return map;
};

/** 是否存在显式注入的环境标记（四个来源任一非空）；全缺时消费方必须安全失败，不能静默按开发态跑。 */
export const hasExplicitDeploymentMarker = (): boolean => deploymentMarkerChain().some(Boolean);

export const readObservabilityEnv = (deploymentEnvironment: string): EnvObservability => {
  const resourceAttrs = parseOtelResourceAttributes(Bun.env.OTEL_RESOURCE_ATTRIBUTES);
  const sentryDsn = Bun.env.SENTRY_DSN;
  let sentryAllowedProjectIds = (Bun.env.SENTRY_ALLOWED_PROJECT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentryAllowedProjectIds.length === 0 && sentryDsn) {
    try {
      const projectId = new URL(sentryDsn).pathname.match(/^\/([0-9a-zA-Z_-]+)$/)?.[1];
      if (projectId) sentryAllowedProjectIds = [projectId];
    } catch {
      /* 非法 DSN 由 Sentry 初始化阶段处理 */
    }
  }

  const sentryApiToken = Bun.env.SENTRY_API_TOKEN?.trim() || undefined;
  if (sentryApiToken && !sentryDsn) {
    throw new AppError(
      "CONFIG_ERROR",
      "SENTRY_API_TOKEN 需要同时配置 SENTRY_DSN（从中读取组织与区域）"
    );
  }

  return {
    otelEndpoint: Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelHeaders: parseOtelHeaders(Bun.env.OTEL_EXPORTER_OTLP_HEADERS),
    otelServiceName:
      Bun.env.OTEL_SERVICE_NAME ?? resourceAttrs["service.name"] ?? "Bakagame-Server",
    otelServiceNamespace:
      Bun.env.OTEL_SERVICE_NAMESPACE ?? resourceAttrs["service.namespace"] ?? "Bakagame",
    otelDeploymentEnvironment: deploymentEnvironment,
    // 文档页默认只在非生产挂载：生产公开整张路由表等于把 admin 端点面与内网基址白送，
    // 契约产物另有 `ExportOpenapi.ts` 离线生成，不依赖线上文档。
    openapiEnabled:
      Bun.env.OPENAPI_ENABLED !== undefined
        ? Bun.env.OPENAPI_ENABLED === "true"
        : deploymentEnvironment !== "production",
    maintenanceToken: Bun.env.MAINTENANCE_TOKEN?.trim() || undefined,
    betterStackApiKey: Bun.env.BETTERSTACK_API_KEY?.trim() || undefined,
    betterStackMonitorMap: parseBetterStackMonitorMap(Bun.env.BETTERSTACK_MONITOR_MAP),
    statusFrontendUrl: Bun.env.STATUS_FRONTEND_URL?.trim() || undefined,
    sentryDsn,
    sentryApiToken,
    sentryAllowedProjectIds,
    sentryTracesSampleRate: parseSampleRate(Bun.env.SENTRY_TRACES_SAMPLE_RATE),
    logDirectory: (Bun.env.LOG_DIR ?? "").trim() || undefined,
    logOperations: Bun.env.LOG_OPERATIONS?.trim().toLowerCase() === "all" ? "all" : "errors",
    logConsoleColor: parseConsoleColor(Bun.env.LOG_CONSOLE_COLOR),
    logSlowOperationMs: parseSlowOperationMs(Bun.env.LOG_SLOW_OPERATION_MS),
    deploymentMarkerExplicit: hasExplicitDeploymentMarker(),
  };
};
