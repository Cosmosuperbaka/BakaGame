/** 公开状态页的归一化等级；未知不冒充正常或异常。 */
export type PublicStatusLevel = "operational" | "degraded" | "unknown";

/** 可公开的健康组件白名单；顺序即页面展示顺序，新增组件必须先在这里登记。 */
export const PUBLIC_STATUS_COMPONENT_IDS = [
  "service",
  "search",
  "dataset",
  "images",
  "external",
] as const;

export type PublicStatusComponentId = (typeof PUBLIC_STATUS_COMPONENT_IDS)[number];

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
