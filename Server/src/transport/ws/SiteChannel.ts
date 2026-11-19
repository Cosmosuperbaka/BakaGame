import { Value } from "@sinclair/typebox/value";

import { AppError } from "../../domain/Errors";
import {
  SITE_FOCUS_COMMAND,
  SITE_LEAVE_COMMAND,
  SITE_PAGE_CLOSE_COMMAND,
  SITE_PAGE_COMMAND_SET,
  SITE_PAGE_OPEN_COMMAND,
  SITE_PAGE_RESULT_COMMAND,
  SITE_SUBSCRIBE_COMMAND,
  SITE_SUBSCRIBE_COMMAND_SET,
  SiteFocusPayloadSchema,
  SitePageResultSchema,
  type SitePageResult,
} from "../../shared/AgentActivity";
import { isRecord } from "../../shared/Json";
import {
  SITE_SESSION_ALIVE_COMMAND,
  SITE_SESSION_ATTACH_COMMAND,
  SITE_SESSION_CLAIM_COMMAND,
  SITE_SESSION_PROBE_EVENT,
  TabSessionAliveSchema,
  TabSessionAttachSchema,
  TabSessionClaimSchema,
} from "../../shared/TabSession";
import { createAck, createEvent } from "../Packets";
import type { SitePages } from "../SitePages";
import type { SitePresence } from "../SitePresence";
import { tabKeyOf, type TabSessions } from "../TabSessions";
import { connectionIdFor, sendPacket, type GameSocketLike } from "./ConnectionRecord";

export interface SiteChannelDependencies {
  sitePresence: SitePresence;
  sitePages: SitePages;
  tabSessions: TabSessions;
}

/**
 * 站点通道：订阅、标签页接管、标签页身份。这些命令由统一入口直接处理，不进任何游戏服务。
 * 三个子系统的实例归应用实例，这里只持有引用。
 */
