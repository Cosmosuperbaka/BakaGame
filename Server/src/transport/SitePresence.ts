import {
  SITE_AGENTS_EVENT,
  SITE_AGENT_EVENT,
  SITE_AGENT_LEFT_EVENT,
  type SiteAgentActivity,
  type SiteFocusPayload,
} from "../shared/AgentActivity";
import type { ServerMessage } from "../shared/Protocol";
import { createEvent } from "./Packets";

/**
 * 活动超过这个时长没有更新就视为 Agent 已经走了（关闭页面、进程退出、网络断开都可能
 * 来不及发 `site.leave`）。首页指示器据此自动消失，不需要一条清理定时器。
 */
export const SITE_ACTIVITY_TTL_MS = 120_000;

type Send = (payload: ServerMessage) => void;

/**
 * 站点级 Agent 活动：一条只读广播，给所有打开首页/大厅的访客看。
 *
 * 这里只保存**界面位置**（哪款游戏、哪个房间、哪个页面、在做什么），不保存搜索词、
 * 猜测或聊天草稿——房间内的控件级焦点仍走各游戏的 `mcp.focus`，只发给接管座位的人类。
 */
export class SitePresence {
  private readonly subscribers = new Map<string, Send>();
  private readonly activities = new Map<string, SiteAgentActivity>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** 订阅即回一份当前快照，避免新访客要等下一次动作才看到已有 Agent。 */
  subscribe(connectionId: string, send: Send): void {
    this.subscribers.set(connectionId, send);
    this.deliver(connectionId, createEvent(SITE_AGENTS_EVENT, { agents: this.snapshot() }));
  }

  unsubscribe(connectionId: string): void {
    this.subscribers.delete(connectionId);
    if (this.activities.delete(connectionId))
      this.broadcast(createEvent(SITE_AGENT_LEFT_EVENT, { id: connectionId }));
  }

  publish(connectionId: string, payload: SiteFocusPayload): SiteAgentActivity {
    this.prune();
    const activity: SiteAgentActivity = {
      ...payload,
      id: connectionId,
      at: this.now(),
    };
    this.activities.set(connectionId, activity);
    this.broadcast(createEvent(SITE_AGENT_EVENT, activity));
    return activity;
  }

  leave(connectionId: string): boolean {
    const existed = this.activities.delete(connectionId);
    if (existed) this.broadcast(createEvent(SITE_AGENT_LEFT_EVENT, { id: connectionId }));
    return existed;
  }

  snapshot(): SiteAgentActivity[] {
    this.prune();
    return [...this.activities.values()].sort((left, right) => left.at - right.at);
  }

  /** 只读订阅者的连接号集合；测试与停机广播用。 */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  private prune(): void {
    const deadline = this.now() - SITE_ACTIVITY_TTL_MS;
    for (const [id, activity] of this.activities)
      if (activity.at < deadline) this.activities.delete(id);
  }

  private broadcast(payload: ServerMessage): void {
    for (const [id, send] of this.subscribers) this.deliver(id, payload, send);
  }

  private deliver(id: string, payload: ServerMessage, send = this.subscribers.get(id)): void {
    if (!send) return;
    try {
      send(payload);
    } catch {
      /* 订阅者已断开：下一次 close 会把它摘掉 */
    }
  }
}
