/**
 * 客户端（玩家页面与 MCP）在同一房间内保留的聊天条数。服务端快照只带最近一段，
 * 客户端按 id 去重续接、按时间排序后截取窗口——这份口径两端只能有一份实现。
 */
export const CLIENT_CHAT_WINDOW = 200;

export interface ChatWindowEntry {
  id: string;
  createdAt: number;
}

/** 后到的同 id 条目覆盖先到的（撤回、改写以服务端最新为准），结果按时间升序、只留最近 `limit` 条。 */
export const mergeChatWindow = <T extends ChatWindowEntry>(
  existing: readonly T[] = [],
  incoming: readonly T[] = [],
  limit = CLIENT_CHAT_WINDOW
): T[] => {
  const byId = new Map<string, T>();
  for (const entry of existing) byId.set(entry.id, entry);
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-limit);
};
