/** 公开状态页的归一化等级；未知不冒充正常或异常。 */
export type PublicStatusLevel = "operational" | "degraded" | "unknown";

/**
 * 可公开的健康组件白名单。新增组件必须先在这里登记：
 * 路由的 TypeBox 白名单与客户端解析器都按这份清单收口，不靠它泄露内部拓扑。
 */
export const PUBLIC_STATUS_COMPONENT_IDS = [
  "frontend",
  "backend",
  "upstream",
  "rooms",
  "search",
  "dataset",
  "images",
] as const;

export type PublicStatusComponentId = (typeof PUBLIC_STATUS_COMPONENT_IDS)[number];

export const PUBLIC_STATUS_GROUP_IDS = ["platform", "internal"] as const;
export type PublicStatusGroupId = (typeof PUBLIC_STATUS_GROUP_IDS)[number];

export interface PublicStatusGroup {
  id: PublicStatusGroupId;
  components: readonly PublicStatusComponentId[];
}

/**
 * 分组与成员的唯一真相：服务整体是对外可用性（前端、后端、上游监测），
 * 本项目内部服务按能力拆开（房间、搜索、番剧数据、图片缓存）。页面按这里的顺序渲染。
 */
export const PUBLIC_STATUS_GROUPS: readonly PublicStatusGroup[] = [
  { id: "platform", components: ["frontend", "backend", "upstream"] },
  { id: "internal", components: ["rooms", "search", "dataset", "images"] },
] as const;

export interface PublicStatusComponent {
  id: PublicStatusComponentId;
  level: PublicStatusLevel;
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
 * 历史格子的粒度是北京时间自然日，一天一格：90 天 × 7 个组件只有 630 行，
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

/** 可用率窗口档位。 */
export const PUBLIC_STATUS_UPTIME_DAYS = [7, 30, 90] as const;

/** 历史条带覆盖的天数，取最大窗口；同时决定表里保留多久的行。 */
export const PUBLIC_STATUS_HISTORY_DAYS = 90;
