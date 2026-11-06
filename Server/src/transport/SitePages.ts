import { randomBytes, randomUUID } from "node:crypto";
import {
  SITE_PAGE_COMMAND_EVENT,
  SITE_PAGE_LEASE_EVENT,
  type SitePageCommand,
  type SitePageLease,
  type SitePageResult,
  type SitePageStep,
  type SitePageView,
} from "../shared/AgentActivity";
import {
  isAgentPagePath,
  PAGE_REATTACH_GRACE_MS,
  SITE_PAGE_KEYS,
  SITE_PAGE_SCROLLS,
  type SitePageEndReason,
} from "../shared/AgentPages";
import type { ServerMessage } from "../shared/Protocol";
import { AppError } from "../domain/Errors";
import { createEvent } from "./Packets";

/** 配对码有效期：只够人类复制给 Agent 再用一次，未认领时页面刷新也会作废。 */
export const PAGE_CODE_TTL_MS = 5 * 60_000;

/**
 * Agent 多久没有任何动作就视为已离开。远程 MCP 是无状态 HTTP，Agent 进程挂掉时服务端收不到任何信号，
 * 没有这条上限，被接管的标签页要等人类发现才会解锁。
 */
export const PAGE_LEASE_IDLE_MS = 3 * 60_000;

/** 页面执行一步的上限：逐字输入与等待滚动都算在内，超时按页面失联处理。 */
export const PAGE_COMMAND_TIMEOUT_MS = 20_000;

/** 单步文本上限：与聊天、描述等界面输入的量级一致，不让一步操作占住页面太久。 */
const MAX_STEP_TEXT = 400;

/** 同时开着的可接管页面数量上限，防止匿名连接把注册表撑爆。 */
const MAX_PAGES = 128;

/** 去掉容易看错的 0/O、1/I/L，人类要能把它念给 Agent 或手抄。 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

const CONTROL_ID = /^[A-Za-z0-9_.:-]{1,96}$/;

type Send = (payload: ServerMessage) => void;

const fail = (code: string, message: string): AppError => new AppError(code, message);

interface PendingCommand {
  resolve: (result: SitePageResult) => void;
  reject: (reason: AppError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PageRecord {
  pageId: string;
  tabKey: string;
  /** 刷新期间为空：连接断了，租约还在等同一身份回来。 */
  connectionId?: string;
  send?: Send;
  openedAt: number;
  /** 未认领时的配对码；认领后清空，凭据只能用一次。 */
  code?: string;
  codeExpiresAt?: number;
  controllerId?: string;
  agentName?: string;
  /** 最近操作的控件：刷新后页面据此把焦点框放回原处。 */
  lastControl?: string;
  commandSeq: number;
  pending: Map<string, PendingCommand>;
  graceTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface PageLease {
  pageId: string;
  agentName: string;
}

export interface SitePagesOptions {
  now?: () => number;
  reattachGraceMs?: number;
  leaseIdleMs?: number;
  commandTimeoutMs?: number;
  /** 认领前的准入：标签页坐在没开 MCP 的房间时由它抛错。 */
  admitTab?: (tabKey: string) => void;
  /** 标签页进入或离开接管：三款游戏据此更新座位徽标与进房准入。 */
  onControlChange?: (tabKey: string, controlled: boolean) => void;
}

const makeCode = (): string => {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
};

const requireControl = (step: SitePageStep): void => {
  if (step.control === undefined || !CONTROL_ID.test(step.control))
    throw fail("INVALID_ARGUMENT", `${step.action} 需要 control`);
};

