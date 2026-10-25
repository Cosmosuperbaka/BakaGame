import { useSyncExternalStore } from "react";

/** MCP 只有两个前端落点：远程端点与 Agent 发现文件；玩家侧说明由房间的 MCP 设置生成 Prompt。 */
export const MCP_ENDPOINT_PATH = "/api/mcp";

/** 三个游戏在 MCP 设置里的统一标识。 */
export type McpGameId = "faker" | "song" | "cee";

/**
 * 「允许 MCP 接入本会话」的落点：只影响本会话新建房间的 `allowAgents` 初值。
 * 已创建房间是否可用始终以服务端房间设置为准，由房主在房间的「MCP 设置」里决定。
 */
export const MCP_NEW_ROOM_STORAGE_KEY = "bakagame:mcp-new-room";

const listeners = new Set<() => void>();
let allowInNewRooms = false;
let initialized = false;

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  try {
    allowInNewRooms = window.localStorage.getItem(MCP_NEW_ROOM_STORAGE_KEY) === "1";
  } catch {
    allowInNewRooms = false;
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMcpNewRoomAllowed(): boolean {
  ensureInitialized();
  return allowInNewRooms;
}

export function setMcpNewRoomAllowed(next: boolean): void {
  allowInNewRooms = next;
  initialized = true;
  try {
    window.localStorage.setItem(MCP_NEW_ROOM_STORAGE_KEY, next ? "1" : "0");
  } catch {
    // 隐私模式写不进去：本次会话仍然生效。
  }
  emit();
}

export function useMcpNewRoomAllowed(): boolean {
  return useSyncExternalStore(subscribe, getMcpNewRoomAllowed, () => false);
}
