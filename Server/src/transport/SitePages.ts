import { randomBytes, randomUUID } from "node:crypto";
import {
  SITE_PAGE_COMMAND_EVENT,
  SITE_PAGE_LEASE_EVENT,
  type SitePageCommand,
  type SitePageResult,
  type SitePageState,
} from "../shared/AgentActivity";
import type { ServerMessage } from "../shared/Protocol";
import { findSitePage } from "../mcp/SiteMap";
import { AppError } from "../domain/Errors";
import { createEvent } from "./Packets";

/**
 * 配对码有效期：只够人类复制给 Agent 再用一次。
 * 页面刷新、关闭或断线都会换一枚新码——凭据从不落盘，也不跨连接复用。
 */
export const PAGE_CODE_TTL_MS = 5 * 60_000;

/** 一台机器上同时开着的可接管页面数量上限，防止匿名连接把注册表撑爆。 */
const MAX_PAGES = 128;

/** 去掉容易看错的 0/O、1/I/L，人类要能把它念给 Agent 或手抄。 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

type Send = (payload: ServerMessage) => void;

const fail = (code: string, message: string): AppError => new AppError(code, message);

/** 房间页允许导航：`/<game>/room/<roomId>`，房间号沿用三款游戏的既有形状。 */
const ROOM_PATH = /^\/(?:whoisfaker|songuessr|cee)\/room\/[A-Za-z0-9_-]{2,32}$/;

export const isPagePathAllowed = (path: string): boolean => {
  const normalized = path.split("?")[0]?.replace(/\/+$/, "") || "/";
  return Boolean(findSitePage(normalized)) || ROOM_PATH.test(normalized);
};

interface PageRecord {
  pageId: string;
  connectionId: string;
  send: Send;
  state: SitePageState;
  openedAt: number;
  /** 未认领时的配对码；认领后清空，凭据只能用一次。 */
  code?: string;
  codeExpiresAt?: number;
  controllerId?: string;
  agentName?: string;
  lastResult?: SitePageResult;
  commandSeq: number;
}

export interface PageLease {
  pageId: string;
  agentName: string;
  state: SitePageState;
}

export interface PageView extends PageLease {
  lastResult?: SitePageResult;
}

const makeCode = (): string => {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
};

/**
 * 站点级页面接管租约，只存在于进程内存。
 *
 * 与房间座位接管的区别：座位接管绑定的是「某个玩家座位」，页面接管绑定的是「某条浏览器连接」。
 * 页面本身就是凭据的持有者——它把配对码交给谁，谁才能驱动它；服务端只负责核对一次性配对码，
 * 并保证指令只发给那一条连接。
 */
export class SitePages {
  private readonly byPageId = new Map<string, PageRecord>();
  private readonly byConnection = new Map<string, PageRecord>();
  private readonly byController = new Map<string, PageRecord>();
  private readonly byCode = new Map<string, PageRecord>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** 页面开启接管：已开启时换发新码（旧的立即失效），已认领时拒绝。 */
  open(connectionId: string, send: Send): { pageId: string; code: string; expiresAt: number } {
    const existing = this.byConnection.get(connectionId);
    if (existing?.controllerId)
      throw fail("PAGE_ALREADY_CONTROLLED", "本页面已被 Agent 接管，请先收回");
    if (existing) return this.issueCode(existing);
    if (this.byPageId.size >= MAX_PAGES) this.evictOldest();
    const record: PageRecord = {
      pageId: randomUUID(),
      connectionId,
      send,
      state: { path: "/", title: "", controls: [] },
      openedAt: this.now(),
      commandSeq: 0,
    };
    this.byPageId.set(record.pageId, record);
    this.byConnection.set(connectionId, record);
    return this.issueCode(record);
  }

  /** 页面收回（或断线）：租约与配对码一起作废，Agent 的下一次调用会得到 PAGE_NOT_FOUND。 */
  close(connectionId: string): boolean {
    const record = this.byConnection.get(connectionId);
    if (!record) return false;
    this.forget(record);
    return true;
  }

  closeByController(controllerId: string): boolean {
    const record = this.byController.get(controllerId);
    if (!record) return false;
    this.forget(record);
    this.notifyLease(record, false);
    return true;
  }

  /** 页面回报自身可操作面；路径变化后 Agent 据此重新决策。 */
  updateState(connectionId: string, state: SitePageState): boolean {
    const record = this.byConnection.get(connectionId);
    if (!record) return false;
    record.state = state;
    return true;
  }

  recordResult(connectionId: string, result: SitePageResult): boolean {
    const record = this.byConnection.get(connectionId);
    if (!record) return false;
    record.lastResult = result;
    return true;
  }

