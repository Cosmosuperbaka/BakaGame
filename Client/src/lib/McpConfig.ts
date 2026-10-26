/**
 * MCP 的前端常量：远程端点与游戏标识。
 * 接入凭证不在这里——房间用座位 `sessionToken`，首页用页面自己签发的一次性配对码。
 */
export const MCP_ENDPOINT_PATH = "/api/mcp";

/** 三个游戏在 MCP 设置里的统一标识。 */
export type McpGameId = "faker" | "song" | "cee";
