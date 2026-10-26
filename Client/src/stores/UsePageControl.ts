import { useSyncExternalStore } from "react";

/**
 * 本页面的接管状态。
 *
 * - `off`：没开启，Agent 拿不到任何能驱动这个页面的东西；
 * - `open`：已生成一次性配对码，等 Agent 认领（5 分钟不用即过期）；
 * - `controlled`：已被某个 Agent 会话接管，页面指令由服务端下发。
 */
export type PageControlStatus = "off" | "open" | "controlled";

export interface PageControlState {
  status: PageControlStatus;
  /** 未认领时的配对码：页面自己展示、人类复制给 Agent，不进本地存储。 */
  code?: string;
  expiresAt?: number;
  agentName?: string;
}

const OFF: PageControlState = { status: "off" };

let state: PageControlState = OFF;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getPageControl = (): PageControlState => state;

export const setPageControl = (next: PageControlState): void => {
  state = next;
  emit();
};

export const resetPageControl = (): void => setPageControl(OFF);

export const usePageControl = (): PageControlState =>
  useSyncExternalStore(subscribe, getPageControl, () => OFF);
