import { countClientMetric } from "@/lib/Sentry";
import { reserveSessionRecovery } from "@/lib/SessionRecovery";

const DOM_RECOVERY_KEY = "bakagame:dom-recovery";

/**
 * 浏览器翻译插件等第三方扩展会直接改写 DOM，破坏 React 的父子节点不变量。
 * removeChild 与 insertBefore 是同一次破坏的两个抛出点：整棵 React 树无法继续
 * 提交，玩家只能停在错误兜底页，而应用代码本身没有任何缺陷。
 *
 * 这类异常重载即可完全恢复，因此与分块加载失败保持一致的自愈策略：
 * 每个会话自动重载一次，既让玩家无感恢复，也避免真实 DOM 缺陷引发重载循环。
 * 上报侧仍由 Sentry 的 ignoreErrors 过滤，只留一条指标用于观测发生频率。
 */
const DOM_INVARIANT_PATTERN = /Failed to execute '(?:removeChild|insertBefore)' on 'Node'/i;

// 真实抛出方是 DOMException，各引擎并不保证它是 Error 的子类，只能按 message 判定。
const readErrorMessage = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
};

export const isDomInvariantError = (error: unknown): boolean =>
  DOM_INVARIANT_PATTERN.test(readErrorMessage(error));

/**
 * 命中 DOM 不变量破坏时按会话一次性重载页面。
 * @returns 是否已触发自动重载
 */
export const recoverFromDomInvariant = (error: unknown): boolean => {
  if (!isDomInvariantError(error)) return false;

  countClientMetric("bakagame.dom.recovery");

  if (!reserveSessionRecovery(DOM_RECOVERY_KEY)) return false;

  window.location.reload();
  return true;
};
