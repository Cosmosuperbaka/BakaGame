import { useSyncExternalStore } from "react";
import type { ServerMessage, SitePageCommand, SitePageResult } from "@bakagame/shared";
import {
  PAGE_REATTACH_GRACE_MS,
  SITE_PAGE_ACTIONS,
  SITE_SESSION_PROBE_EVENT,
} from "@bakagame/shared/values";
import {
  removeSiteAgent,
  setSiteAgents,
  upsertSiteAgent,
  type SiteAgent,
} from "@/stores/UseSiteAgents";
import {
  getPageControl,
  resetPageControl,
  setAgentFocus,
  setPageControl,
  showPageNotice,
} from "@/stores/UsePageControl";
import { answerTabProbe, claimTabSession } from "@/lib/TabSession";
import { createWebSocketClient } from "@/lib/WebsocketClient";

/**
 * 站点通道：**任意页面一进入就建立**的统一 ws 入口，标签页身份由它领取。
 *
 * 它不下发房间状态也不参与对局。三款游戏的通道仍各自按需建立，只在首帧挂上同一份身份：
 * 游戏连接的开合就是座位在线与否，CEE 换票也要重新握手，并进这一条会让这些动作互相牵连。
 * 标签页接管也走这条连接：配对码、指令与执行结果都只在持有这份身份的那条 socket 上。
 */
export const SITE_WS_PATH = "/api/ws";
export const siteWsClient = createWebSocketClient(SITE_WS_PATH, { prelude: claimTabSession });

const SITE_SUBSCRIBE_COMMAND = "site.subscribe";
const SITE_AGENTS_EVENT = "site.agents";
const SITE_AGENT_EVENT = "site.agent";
const SITE_AGENT_LEFT_EVENT = "site.agent.left";

const SITE_PAGE_OPEN_COMMAND = "site.page.open";
const SITE_PAGE_CLOSE_COMMAND = "site.page.close";
const SITE_PAGE_RESULT_COMMAND = "site.page.result";
const SITE_PAGE_COMMAND_EVENT = "site.page.command";
const SITE_PAGE_LEASE_EVENT = "site.page.lease";

/** 重连后等服务端认回身份的上限：比服务端的等待窗口略长，两边不抢着下结论。 */
const REATTACH_GIVE_UP_MS = PAGE_REATTACH_GRACE_MS + 3_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const pageCommandHandlers = new Set<(command: SitePageCommand) => void>();

const toPageCommand = (payload: unknown): SitePageCommand | undefined => {
  if (!isRecord(payload) || typeof payload.id !== "string") return undefined;
  if (!SITE_PAGE_ACTIONS.includes(payload.action as SitePageCommand["action"])) return undefined;
  return payload as unknown as SitePageCommand;
};

const applySiteAgents = (payload: unknown): void => {
  const agents = isRecord(payload) && Array.isArray(payload.agents) ? payload.agents : [];
  setSiteAgents(agents as SiteAgent[]);
};

const applySiteAgentLeft = (payload: unknown): void => {
  if (isRecord(payload) && typeof payload.id === "string") removeSiteAgent(payload.id);
};

const END_NOTICES: Record<string, (agent: string) => string> = {
  released: (agent) => `${agent} 已交还控制`,
  agent_left: (agent) => `${agent} 已断开，页面已解锁`,
  expired: (agent) => `${agent} 长时间没有动作，已自动收回`,
};

/** 人类在断线期间点了收回：等连上后补发，否则重连会把锁定续回来。 */
let releaseOnReconnect = false;
let reattachTimer: ReturnType<typeof setTimeout> | undefined;

const clearReattachTimer = (): void => {
  clearTimeout(reattachTimer);
  reattachTimer = undefined;
};

/** 接管结束一律走这里：解锁，并告诉人类是谁、因为什么结束的。 */
const endPageControl = (text: (agent: string) => string): void => {
  const agent = getPageControl().agentName || "Agent";
  clearReattachTimer();
  resetPageControl();
  showPageNotice(text(agent));
};