/** 按动作校验参数：页面只收到形状正确的指令，控件是否存在由页面当场判断。 */
const assertStep = (step: SitePageStep): void => {
  if (step.control !== undefined && !CONTROL_ID.test(step.control))
    throw fail("INVALID_ARGUMENT", "control 不合法");
  switch (step.action) {
    case "read":
      return;
    case "navigate":
      if (!step.path) throw fail("INVALID_ARGUMENT", "navigate 需要 path");
      if (!isAgentPagePath(step.path))
        throw fail("PAGE_NOT_REACHABLE", `不在 Agent 可达位置内：${step.path.slice(0, 96)}`);
      return;
    case "click":
    case "focus":
      requireControl(step);
      return;
    case "select":
      requireControl(step);
      if (typeof step.value !== "string" || step.value.length > MAX_STEP_TEXT)
        throw fail("INVALID_ARGUMENT", "select 需要 value");
      return;
    case "type":
      if (typeof step.text !== "string" || step.text.length > MAX_STEP_TEXT)
        throw fail("INVALID_ARGUMENT", `type 需要 text，最长 ${MAX_STEP_TEXT} 字`);
      return;
    case "press":
      if (!SITE_PAGE_KEYS.includes(step.key as (typeof SITE_PAGE_KEYS)[number]))
        throw fail("INVALID_ARGUMENT", `press 的 key 只能是：${SITE_PAGE_KEYS.join(" / ")}`);
      return;
    case "scroll":
      if (
        step.control === undefined &&
        !SITE_PAGE_SCROLLS.includes(step.direction as (typeof SITE_PAGE_SCROLLS)[number])
      )
        throw fail("INVALID_ARGUMENT", "scroll 需要 direction 或 control");
      return;
    default:
      throw fail("INVALID_ARGUMENT", `不支持的页面动作：${String(step.action)}`);
  }
};

/** 页面上报的路径不可达时只留路径：规则在页面侧失守也不让正文出去。 */
const restrictView = (view: SitePageView): SitePageView =>
  isAgentPagePath(view.path)
    ? view
    : {
        path: view.path,
        title: "",
        restricted: true,
        scroll: { top: 0, max: 0, viewport: 0 },
        lines: [],
        offscreenLines: [],
        controls: [],
      };

/**
 * 标签页接管租约，只存在于进程内存，是 Agent 操作人类页面的唯一入口。
 *
 * 租约按标签页身份记账而不是按连接：刷新只是换一条连接，身份没变，
 * 所以断线后保留一小段时间等它认回来，人类不用重新配对。
 * 配对码由页面持有——它交给谁，谁才能驱动它；指令只发给持有这份身份的那条连接，
 * Agent 自始至终拿不到标签页令牌与座位凭证。
 */
export class SitePages {
  private readonly byPageId = new Map<string, PageRecord>();
  private readonly byTab = new Map<string, PageRecord>();
  private readonly byConnection = new Map<string, PageRecord>();
  private readonly byController = new Map<string, PageRecord>();
  private readonly byCode = new Map<string, PageRecord>();
  private readonly now: () => number;
  private readonly reattachGraceMs: number;
  private readonly leaseIdleMs: number;
  private readonly commandTimeoutMs: number;
  private readonly admitTab: (tabKey: string) => void;
  private readonly onControlChange: (tabKey: string, controlled: boolean) => void;

  constructor(options: SitePagesOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.reattachGraceMs = options.reattachGraceMs ?? PAGE_REATTACH_GRACE_MS;
    this.leaseIdleMs = options.leaseIdleMs ?? PAGE_LEASE_IDLE_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? PAGE_COMMAND_TIMEOUT_MS;
    this.admitTab = options.admitTab ?? (() => undefined);
    this.onControlChange = options.onControlChange ?? (() => undefined);
  }

  /** 页面开启接管：已开启时换发新码（旧的立即失效），已认领时拒绝。 */
  open(
    tabKey: string,
    connectionId: string,
    send: Send
  ): { pageId: string; code: string; expiresAt: number } {
    const existing = this.byTab.get(tabKey);
    if (existing?.controllerId)
      throw fail("PAGE_ALREADY_CONTROLLED", "本页面已被 Agent 接管，请先收回");
    if (existing) {
      this.bind(existing, connectionId, send);
      return this.issueCode(existing);
    }
    if (this.byPageId.size >= MAX_PAGES) this.evictOldest();
    const record: PageRecord = {
      pageId: randomUUID(),
      tabKey,
      openedAt: this.now(),
      commandSeq: 0,
      pending: new Map(),
    };
    this.byPageId.set(record.pageId, record);
    this.byTab.set(tabKey, record);
    this.bind(record, connectionId, send);
    return this.issueCode(record);
  }

