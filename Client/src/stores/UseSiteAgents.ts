import type { SiteAgentActivity } from "@bakagame/shared";
import { createExternalStore } from "@/lib/ExternalStore";

/**
 * 首页的 Agent 活动：只来自站点的公开只读通道（`site.*`），
 * 内容限定为「在哪一页、做什么」，不含搜索词、猜测与聊天草稿。
 *
 * 服务端也会按 TTL 清理；这里的本地计时只负责在长连接静默丢帧时把过期条目收掉。
 */
export type SiteAgent = SiteAgentActivity;

/** 略大于服务端 TTL：让服务端的权威清理先发生，客户端只在漏帧时兜底。 */
const CLIENT_TTL_MS = 125_000;

const agents = createExternalStore<readonly SiteAgent[]>([]);
const expiry = new Map<string, ReturnType<typeof setTimeout>>();

const scheduleExpiry = (id: string): void => {
  const running = expiry.get(id);
  if (running !== undefined) clearTimeout(running);
  expiry.set(
    id,
    setTimeout(() => {
      removeSiteAgent(id);
    }, CLIENT_TTL_MS)
  );
};

const clearExpiry = (id: string): void => {
  const running = expiry.get(id);
  if (running !== undefined) clearTimeout(running);
  expiry.delete(id);
};

export function setSiteAgents(next: readonly SiteAgent[]): void {
  const keep = new Set(next.map((agent) => agent.id));
  for (const id of expiry.keys()) if (!keep.has(id)) clearExpiry(id);
  for (const agent of next) scheduleExpiry(agent.id);
  agents.set([...next]);
}

export function upsertSiteAgent(agent: SiteAgent): void {
  agents.write([...agents.get().filter((entry) => entry.id !== agent.id), agent]);
  scheduleExpiry(agent.id);
  agents.emit();
}

export function removeSiteAgent(id: string): void {
  clearExpiry(id);
  const current = agents.get();
  const next = current.filter((entry) => entry.id !== id);
  if (next.length === current.length) return;
  agents.set(next);
}

export const getSiteAgents = agents.get;

/** 测试与退出时清空：模块级状态不能跨用例泄漏。 */
export function resetSiteAgents(): void {
  for (const id of [...expiry.keys()]) clearExpiry(id);
  agents.set([]);
}

export const useSiteAgents = agents.use;
