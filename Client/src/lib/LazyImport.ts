import { reserveSessionRecovery } from "@/lib/SessionRecovery";

/**
 * 自愈标记：动态导入失败且确实拿到会话级重载门闩（即将触发自动重载）时，
 * 在错误对象上写入该标记；`Sentry.ts` 的 beforeSend 据此丢弃对应事件 ——
 * 页面马上重载，这不是用户可见缺陷。未拿到门闩（同会话已重载过一次）时
 * **不写标记**，错误照常上报：那才是玩家真正看得见的失败。
 */
export interface SelfHealedModuleLoadError extends Error {
  bakagameSelfHealedModuleLoad?: true;
}

export const isSelfHealedModuleLoadError = (error: unknown): boolean =>
  error instanceof Error &&
  (error as SelfHealedModuleLoadError).bakagameSelfHealedModuleLoad === true;

function isRecoverableChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message;
  // 各引擎的模块专属文案（Firefox 现代内核、Chromium、WebKit）：
  if (
    /^(Failed to fetch dynamically imported module(?::|$)|error loading dynamically imported module(?::|$)|Importing a module script failed\.?$)/i.test(
      message
    )
  ) {
    return true;
  }
  // 旧 WebKit / Firefox 内核在模块脚本网络失败时可能只给出通用文案
  // （"Load failed" / "NetworkError when attempting to fetch resource."）。
  // 本判定只发生在 loader()（动态 import）的 catch 内，这里抛出的网络类错误
  // 类别就是模块加载失败，不会与普通 API fetch 混同——普通 fetch 的同类文案
  // 不经过这里，因此也不再需要把它们塞进 Sentry 的全局 ignoreErrors 名单。
  return /^(Load failed|NetworkError when attempting to fetch resource\.?)$/i.test(message);
}

export const retryLazyImport = <T>(loader: () => Promise<T>, key: string): Promise<T> =>
  loader().catch((error) => {
    if (
      isRecoverableChunkLoadError(error) &&
      reserveSessionRecovery(`bakagame:chunk-retry:${key}`)
    ) {
      if (error instanceof Error)
        (error as SelfHealedModuleLoadError).bakagameSelfHealedModuleLoad = true;
      window.location.reload();
    }
    throw error;
  });
