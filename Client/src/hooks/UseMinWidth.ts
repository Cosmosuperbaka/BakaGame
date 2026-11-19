import { useSyncExternalStore } from "react";

/** Tailwind 断点；媒体查询里的 rem 按浏览器初始字号计算，不受 html 120% 字号影响。 */
export const BREAKPOINTS = { sm: "40rem", md: "48rem", lg: "64rem", xl: "80rem" } as const;

export type Breakpoint = keyof typeof BREAKPOINTS;

const queryOf = (breakpoint: Breakpoint) => `(min-width: ${BREAKPOINTS[breakpoint]})`;

/**
 * 视口是否不窄于某个断点。按断点决定「挂载哪一份」而不是用 CSS 隐藏：隐藏的那份照样渲染、保有状态。
 * 首帧就读真实的媒体查询结果（同步），不会先按宽屏挂一遍再卸掉。
 * 没有 `matchMedia` 的环境（预渲染、部分测试）按宽屏处理。
 */
export function useMinWidth(breakpoint: Breakpoint): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof matchMedia === "undefined") return () => {};
      const query = matchMedia(queryOf(breakpoint));
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => (typeof matchMedia === "undefined" ? true : matchMedia(queryOf(breakpoint)).matches),
    () => true
  );
}
