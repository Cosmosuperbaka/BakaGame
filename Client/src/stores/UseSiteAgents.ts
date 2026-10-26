import { useSyncExternalStore } from "react";
import type { SiteAgentActivity } from "@bakagame/shared";

/**
 * 首页的 Agent 活动：只来自站点的公开只读通道（`site.*`），
 * 内容限定为「在哪一页、做什么」，不含搜索词、猜测与聊天草稿。
 *
 * 服务端也会按 TTL 清理；这里的本地计时只负责在长连接静默丢帧时把过期条目收掉。
 */
export type SiteAgent = SiteAgentActivity;

/** 略大于服务端 TTL：让服务端的权威清理先发生，客户端只在漏帧时兜底。 */
const CLIENT_TTL_MS = 125_000;

let agents: readonly SiteAgent[] = [];
const listeners = new Set<() => void>();
const expiry = new Map<string, ReturnType<typeof setTimeout>>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

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
  agents = [...next];
  emit();
}

export function upsertSiteAgent(agent: SiteAgent): void {
  agents = [...agents.filter((entry) => entry.id !== agent.id), agent];
  scheduleExpiry(agent.id);
  emit();
}

export function removeSiteAgent(id: string): void {
  clearExpiry(id);
  const next = agents.filter((entry) => entry.id !== id);
  if (next.length === agents.length) return;
  agents = next;
  emit();
}

export const getSiteAgents = (): readonly SiteAgent[] => agents;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** 测试与退出时清空：模块级状态不能跨用例泄漏。 */
export function resetSiteAgents(): void {
  for (const id of [...expiry.keys()]) clearExpiry(id);
  agents = [];
  emit();
}

export function useSiteAgents(): readonly SiteAgent[] {
  return useSyncExternalStore(subscribe, getSiteAgents, () => [] as const);
}
