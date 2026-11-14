import type { ToastItem } from "@/components/Toast";

/** 同时最多显示几条：再来新的，最早的一条让位，屏幕右上角不被一串提示占满。 */
export const TOAST_LIMIT = 3;
/** 普通信息与成功的停留时长。 */
export const TOAST_MS = 3000;
/** 错误多停一会儿：失败原因往往更长，也更需要读完。 */
export const TOAST_ERROR_MS = 5000;
/** 停机维护的说明比普通提示长，三款统一停留这么久。 */
export const SHUTDOWN_TOAST_MS = 10_000;

export interface ToastState {
  toasts: ToastItem[];
  /** 默认是普通信息；报错的调用点必须显式传 `"error"`，不靠默认值。时长缺省按类型取。 */
  showToast: (text: string, type?: ToastItem["type"], durationMs?: number) => void;
  dismissToast: (id: ToastItem["id"]) => void;
  clearToasts: () => void;
}

type ToastSet = (patch: Partial<ToastState> | ((state: ToastState) => Partial<ToastState>)) => void;
type ToastGet = () => ToastState;

const defaultDuration = (type: ToastItem["type"]) => (type === "error" ? TOAST_ERROR_MS : TOAST_MS);

/**
 * 三款玩法共用的提示队列。定时器句柄留在切片闭包内：提示的存续只由切片负责，调用方不各自持一份计时器。
 * 去重与让位都按当前列表判断，不按闭包里的记账：预置工具与测试会直接改写列表。
 */
export function createToastSlice(set: ToastSet, get: ToastGet): ToastState {
  const timers = new Map<ToastItem["id"], ReturnType<typeof setTimeout>>();
  let counter = 0;

  const stop = (id: ToastItem["id"]) => {
    const timer = timers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(id);
  };

  const dismissToast = (id: ToastItem["id"]) => {
    stop(id);
    set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
  };

  const arm = (id: ToastItem["id"], durationMs: number) => {
    stop(id);
    timers.set(
      id,
      setTimeout(() => dismissToast(id), durationMs)
    );
  };

  const showToast = (text: string, type: ToastItem["type"] = "info", durationMs?: number) => {
    const ms = durationMs ?? defaultDuration(type);
    const current = get().toasts;
    // 同一句话连发：不叠出第二条，原地重播并重新计时，玩家能看出「又来了一次」。
    const same = current.find((item) => item.text === text && item.type === type);
    if (same) {
      set({
        toasts: current.map((item) =>
          item === same ? { ...item, repeat: (item.repeat ?? 0) + 1 } : item
        ),
      });
      arm(same.id, ms);
      return;
    }
    const next = [...current, { id: ++counter, text, type }];
    const evicted = next.slice(0, Math.max(0, next.length - TOAST_LIMIT));
    evicted.forEach((item) => stop(item.id));
    set({ toasts: next.slice(evicted.length) });
    arm(counter, ms);
  };

  return {
    toasts: [],
    showToast,
    dismissToast,
    clearToasts: () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      set({ toasts: [] });
    },
  };
}
