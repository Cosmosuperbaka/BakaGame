import type { ServerMessage } from "@bakagame/shared";
import {
  removeSiteAgent,
  setSiteAgents,
  upsertSiteAgent,
  type SiteAgent,
} from "@/stores/UseSiteAgents";
import { createWebSocketClient } from "@/lib/WebsocketClient";

/**
 * 站点通道：**首页即连**的统一 ws 入口。
 *
 * 它只订阅 Agent 活动（哪款游戏、哪个房间、正在做什么），既不下发房间状态也不参与对局；
 * 三款游戏的通道仍各自按需建立，避免一款游戏换票重连把别的游戏的座位一起掐断。
 */
export const SITE_WS_PATH = "/api/ws";
export const siteWsClient = createWebSocketClient(SITE_WS_PATH);

const SITE_SUBSCRIBE_COMMAND = "site.subscribe";
const SITE_AGENTS_EVENT = "site.agents";
const SITE_AGENT_EVENT = "site.agent";
const SITE_AGENT_LEFT_EVENT = "site.agent.left";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const applySiteMessage = (message: ServerMessage): void => {
  if (message.type !== "event") return;
  const payload = message.payload;
  if (message.event === SITE_AGENTS_EVENT) {
    const agents = isRecord(payload) && Array.isArray(payload.agents) ? payload.agents : [];
    setSiteAgents(agents as SiteAgent[]);
    return;
  }
  if (message.event === SITE_AGENT_EVENT && isRecord(payload)) {
    upsertSiteAgent(payload as unknown as SiteAgent);
    return;
  }
  if (message.event === SITE_AGENT_LEFT_EVENT && isRecord(payload)) {
    if (typeof payload.id === "string") removeSiteAgent(payload.id);
  }
};

siteWsClient.onMessage(applySiteMessage);

/**
 * 建立站点连接并订阅。返回解绑函数（只摘掉本次登记的状态监听，不关共享连接）。
 * 重连后必须重新订阅：服务端把订阅记在这条连接上，断开即失效。
 */
export function connectSiteSocket(): () => void {
  const unsubscribe = siteWsClient.onStatus((connected) => {
    if (!connected) return;
    void siteWsClient.send(SITE_SUBSCRIBE_COMMAND, {}).catch(() => undefined);
  });
  siteWsClient.connect();
  return unsubscribe;
}
