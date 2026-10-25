/** 公开状态页的归一化等级；未知不冒充正常或异常。 */
export type PublicStatusLevel = "operational" | "degraded" | "unknown";

/**
 * 可公开的健康组件白名单。新增组件必须先在这里登记：
 * 路由的 TypeBox 白名单与客户端解析器都按这份清单收口，不靠它泄露内部拓扑。
 */
export const PUBLIC_STATUS_COMPONENT_IDS = [
  "frontend",
  "backend",
  "bangumi",
  "qqmusic",
  "netease",
  "qq",
  "rooms",
  "search",
  "dataset",
  "images",
] as const;

export type PublicStatusComponentId = (typeof PUBLIC_STATUS_COMPONENT_IDS)[number];

/**
 * 由外部监测（Better Stack）逐个探测的上游接口：每个组件对应一个 monitor，
 * 映射关系由部署环境变量注入，不在这份清单里写死 monitor 标识。
 */
export const UPSTREAM_STATUS_COMPONENT_IDS = ["bangumi", "qqmusic", "netease", "qq"] as const;
export type UpstreamStatusComponentId = (typeof UPSTREAM_STATUS_COMPONENT_IDS)[number];

export const PUBLIC_STATUS_GROUP_IDS = ["platform", "upstream", "internal"] as const;
export type PublicStatusGroupId = (typeof PUBLIC_STATUS_GROUP_IDS)[number];

export interface PublicStatusGroup {
  id: PublicStatusGroupId;
  components: readonly PublicStatusComponentId[];
}

/**
 * 分组与成员的唯一真相：服务整体是对外可用性（前端、后端），
 * 上游接口按数据来源拆成四个各自独立探测的 API，本项目内部服务按能力拆开。
 * 页面按这里的顺序渲染。
 */
export const PUBLIC_STATUS_GROUPS: readonly PublicStatusGroup[] = [
  { id: "platform", components: ["frontend", "backend"] },
  { id: "upstream", components: UPSTREAM_STATUS_COMPONENT_IDS },
  { id: "internal", components: ["rooms", "search", "dataset", "images"] },
] as const;

export interface PublicStatusComponent {
  id: PublicStatusComponentId;
  level: PublicStatusLevel;
  /**
   * 当前平均响应耗时（毫秒）：只在上游接口组件上有值（来自外部监测），
   * 其余组件为 null，页面读作「—」而不是 0ms。
   */
  latencyMs: number | null;
}

/** `GET /api/status` 的响应：字段白名单，不含地址、路径、容器名或凭据。 */
export interface PublicStatusSnapshot {
  observedAt: number;
  level: PublicStatusLevel;
  /** 后端发布版本（与 changelog.json 的最大稳定版本同源）；取不到时为 `unknown`。 */
  version: string;
  components: PublicStatusComponent[];
}

/**
 * 历史格子的粒度是北京时间自然日，一天一格：30 天 × 10 个组件只有 300 行，
 * 探测再密也不会把表撑大，而「某一天是否可用」本来就是按天读的东西。
 */
export interface PublicStatusCell {
  /** `YYYY-MM-DD`，北京时间自然日。 */
  day: string;
  /** 当天探测次数；为 0 表示这一天没有样本。 */
  total: number;
  /** 当天正常探测占比，0–1；没有样本时为 null，页面读作「无数据」而不是 0%。 */
  ratio: number | null;
  /** 这一天整体读作什么：有降级即降级，全正常才正常，没有样本为未知。 */
  level: PublicStatusLevel;
}

/** 一个可用率窗口。窗口内没有样本时 `ratio` 为 null，页面不显示百分比。 */
export interface PublicStatusUptime {
  days: number;
  ratio: number | null;
}

export interface PublicStatusHistoryEntry {
  id: PublicStatusComponentId;
  uptime: PublicStatusUptime[];
  cells: PublicStatusCell[];
}

/** `GET /api/status/history` 的响应。 */
export interface PublicStatusHistory {
  days: number;
  generatedAt: number;
  entries: PublicStatusHistoryEntry[];
}

/**
 * 实时条带的格子：一个采样间隔一格。`latencyMs` 是这一格内带延迟读数的样本均值，
 * 没有任何延迟样本时为 null——内部组件没有延迟口径，不冒充 0ms。
 */