export const createSiteChannel = ({
  sitePresence,
  sitePages,
  tabSessions,
}: SiteChannelDependencies) => {
  /**
   * 标签页接管的人类侧命令：开/关租约、回报指令结果。
   *
   * 谁都能开自己的页面，但只有拿到一次性配对码的 Agent 能驱动它 —— 配对码只在这里换发，
   * 租约按站点连接领到的标签页身份记账，结果只认持有这份身份的连接，这些命令都不进任何游戏服务。
   * 未绑定身份的旧页面退回按连接记账，刷新后不续接。
   */
  const handleSitePageCommand = (
    ws: GameSocketLike,
    type: string,
    message: Record<string, unknown>,
    connectionId: string,
    envelope: { id: string; type: string; traceId?: string }
  ): void => {
    const data = ws.data as { isAgent?: boolean; tabKey?: string };
    if (data.isAgent === true) throw new AppError("PAGE_FORBIDDEN", "Agent 连接不能开启接管");
    if (type === SITE_PAGE_OPEN_COMMAND) {
      sendPacket(
        ws,
        createAck(
          envelope,
          sitePages.open(data.tabKey ?? `connection:${connectionId}`, connectionId, (payload) =>
            sendPacket(ws, payload)
          )
        )
      );
      return;
    }
    if (type === SITE_PAGE_CLOSE_COMMAND) {
      sendPacket(ws, createAck(envelope, { closed: sitePages.close(connectionId) }));
      return;
    }
    if (!isRecord(message.payload))
      throw new AppError("INVALID_MESSAGE", "消息载荷 payload 必须为对象");
    if (type !== SITE_PAGE_RESULT_COMMAND)
      throw new AppError("UNKNOWN_MESSAGE_TYPE", `未知的页面命令：${type}`);
    if (!Value.Check(SitePageResultSchema, message.payload))
      throw new AppError("INVALID_MESSAGE", "指令结果不合法");
    sitePages.recordResult(connectionId, message.payload as SitePageResult);
    sendPacket(ws, createAck(envelope, { ok: true }));
  };

  /**
   * 标签页身份命令：站点连接领取、游戏连接挂上、持有者应答探测。
   *
   * 身份在首帧确定，之后这条连接上的席位都归它，所以一条连接只绑定一次：连接中途改绑，
   * 等于让已入座的连接换了主人。Agent 不持有标签页身份：放它绑定等于让它
   * 直接拿到人类的座位，绕开页面配对。
   */
  const handleTabSessionCommand = async (
    ws: GameSocketLike,
    message: Record<string, unknown>
  ): Promise<boolean> => {
    const type = message.type as string;
    if (
      type !== SITE_SESSION_CLAIM_COMMAND &&
      type !== SITE_SESSION_ATTACH_COMMAND &&
      type !== SITE_SESSION_ALIVE_COMMAND
    )
      return false;
    const data = ws.data as { isAgent?: boolean; tabKey?: string; socketClosed?: boolean };
    if (data.isAgent === true)
      throw new AppError("TAB_SESSION_FORBIDDEN", "Agent 连接不持有标签页身份");
    const envelope = message as { id: string; type: string; traceId?: string };
    const connectionId = connectionIdFor(ws);
    if (type === SITE_SESSION_ALIVE_COMMAND) {
      if (!Value.Check(TabSessionAliveSchema, message.payload))
        throw new AppError("INVALID_MESSAGE", "探测应答不合法");
      tabSessions.confirmAlive(connectionId, message.payload.nonce);
      sendPacket(ws, createAck(envelope, { ok: true }));
      return true;
    }
    if (data.tabKey) throw new AppError("TAB_SESSION_BOUND", "本连接已绑定标签页身份");
    if (type === SITE_SESSION_ATTACH_COMMAND) {
      if (!Value.Check(TabSessionAttachSchema, message.payload))
        throw new AppError("INVALID_MESSAGE", "标签页身份不合法");
      data.tabKey = tabKeyOf(message.payload.token);
      sendPacket(ws, createAck(envelope, { attached: true, serverEpoch: tabSessions.serverEpoch }));
      return true;
    }
    if (!Value.Check(TabSessionClaimSchema, message.payload))
      throw new AppError("INVALID_MESSAGE", "标签页身份不合法");
    const { key, ...claim } = await tabSessions.claim(
      connectionId,
      message.payload.token,
      (nonce) => {
        sendPacket(ws, createEvent(SITE_SESSION_PROBE_EVENT, { nonce }));
      }
    );
    // 探测要跨一次等待：这期间连接可能已断，不能把死连接登记成持有者。
    if (data.socketClosed) {
      tabSessions.release(connectionId);
      return true;
    }
    data.tabKey = key;
    sendPacket(ws, createAck(envelope, claim));
    return true;
  };

  /** 站点通道：订阅、标签页接管、焦点上报、离开。这些命令由统一入口直接处理，不进任何游戏服务。 */
  const handleSiteCommand = (ws: GameSocketLike, message: Record<string, unknown>): boolean => {
    const type = message.type as string;
    const isPageCommand = SITE_PAGE_COMMAND_SET.has(type);
    if (!SITE_SUBSCRIBE_COMMAND_SET.has(type) && !isPageCommand) return false;
    const connectionId = connectionIdFor(ws);
    const envelope = message as { id: string; type: string; traceId?: string };
    if (isPageCommand) {
      handleSitePageCommand(ws, type, message, connectionId, envelope);
      return true;
    }
    if (type === SITE_SUBSCRIBE_COMMAND) {
      sitePresence.subscribe(connectionId, (payload) => sendPacket(ws, payload));
      // 订阅是页面连上后的第一条业务命令：身份已经绑定，刷新前的接管在这里续上。
      // 回执带上结果：页面据此判断断线期间接管是否已经结束，不必等到超时。
      const { tabKey } = ws.data as { tabKey?: string };
      const controlled =
        tabKey !== undefined &&
        sitePages.attach(tabKey, connectionId, (payload) => sendPacket(ws, payload));
      sendPacket(ws, createAck(envelope, { subscribed: true, controlled }));
      return true;
    }
    if ((ws.data as { isAgent?: boolean }).isAgent !== true)
      throw new AppError("AGENT_REQUIRED", "只有 Agent 连接可以上报站点活动");
    if (!isRecord(message.payload))
      throw new AppError("INVALID_MESSAGE", "消息载荷 payload 必须为对象");
    // 封闭 schema：房间内的控件焦点与逐字输入进度带不进来，首页广播只含界面位置。
    if (!Value.Check(SiteFocusPayloadSchema, message.payload))
      throw new AppError("INVALID_MESSAGE", "站点活动参数不合法");
    if (type === SITE_FOCUS_COMMAND)
      sitePresence.publish(connectionId, message.payload as Parameters<SitePresence["publish"]>[1]);
    else if (type === SITE_LEAVE_COMMAND) sitePresence.leave(connectionId);
    sendPacket(ws, createAck(envelope, { ok: true }));
    return true;
  };

  return { handleTabSessionCommand, handleSiteCommand };
};
