import type { ToastItem } from "@/components/Toast";

/** 只保留一条提示的玩法（猜歌、CEE）用的视图转换。 */
export function toToastItems(toast: Omit<ToastItem, "id"> | null): ToastItem[] {
  return toast ? [{ id: `${toast.type}:${toast.text}`, ...toast }] : [];
}
