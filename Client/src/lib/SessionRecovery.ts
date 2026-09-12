/**
 * 会话级一次性恢复门闩。
 *
 * 分块下载失败、第三方扩展改写 DOM 等瞬时外部干扰，重载页面后即可完全恢复；
 * 但同一浏览器会话内只允许自动恢复一次，避免真实缺陷引发无限重载循环。
 * 浏览器禁用存储时一律返回 false，交由调用方按原样抛出真实错误，
 * 绝不把存储异常伪装成加载失败。
 */
export function reserveSessionRecovery(storageKey: string): boolean {
  try {
    if (typeof window === "undefined") return false;
    const storage = window.sessionStorage;
    if (storage.getItem(storageKey) === "1") return false;
    storage.setItem(storageKey, "1");
    return true;
  } catch {
    return false;
  }
}
