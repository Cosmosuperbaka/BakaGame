import { useSyncExternalStore } from "react";

/**
 * MCP 的两个前端落点：**站点连接**（首页即连的统一实时入口）与远程端点；
 * 房间内的接入 Prompt 由房间的「MCP 设置」生成。
 */
export const MCP_ENDPOINT_PATH = "/api/mcp";

/** 三个游戏在 MCP 设置里的统一标识。 */
export type McpGameId = "faker" | "song" | "cee";

/**
 * 「开启首页连接」的落点：只决定**站点级**实时连接要不要建立。
 *
 * 开启时根布局在首页就建 `/api/ws` 并订阅 `site.*`，Agent 的位置与动作才看得见；
 * 关闭时既不建连也不订阅（收不到、也不展示 Agent 活动），游戏内的三款通道不受影响。
 * 未写过这个键时按开启处理：统一入口上线后首页本就一直连着，升级不该把功能关掉。
 */
export const MCP_LINK_STORAGE_KEY = "bakagame:mcp-link";

const listeners = new Set<() => void>();
let linkEnabled = true;
let initialized = false;

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  try {
    const stored = window.localStorage.getItem(MCP_LINK_STORAGE_KEY);
    // 缺省开启：只有玩家明确关掉过才不建连。
    if (stored !== null) linkEnabled = stored === "1";
  } catch {
    linkEnabled = true;
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMcpLinkEnabled(): boolean {
  ensureInitialized();
  return linkEnabled;
}

export function setMcpLinkEnabled(next: boolean): void {
  linkEnabled = next;
  initialized = true;
  try {
    window.localStorage.setItem(MCP_LINK_STORAGE_KEY, next ? "1" : "0");
  } catch {
    // 隐私模式写不进去：本次会话仍然生效。
  }
  emit();
}

export function useMcpLinkEnabled(): boolean {
  return useSyncExternalStore(subscribe, getMcpLinkEnabled, () => true);
}