  /** 人类收回：不需要 Agent 配合，租约与配对码一起作废，在途指令立即失败。 */
  close(connectionId: string): boolean {
    const record = this.byConnection.get(connectionId);
    if (!record) return false;
    this.forget(record);
    return true;
  }

  closeByController(controllerId: string, reason: SitePageEndReason = "released"): boolean {
    const record = this.byController.get(controllerId);
    if (!record) return false;
    this.forget(record);
    this.notifyLease(record, { controlled: false, reason });
    return true;
  }

  isControlling(controllerId: string): boolean {
    return this.byController.has(controllerId);
  }

  /** 这张标签页此刻是否归 Agent：断线续接的等待期也算，刷新不该让座位徽标闪一下。 */
  isTabControlled(tabKey: string): boolean {
    return this.byTab.get(tabKey)?.controllerId !== undefined;
  }

  /**
   * 站点连接认回身份：刷新前的租约续到新连接上，页面继续保持锁定与焦点。
   * 新连接可能先于旧连接的 close 到达，所以这里直接改绑，旧连接的 close 找不到记录就是空操作。
   */
  attach(tabKey: string, connectionId: string, send: Send): boolean {
    const record = this.byTab.get(tabKey);
    if (!record?.controllerId) return false;
    this.clearGrace(record);
    this.bind(record, connectionId, send);
    this.notifyLease(record, {
      controlled: true,
      resumed: true,
      ...(record.agentName ? { agentName: record.agentName } : {}),
      ...(record.lastControl ? { focusControl: record.lastControl } : {}),
    });
    return true;
  }

  /** 连接断开：未认领的配对码随之作废，已接管的租约等身份回来，超时才结束。 */
  dropConnection(connectionId: string): void {
    const record = this.byConnection.get(connectionId);
    if (!record) return;
    if (!record.controllerId) {
      this.forget(record);
      return;
    }
    this.byConnection.delete(connectionId);
    delete record.connectionId;
    delete record.send;
    this.rejectPending(record, "PAGE_DETACHED", "页面正在重新连接，稍后重试");
    record.graceTimer = this.schedule(this.reattachGraceMs, () => this.forget(record));
  }

  /** Agent 用配对码认领：一次有效，认领后码立即作废；一个会话只驱动一张标签页。 */
  claim(code: string, controllerId: string, agentName: string): PageLease {
    this.pruneCodes();
    if (this.byController.has(controllerId))
      throw fail("PAGE_ALREADY_CONTROLLING", "本会话已接管一张页面，先 release_page");
    const record = this.byCode.get(code.trim().toUpperCase());
    if (!record?.code) throw fail("PAGE_CODE_INVALID", "配对码无效或已使用");
    this.admitTab(record.tabKey);
    record.controllerId = controllerId;
    record.agentName = agentName;
    this.forgetCode(record);
    this.byController.set(controllerId, record);
    this.touch(record);
    this.notifyLease(record, { controlled: true, agentName });
    this.onControlChange(record.tabKey, true);
    return { pageId: record.pageId, agentName };
  }