export interface PublicStatusSampleCell {
  /** 格子起点，UTC 毫秒，按采样间隔对齐。 */
  start: number;
  total: number;
  ratio: number | null;
  level: PublicStatusLevel;
  latencyMs: number | null;
}

export interface PublicStatusRealtimeEntry {
  id: PublicStatusComponentId;
  /** 实时窗口内的整体可用率；没有样本时为 null。 */
  uptime: number | null;
  cells: PublicStatusSampleCell[];
}

/** `GET /api/status/realtime` 的响应。 */
export interface PublicStatusRealtime {
  /** 采样间隔（毫秒）。 */
  intervalMs: number;
  /** 窗口长度（毫秒）。 */
  windowMs: number;
  generatedAt: number;
  entries: PublicStatusRealtimeEntry[];
}

/** 可用率窗口档位。 */
export const PUBLIC_STATUS_UPTIME_DAYS = [30] as const;

/** 历史条带覆盖的天数，取最大窗口；同时决定表里保留多久的行。 */
export const PUBLIC_STATUS_HISTORY_DAYS = 30;

/** 实时条带的采样间隔：与外部监测的检查频率一致，一格就是一次外部探测的节奏。 */
export const PUBLIC_STATUS_SAMPLE_INTERVAL_MS = 3 * 60_000;

/** 实时条带的窗口长度；页面据此渲染 120 格。 */
export const PUBLIC_STATUS_REALTIME_WINDOW_MS = 6 * 3_600_000;

/** 样本表保留时长：窗口之外再留一栏余量，够页面滚动补齐即可。 */
export const PUBLIC_STATUS_SAMPLE_RETENTION_MS = PUBLIC_STATUS_REALTIME_WINDOW_MS + 3_600_000;

// ==================== 状态事件（事件与维护） ====================

export const PUBLIC_STATUS_INCIDENT_KINDS = ["incident", "maintenance"] as const;
export type PublicStatusIncidentKind = (typeof PUBLIC_STATUS_INCIDENT_KINDS)[number];

/** 事件的处理进度；`resolved` 表示已恢复，其余都是进行中的各个阶段。 */
export const PUBLIC_STATUS_INCIDENT_STATUSES = [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
] as const;
export type PublicStatusIncidentStatus = (typeof PUBLIC_STATUS_INCIDENT_STATUSES)[number];

/** 维护窗口的生命周期：计划中 → 进行中 → 已完成。 */
export const PUBLIC_STATUS_MAINTENANCE_STATUSES = [
  "scheduled",
  "in_progress",
  "done",
] as const;
export type PublicStatusMaintenanceStatus = (typeof PUBLIC_STATUS_MAINTENANCE_STATUSES)[number];

export type PublicStatusEventStatus = PublicStatusIncidentStatus | PublicStatusMaintenanceStatus;

export const isPublicStatusEventStatus = (value: string): value is PublicStatusEventStatus =>
  (PUBLIC_STATUS_INCIDENT_STATUSES as readonly string[]).includes(value) ||
  (PUBLIC_STATUS_MAINTENANCE_STATUSES as readonly string[]).includes(value);

/**
 * 一条公开的状态事件：故障事件或维护窗口。`components` 是受影响的公开组件白名单，
 * 条带悬停与事件列表都按它关联；时间为 UTC 毫秒。
 */
export interface PublicStatusEvent {
  id: number;
  kind: PublicStatusIncidentKind;
  title: string;
  body: string;
  status: PublicStatusEventStatus;
  components: PublicStatusComponentId[];
  /** 事件开始 / 维护窗口开始（计划中的维护可以是未来时刻）。 */
  startedAt: number;
  /** 维护窗口的计划结束时刻；故障事件为 null。 */
  plannedEndAt: number | null;
  /** 实际恢复 / 完成时刻；进行中为 null。 */
  resolvedAt: number | null;
  updatedAt: number;
}

/** `GET /api/status/events` 的响应：进行中的在前，已结束的按开始时间倒序。 */
export interface PublicStatusEvents {
  generatedAt: number;
  events: PublicStatusEvent[];
}