  /** Agent 用配对码认领：一次有效，认领后码立即作废。 */
  claim(code: string, controllerId: string, agentName: string): PageLease {
    this.pruneCodes();
    const record = this.byCode.get(code.trim().toUpperCase());
    if (!record?.code) throw fail("PAGE_CODE_INVALID", "配对码无效或已使用");
    if (record.controllerId && record.controllerId !== controllerId)
      throw fail("PAGE_TAKEN", "该页面已被另一个 Agent 会话接管");
    record.controllerId = controllerId;
    record.agentName = agentName;
    this.byCode.delete(record.code);
    delete record.code;
    delete record.codeExpiresAt;
    this.byController.set(controllerId, record);
    this.notifyLease(record, true);
    return { pageId: record.pageId, agentName, state: record.state };
  }

  viewFor(controllerId: string): PageView | undefined {
    const record = this.byController.get(controllerId);
    if (!record) return undefined;
    return {
      pageId: record.pageId,
      agentName: record.agentName ?? "",
      state: record.state,
      ...(record.lastResult ? { lastResult: record.lastResult } : {}),
    };
  }

  /** 下发一条指令；目标不在页面当前上报的控件里就直接拒绝，不做盲点。 */
  dispatch(
    controllerId: string,
    action: "navigate" | "click",
    target: { path?: string; control?: string }
  ): SitePageCommand {
    const record = this.byController.get(controllerId);
    if (!record) throw fail("PAGE_NOT_CONTROLLED", "尚未接管任何页面，先调 control_page");
    if (action === "navigate") {
      if (!target.path) throw fail("INVALID_ARGUMENT", "navigate 需要 path");
      if (!isPagePathAllowed(target.path))
        throw fail("PAGE_NOT_REACHABLE", `不在人类可达位置内：${target.path}`);
    } else {
      if (!target.control) throw fail("INVALID_ARGUMENT", "click 需要 control");
      const ids = new Set(record.state.controls.map((control) => control.id));
      if (!ids.has(target.control))
        throw fail("CONTROL_NOT_FOUND", `当前页面没有可点控件：${target.control}`);
    }
    const command: SitePageCommand = {
      id: `page-${++record.commandSeq}-${record.pageId.slice(0, 8)}`,
      action,
      ...(target.path ? { path: target.path } : {}),
      ...(target.control ? { control: target.control } : {}),
    };
    record.lastResult = undefined;
    this.notify(record, createEvent(SITE_PAGE_COMMAND_EVENT, command));
    return command;
  }

  /** 页面断开时连带清掉租约与配对码。 */
  dropConnection(connectionId: string): void {
    const record = this.byConnection.get(connectionId);
    if (record) this.forget(record);
  }

  get size(): number {
    return this.byPageId.size;
  }

  private issueCode(record: PageRecord): { pageId: string; code: string; expiresAt: number } {
    this.forgetCode(record);
    let code = makeCode();
    while (this.byCode.has(code)) code = makeCode();
    const expiresAt = this.now() + PAGE_CODE_TTL_MS;
    record.code = code;
    record.codeExpiresAt = expiresAt;
    this.byCode.set(code, record);
    return { pageId: record.pageId, code, expiresAt };
  }

  private forget(record: PageRecord): void {
    this.forgetCode(record);
    this.byPageId.delete(record.pageId);
    this.byConnection.delete(record.connectionId);
    if (record.controllerId) this.byController.delete(record.controllerId);
  }

  private forgetCode(record: PageRecord): void {
    if (record.code) this.byCode.delete(record.code);
    delete record.code;
    delete record.codeExpiresAt;
  }

  private notifyLease(record: PageRecord, controlled: boolean): void {
    this.notify(
      record,
      createEvent(SITE_PAGE_LEASE_EVENT, {
        controlled,
        ...(controlled && record.agentName ? { agentName: record.agentName } : {}),
      })
    );
  }

  private notify(record: PageRecord, payload: ServerMessage): void {
    try {
      record.send(payload);
    } catch {
      // 页面已经断开：由传输层的 close 回调负责清理，这里不重复处理。
    }
  }

  /** 惰性清理过期码：没有定时器，任何一次读写顺手带走。 */
  private pruneCodes(): void {
    const now = this.now();
    for (const [code, record] of this.byCode)
      if ((record.codeExpiresAt ?? 0) <= now) {
        this.byCode.delete(code);
        delete record.code;
        delete record.codeExpiresAt;
      }
  }

  private evictOldest(): void {
    const oldest = [...this.byPageId.values()].sort(
      (left, right) => left.openedAt - right.openedAt
    )[0];
    if (oldest) this.forget(oldest);
  }
}
