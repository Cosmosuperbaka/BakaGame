import { useSyncExternalStore } from "react";
import type { ServerMessage } from "@bakagame/shared";
import {
  removeSiteAgent,
  setSiteAgents,
  upsertSiteAgent,
  type SiteAgent,
} from "@/stores/UseSiteAgents";
import { resetPageControl, setPageControl } from "@/stores/UsePageControl";
import type { PageStateReport } from "@/lib/PageState";
import { createWebSocketClient } from "@/lib/WebsocketClient";

/**
 * 站点通道：**首页即连**的统一 ws 入口。
 *
 * 它只订阅 Agent 活动（哪款游戏、哪个房间、正在做什么），既不下发房间状态也不参与对局；
 * 三款游戏的通道仍各自按需建立，避免一款游戏换票重连把别的游戏的座位一起掐断。
 * 页面接管也走这条连接：配对码、指令与执行结果都只在页面对应的那条 socket 上。
 */
export const SITE_WS_PATH = "/api/ws";
export const siteWsClient = createWebSocketClient(SITE_WS_PATH);

const SITE_SUBSCRIBE_COMMAND = "site.subscribe";
const SITE_AGENTS_EVENT = "site.agents";
const SITE_AGENT_EVENT = "site.agent";
const SITE_AGENT_LEFT_EVENT = "site.agent.left";

const SITE_PAGE_OPEN_COMMAND = "site.page.open";
const SITE_PAGE_CLOSE_COMMAND = "site.page.close";
const SITE_PAGE_STATE_COMMAND = "site.page.state";
const SITE_PAGE_RESULT_COMMAND = "site.page.result";
const SITE_PAGE_COMMAND_EVENT = "site.page.command";
const SITE_PAGE_LEASE_EVENT = "site.page.lease";

/** 服务端下发给页面的指令；`page_act` 的两种动作。 */
export interface PageCommand {
  id: string;
  action: "navigate" | "click";
  path?: string;
  control?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const pageCommandHandlers = new Set<(command: PageCommand) => void>();

const toPageCommand = (payload: unknown): PageCommand | undefined => {
  if (!isRecord(payload)) return undefined;
  if (typeof payload.id !== "string") return undefined;
  if (payload.action !== "navigate" && payload.action !== "click") return undefined;
  return {
    id: payload.id,
    action: payload.action,
    ...(typeof payload.path === "string" ? { path: payload.path } : {}),
    ...(typeof payload.control === "string" ? { control: payload.control } : {}),
  };
};

const applySiteAgents = (payload: unknown): void => {
  const agents = isRecord(payload) && Array.isArray(payload.agents) ? payload.agents : [];
  setSiteAgents(agents as SiteAgent[]);
};

const applySiteAgentLeft = (payload: unknown): void => {
  if (isRecord(payload) && typeof payload.id === "string") removeSiteAgent(payload.id);
};

/** 认领与收回都由服务端说了算：页面只改写展示状态，不自行推断。 */
const applyPageLease = (payload: unknown): void => {
  if (!isRecord(payload)) return;
  if (payload.controlled !== true) {
    resetPageControl();
    return;
  }
  setPageControl({
    status: "controlled",
    ...(typeof payload.agentName === "string" ? { agentName: payload.agentName } : {}),
  });
};

const applyPageCommand = (payload: unknown): void => {
  const command = toPageCommand(payload);
  if (!command) return;
  for (const handler of [...pageCommandHandlers]) handler(command);
};

const applySiteMessage = (message: ServerMessage): void => {
  if (message.type !== "event") return;
  const payload = message.payload;
  switch (message.event) {
    case SITE_AGENTS_EVENT:
      applySiteAgents(payload);
      return;
    case SITE_AGENT_EVENT:
      if (isRecord(payload)) upsertSiteAgent(payload as unknown as SiteAgent);
      return;
    case SITE_AGENT_LEFT_EVENT:
      applySiteAgentLeft(payload);
      return;
    case SITE_PAGE_LEASE_EVENT:
      applyPageLease(payload);
      return;
    case SITE_PAGE_COMMAND_EVENT:
      applyPageCommand(payload);
      return;
    default:
      return;
  }
};

siteWsClient.onMessage(applySiteMessage);

/**
 * 站点连接的当前状态：设置面板的「连接信息」直接读它，不再自己挂一份状态监听。
 * 它表达的是**这条共享连接**是否打开，与游戏通道、房间是否允许 MCP 无关。
 */
let linkConnected = false;
const statusListeners = new Set<() => void>();

const subscribeStatus = (listener: () => void): (() => void) => {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
};

siteWsClient.onStatus((connected) => {
  linkConnected = connected;
  // 断线后页面上那条租约已经失效，指示与配对码都不能继续显示。
  if (!connected) resetPageControl();
  for (const listener of statusListeners) listener();
});

export function getSiteLinkConnected(): boolean {
  return linkConnected;
}

export function useSiteLinkConnected(): boolean {
  return useSyncExternalStore(subscribeStatus, getSiteLinkConnected, () => false);
}

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

/**
 * 站点连接与页面接管是两件事：接管被收回、配对码过期或页面断线，都只改接管的展示状态，
 * 不会主动断开这条共享连接（服务端按连接统计在线与订阅，断了首页指示也跟着消失）。
 */

/** 开启本页接管：服务端签发一次性配对码，页面自己展示给人类复制。 */
export async function openPageControl(): Promise<{ code: string; expiresAt: number } | undefined> {
  const ack = await siteWsClient.send<{ code?: unknown; expiresAt?: unknown }>(
    SITE_PAGE_OPEN_COMMAND,
    {}
  );
  if (typeof ack.code !== "string" || typeof ack.expiresAt !== "number") return undefined;
  setPageControl({ status: "open", code: ack.code, expiresAt: ack.expiresAt });
  return { code: ack.code, expiresAt: ack.expiresAt };
}

/** 收回本页接管：服务端作废租约与配对码，Agent 的下一次调用会失败。 */
export async function closePageControl(): Promise<void> {
  try {
    await siteWsClient.send(SITE_PAGE_CLOSE_COMMAND, {});
  } catch {
    // 连接已断：本地状态照样清掉，服务端在 close 回调里也会回收。
  }
  resetPageControl();
}

/** 上报页面当前可操作面；由页面宿主在路由变化与接管期间定期调用。 */
export function reportPageState(state: PageStateReport): void {
  void siteWsClient.send(SITE_PAGE_STATE_COMMAND, { ...state }).catch(() => undefined);
}

/** 回报一条指令的执行结果；失败原因只回给服务端与发起指令的那条 Agent 会话。 */
export function reportPageResult(result: { id: string; ok: boolean; error?: string }): void {
  void siteWsClient.send(SITE_PAGE_RESULT_COMMAND, { ...result }).catch(() => undefined);
}

/** 订阅服务端下发的页面指令；返回解绑函数。 */
export function onPageCommand(handler: (command: PageCommand) => void): () => void {
  pageCommandHandlers.add(handler);
  return () => {
    pageCommandHandlers.delete(handler);
  };
}