/** 认领与结束都由服务端说了算：页面只改写展示状态，不自行推断。 */
const applyPageLease = (payload: unknown): void => {
  if (!isRecord(payload)) return;
  if (payload.controlled !== true) {
    const notice = typeof payload.reason === "string" ? END_NOTICES[payload.reason] : undefined;
    if (notice) endPageControl(notice);
    else resetPageControl();
    return;
  }
  clearReattachTimer();
  if (releaseOnReconnect) {
    releaseOnReconnect = false;
    void closePageControl();
    return;
  }
  setPageControl({
    status: "controlled",
    ...(typeof payload.agentName === "string" ? { agentName: payload.agentName } : {}),
  });
  if (typeof payload.focusControl === "string")
    setAgentFocus({ action: "focus", controlId: payload.focusControl });
};

const applyPageCommand = (payload: unknown): void => {
  const command = toPageCommand(payload);
  if (!command || getPageControl().status !== "controlled") return;
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
    case SITE_SESSION_PROBE_EVENT:
      if (isRecord(payload) && typeof payload.nonce === "string")
        answerTabProbe(payload.nonce, (type, body) =>
          siteWsClient.exchangeOnOpenSocket(type, body)
        );
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

/**
 * 配对码随连接作废，马上清掉；已接管的租约按身份记账，断线后继续锁定等它认回来，
 * 超时才算结束——连接抖一下不该让人类突然拿回一张 Agent 正在操作的页面。
 */
const holdLeaseWhileOffline = (): void => {
  const state = getPageControl();
  if (state.status !== "controlled") {
    resetPageControl();
    return;
  }
  setPageControl({ ...state, reconnecting: true });
  clearReattachTimer();
  reattachTimer = setTimeout(
    () => endPageControl(() => "连接中断，接管已结束"),
    REATTACH_GIVE_UP_MS
  );
};

siteWsClient.onStatus((connected) => {
  linkConnected = connected;
  if (!connected) holdLeaseWhileOffline();
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
    void siteWsClient
      .send<{ controlled?: unknown }>(SITE_SUBSCRIBE_COMMAND, {})
      .then((ack) => {
        if (ack.controlled === true) return;
        // 服务端已经没有这份租约：不必等到超时，当场解锁。
        releaseOnReconnect = false;
        if (getPageControl().status === "controlled") endPageControl(() => "连接中断，接管已结束");
      })
      .catch(() => undefined);
  });
  siteWsClient.connect();
  return unsubscribe;
}

/**
 * 站点连接与标签页接管是两件事：接管被收回、配对码过期或页面断线，都只改接管的展示状态，
 * 不会主动断开这条共享连接（服务端按连接统计在线与订阅，断了首页指示也跟着消失）。
 */

/** 开启接管：服务端签发一次性配对码，页面自己展示给人类复制。 */
export async function openPageControl(): Promise<{ code: string; expiresAt: number } | undefined> {
  const ack = await siteWsClient.send<{ code?: unknown; expiresAt?: unknown }>(
    SITE_PAGE_OPEN_COMMAND,
    {}
  );
  if (typeof ack.code !== "string" || typeof ack.expiresAt !== "number") return undefined;
  setPageControl({ status: "open", code: ack.code, expiresAt: ack.expiresAt });
  return { code: ack.code, expiresAt: ack.expiresAt };
}

/**
 * 人类收回控制：这是安全底线，本地立刻解锁，不等服务端回执。
 * 发送失败说明连接断了，记下来等重连后补发。
 */
export async function closePageControl(): Promise<void> {
  const wasControlled = getPageControl().status === "controlled";
  clearReattachTimer();
  resetPageControl();
  if (wasControlled) showPageNotice("已收回控制");
  try {
    await siteWsClient.send(SITE_PAGE_CLOSE_COMMAND, {});
  } catch {
    releaseOnReconnect = wasControlled;
  }
}

/** 回报一条指令的执行结果；结果只回给服务端与发起指令的那条 Agent 会话。 */
export function reportPageResult(result: SitePageResult): void {
  void siteWsClient.send(SITE_PAGE_RESULT_COMMAND, { ...result }).catch(() => undefined);
}

/** 订阅服务端下发的页面指令；返回解绑函数。 */
export function onPageCommand(handler: (command: SitePageCommand) => void): () => void {
  pageCommandHandlers.add(handler);
  return () => {
    pageCommandHandlers.delete(handler);
  };
}
