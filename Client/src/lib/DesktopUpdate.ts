import { useEffect, useState } from "react";

/**
 * 桌面壳本体的自动更新：壳在后台下载并校验好新版，页面只读状态、在玩家点「重启更新」时请壳安装。
 *
 * 走的是两条契约外的壳命令（不在 `window.__BAKA_CHANNEL__` 冻结契约里）：`baka_update_status`
 * 只读状态，`baka_update_install` 不收参数——装什么由壳决定，壳安装前还会再校验一遍签名，
 * 页面给不出地址也给不出字节。旧版壳没有这两条命令，调用失败就当不支持，提醒照旧给下载链接。
 */

export type DesktopUpdatePhase = "checking" | "none" | "downloading" | "ready" | "failed";

export interface DesktopUpdateStatus {
  state: DesktopUpdatePhase;
  /** 壳发现的新版本号；没有新版时缺省。 */
  version?: string;
}

interface TauriInternals {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

declare global {
  interface Window {
    /** Tauri 注入的 IPC 入口；网页与移动壳里没有。 */
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

const PHASES: readonly DesktopUpdatePhase[] = [
  "checking",
  "none",
  "downloading",
  "ready",
  "failed",
];

/** 查询中、下载中时较快地轮询；其余状态放慢，壳的后台重试成功后页面也能慢慢看到。 */
const DESKTOP_UPDATE_POLL_BUSY_MS = 4_000;
const DESKTOP_UPDATE_POLL_IDLE_MS = 60_000;

const invoker = () => {
  if (typeof window === "undefined") return undefined;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  return typeof invoke === "function" ? invoke : undefined;
};

const parseStatus = (value: unknown): DesktopUpdateStatus | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const state = PHASES.find((phase) => phase === record.state);
  if (!state) return null;
  return typeof record.version === "string" && record.version
    ? { state, version: record.version }
    : { state };
};

/** 读壳的更新状态；网页、移动壳、旧版壳或返回值不对时给 `null`（当不支持）。 */
export async function readDesktopUpdateStatus(): Promise<DesktopUpdateStatus | null> {
  const invoke = invoker();
  if (!invoke) return null;
  try {
    return parseStatus(await invoke("baka_update_status"));
  } catch {
    return null;
  }
}

/**
 * 请壳安装已就绪的更新并重启。成功时壳会退出，这个 Promise 通常等不到结果；
 * 返回 `false` 表示壳拒绝或装失败，调用方回落到下载链接。
 */
export async function installDesktopUpdate(): Promise<boolean> {
  const invoke = invoker();
  if (!invoke) return false;
  try {
    await invoke("baka_update_install");
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 `enabled` 期间轮询壳的更新状态。不支持的环境返回 `null` 并停止轮询；
 * 已就绪后也不再轮询（包已经在壳手里，状态不会再变好）。
 */
export function useDesktopUpdateStatus(enabled: boolean): DesktopUpdateStatus | null {
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);

  useEffect(() => {
    if (!enabled || !invoker()) return;
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      const next = await readDesktopUpdateStatus();
      if (!alive) return;
      setStatus(next);
      if (!next || next.state === "ready") return;
      const busy = next.state === "checking" || next.state === "downloading";
      timer = window.setTimeout(
        () => void poll(),
        busy ? DESKTOP_UPDATE_POLL_BUSY_MS : DESKTOP_UPDATE_POLL_IDLE_MS
      );
    };
    void poll();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled]);

  return enabled ? status : null;
}
