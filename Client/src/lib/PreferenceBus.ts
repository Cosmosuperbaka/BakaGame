import { createSignal } from "@/lib/Signal";

/**
 * 云同步偏好的两个通知（见 `lib/CloudSync.ts`）：
 * - 变更：写入同步范围内的本地键之后发出，已登录时由云同步合并上传；
 * - 已应用：云端偏好写回本地之后发出，让已挂载的读取方重读。
 */
const changed = createSignal();
const applied = createSignal();

export const notifyPreferencesChanged = changed.emit;
export const onPreferencesChanged = changed.subscribe;
export const notifyPreferencesApplied = applied.emit;
export const onPreferencesApplied = applied.subscribe;
