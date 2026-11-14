import type { ToastItem } from "@/components/Toast";

export interface ToastState {
  toasts: ToastItem[];
  showToast: (text: string, type?: ToastItem["type"], durationMs?: number) => void;
  dismissToast: (id: ToastItem["id"]) => void;
  clearToasts: () => void;
}

export interface ToastSliceOptions {
  /**
   * queue：多条并存、各自到点消失，编号自增，同一句话连发会重播入场；
   * slot：新提示顶掉旧提示，编号取「类型:文字」，同一句话连发不重播入场。
   */
  mode: "queue" | "slot";
  defaultType: ToastItem["type"];
  defaultMs: number;
}

type ToastSet = (patch: Partial<ToastState> | ((state: ToastState) => Partial<ToastState>)) => void;

/** 定时器句柄留在切片闭包内：提示的存续只由切片负责，调用方不各自持一份计时器。 */
export function createToastSlice(set: ToastSet, options: ToastSliceOptions): ToastState {
  const { mode, defaultType, defaultMs } = options;
  const timers = new Map<ToastItem["id"], ReturnType<typeof setTimeout>>();
  let counter = 0;

  const cancelTimers = () => {
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
  };

  const dismissToast = (id: ToastItem["id"]) => {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
    set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
  };

  const showToast = (text: string, type = defaultType, durationMs = defaultMs) => {
    const id = mode === "queue" ? ++counter : `${type}:${text}`;
    const item: ToastItem = { id, text, type };
    if (mode === "slot") {
      cancelTimers();
      set({ toasts: [item] });
    } else {
      set((state) => ({ toasts: [...state.toasts, item] }));
    }
    timers.set(
      id,
      setTimeout(() => dismissToast(id), durationMs)
    );
  };

  return {
    toasts: [],
    showToast,
    dismissToast,
    clearToasts: () => {
      cancelTimers();
      set({ toasts: [] });
    },
  };
}
