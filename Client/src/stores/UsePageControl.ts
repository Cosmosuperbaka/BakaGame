import type { SitePageAction } from "@bakagame/shared";
import { createExternalStore } from "@/lib/ExternalStore";

/**
 * 本标签页的接管状态。
 *
 * - `off`：没开启，Agent 拿不到任何能驱动这张标签页的东西；
 * - `open`：已生成一次性配对码，等 Agent 认领（过期时间以服务端为准）；
 * - `controlled`：已被某个 Agent 会话接管，人类只能旁观并随时收回。
 */
export type PageControlStatus = "off" | "open" | "controlled";

export interface PageControlState {
  status: PageControlStatus;
  /** 未认领时的配对码：页面自己展示、人类复制给 Agent，不进本地存储。 */
  code?: string;
  expiresAt?: number;
  agentName?: string;
  /** 连接断了、租约还在等身份回来：保持锁定，提示人类正在恢复。 */
  reconnecting?: boolean;
}

/** Agent 当前的动作与目标。`element` 优先，节点被重建后靠 `controlId` 重新找到。 */
export interface AgentFocus {
  action: SitePageAction;
  element?: HTMLElement;
  controlId?: string;
  label?: string;
  /** 这一步已做完、Agent 在想下一步：框留在原处，文案不再说它正在点击。 */
  idle?: boolean;
  /** 每次动作递增：连点同一个控件时点击回声也要重放。 */
  seq: number;
}

/** 接管结束后留给人类的一句话，说清是谁、因为什么结束的。 */
export interface PageControlNotice {
  text: string;
  seq: number;
}

const OFF: PageControlState = { status: "off" };

const control = createExternalStore<PageControlState>(OFF);
const focus = createExternalStore<AgentFocus | null>(null);
const notice = createExternalStore<PageControlNotice | null>(null);

export const getPageControl = control.get;
export const setPageControl = control.set;
export const resetPageControl = (): void => control.set(OFF);
export const usePageControl = control.use;

export const getAgentFocus = focus.get;
export const setAgentFocus = (next: Omit<AgentFocus, "seq">): void =>
  focus.set({ ...next, seq: (focus.get()?.seq ?? 0) + 1 });
export const markAgentIdle = (): void => {
  const current = focus.get();
  if (current) focus.set({ ...current, idle: true });
};
export const clearAgentFocus = (): void => focus.set(null);
export const useAgentFocus = focus.use;

export const showPageNotice = (text: string): void =>
  notice.set({ text, seq: (notice.get()?.seq ?? 0) + 1 });
export const clearPageNotice = (): void => notice.set(null);
export const usePageNotice = notice.use;