  /** 下发一步操作并等页面执行完：结果由页面当场判断，服务端只校验形状与可达范围。 */
  dispatch(controllerId: string, step: SitePageStep): Promise<SitePageResult> {
    const record = this.byController.get(controllerId);
    if (!record) throw fail("PAGE_NOT_CONTROLLED", "尚未接管页面（或已被收回），先调 control_page");
    assertStep(step);
    this.touch(record);
    if (!record.send) throw fail("PAGE_DETACHED", "页面正在重新连接，稍后重试");
    const command: SitePageCommand = {
      ...step,
      id: `page-${++record.commandSeq}-${record.pageId.slice(0, 8)}`,
    };
    if (step.control) record.lastControl = step.control;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        record.pending.delete(command.id);
        reject(fail("PAGE_TIMEOUT", "页面没有在时限内执行完这一步"));
      }, this.commandTimeoutMs);
      record.pending.set(command.id, { resolve, reject, timer });
      this.notify(record, createEvent(SITE_PAGE_COMMAND_EVENT, command));
    });
  }

  /** 只认持有这份身份的连接发来的结果，别的连接猜中指令号也写不进来。 */
  recordResult(connectionId: string, result: SitePageResult): boolean {
    const record = this.byConnection.get(connectionId);
    const pending = record?.pending.get(result.id);
    if (!record || !pending) return false;
    clearTimeout(pending.timer);
    record.pending.delete(result.id);
    this.touch(record);
    pending.resolve(result.view ? { ...result, view: restrictView(result.view) } : result);
    return true;
  }

  get size(): number {
    return this.byPageId.size;
  }

  private bind(record: PageRecord, connectionId: string, send: Send): void {
    if (record.connectionId) this.byConnection.delete(record.connectionId);
    record.connectionId = connectionId;
    record.send = send;
    this.byConnection.set(connectionId, record);
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

  /** 租约的每条终点都走这里：解除索引、作废在途指令，并让三款游戏更新座位状态。 */
  private forget(record: PageRecord): void {
    const wasControlled = record.controllerId !== undefined;
    this.forgetCode(record);
    this.clearGrace(record);
    if (record.idleTimer) clearTimeout(record.idleTimer);
    delete record.idleTimer;
    this.byPageId.delete(record.pageId);
    this.byTab.delete(record.tabKey);
    if (record.connectionId) this.byConnection.delete(record.connectionId);
    if (record.controllerId) this.byController.delete(record.controllerId);
    delete record.controllerId;
    this.rejectPending(record, "PAGE_RELEASED", "页面接管已结束");
    if (wasControlled) this.onControlChange(record.tabKey, false);
  }

  private forgetCode(record: PageRecord): void {
    if (record.code) this.byCode.delete(record.code);
    delete record.code;
    delete record.codeExpiresAt;
  }

  private clearGrace(record: PageRecord): void {
    if (record.graceTimer) clearTimeout(record.graceTimer);
    delete record.graceTimer;
  }

  private rejectPending(record: PageRecord, code: string, message: string): void {
    for (const pending of record.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(fail(code, message));
    }
    record.pending.clear();
  }

  /** Agent 的任何动作都算活着；到期后页面解锁并告诉人类原因。 */
  private touch(record: PageRecord): void {
    if (record.idleTimer) clearTimeout(record.idleTimer);
    record.idleTimer = this.schedule(this.leaseIdleMs, () => {
      this.forget(record);
      this.notifyLease(record, { controlled: false, reason: "expired" });
    });
  }

  /** 进程退出不等这些定时器：租约只在内存里，重启后本来就全部失效。 */
  private schedule(delayMs: number, task: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(task, delayMs);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }

  private notifyLease(record: PageRecord, lease: SitePageLease): void {
    this.notify(record, createEvent(SITE_PAGE_LEASE_EVENT, lease));
  }

  private notify(record: PageRecord, payload: ServerMessage): void {
    try {
      record.send?.(payload);
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

  /**
   * 满表时只回收最早开启、尚未被认领的页面；全部已被接管时拒绝新开。
   * 开启接管不需要任何凭据，按全局最旧淘汰等于让匿名连接把别人正在被 Agent 操作的页面挤掉。
   */
  private evictOldest(): void {
    const oldest = [...this.byPageId.values()]
      .filter((record) => !record.controllerId)
      .sort((left, right) => left.openedAt - right.openedAt)[0];
    if (!oldest) throw fail("PAGES_FULL", "可接管页面已满，请稍后再试");
    this.forget(oldest);
  }
}
