import { SITE_ORIGIN } from "@/data/PageMeta";
import { isBakaClient } from "@/lib/BakaChannel";

import type { GameId } from "@bakagame/shared";
/**
 * MCP 的前端常量：远程端点与游戏标识。
 * 接入凭证不在这里：标签页接管用页面自己签发的一次性配对码。
 */
export const MCP_ENDPOINT_PATH = "/api/mcp";

/** 三个游戏在 MCP 设置里的统一标识。 */
export type McpGameId = GameId;

/** 站点根地址：壳内的页面 origin 是本地资源地址，外部 Agent 不可达，必须写公开站点。 */
export const mcpSiteOrigin = (): string => {
  if (typeof window === "undefined") return SITE_ORIGIN;
  return isBakaClient() ? SITE_ORIGIN : window.location.origin;
};

/** 复制给 Agent 的公开端点。 */
export const mcpEndpoint = (): string => `${mcpSiteOrigin()}${MCP_ENDPOINT_PATH}`;
