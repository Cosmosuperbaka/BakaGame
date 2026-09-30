import { useEffect } from "react";

/** Tailwind 断点；媒体查询里的 rem 按浏览器初始字号计算，不受 html 120% 字号影响。 */
const BREAKPOINTS = { sm: "40rem", md: "48rem", lg: "64rem", xl: "80rem" } as const;

export type Breakpoint = keyof typeof BREAKPOINTS;

/**
 * 窄屏浮层在视口放大越过 `breakpoint` 时自动关闭。
 * 越过断点后由常驻布局接管，浮层的入口随之隐藏，开着的浮层必须一起收起。
 * 只在打开期间监听，关闭时不订阅媒体查询。
 */
export function useCloseFrom(open: boolean, onOpenChange: (open: boolean) => void, breakpoint: Breakpoint) {
  useEffect(() => {
    if (!open) return;
    const query = matchMedia(`(min-width: ${BREAKPOINTS[breakpoint]})`);
    const close = () => { if (query.matches) onOpenChange(false); };
    query.addEventListener("change", close);
    return () => query.removeEventListener("change", close);
  }, [open, onOpenChange, breakpoint]);
}
