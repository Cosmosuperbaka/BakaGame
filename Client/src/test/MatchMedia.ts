import { vi } from "vitest";

/**
 * 媒体查询替身：记录查询串与 change 监听器，便于手动触发断点变化。
 * 所有查询共用同一个结果；调用方在用例结束时 `vi.unstubAllGlobals()` 还原。
 */
export function stubMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  const query = {
    matches,
    addEventListener: (_: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_: string, listener: () => void) => { listeners.delete(listener); },
  };
  vi.stubGlobal("matchMedia", (media: string) => {
    queries.push(media);
    return query;
  });
  return {
    /** 创建过的媒体查询串，按调用顺序 */
    queries,
    /** 当前挂着的 change 监听器数量 */
    get listenerCount() { return listeners.size; },
    /** 模拟视口越过断点，`next` 为越过后的匹配结果 */
    crossBreakpoint(next: boolean) {
      query.matches = next;
      for (const listener of listeners) listener();
    },
  };
}
