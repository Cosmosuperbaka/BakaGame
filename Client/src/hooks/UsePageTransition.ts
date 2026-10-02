import { useCallback, useContext, useLayoutEffect } from "react";
import { UNSAFE_ViewTransitionContext, useNavigate, type NavigateOptions, type To } from "react-router-dom";

/**
 * 页面导航默认走 View Transitions：旧页定格成快照向前退出、新页自后方推入（见 `index.css` 的页面过渡）。
 * 浏览器不支持时 React Router 直接切换，测试与 Storybook 的声明式路由忽略该选项。
 */
export function usePageNavigate() {
  const navigate = useNavigate();
  return useCallback(
    (to: To, options?: NavigateOptions) => navigate(to, { viewTransition: true, ...options }),
    [navigate],
  );
}

export interface PageTransitionEnds {
  from: string;
  to: string;
}

/**
 * 正在进行的页面过渡两端的路径；没有过渡时为 null。
 *
 * 公开的 `useViewTransitionState` 离开数据路由（单元测试、Storybook 的 MemoryRouter）会直接抛错，
 * 这里改读它背后的同一个上下文，默认值即「不在过渡中」。上下文属于 React Router 的不稳定导出，
 * 升级后的契约由 `UsePageTransition.test.tsx` 把关。
 */
export function usePageTransitionEnds(): PageTransitionEnds | null {
  const context = useContext(UNSAFE_ViewTransitionContext);
  if (!context.isTransitioning) return null;
  return { from: context.currentLocation.pathname, to: context.nextLocation.pathname };
}

/**
 * 跨页共享元素的 `view-transition-name`。同名元素在新旧两页之间读作同一个对象，由浏览器连续移动并交叉淡化。
 *
 * 只在本次过渡的另一端是 `partner` 时命名：同一页上可能有多个候选（主页三张游戏卡、大厅里每张房间卡），
 * 若一律命名，名字会重复，不相干的过渡里它们也会脱离整页单独淡出。`partner` 省略表示任何过渡都命名
 * （该页只有一个候选，如房间顶栏的房名）；传 false 表示没有对应页面，从不命名。
 */
export function useSharedElementName(name: string, partner?: string | false): string | undefined {
  const ends = usePageTransitionEnds();
  if (!ends || partner === false) return undefined;
  if (partner !== undefined && ends.from !== partner && ends.to !== partner) return undefined;
  return name;
}

const pathDepth = (pathname: string) => pathname.split("/").filter(Boolean).length;

/**
 * 把过渡方向写到 `<html data-page-direction>`：去往更深一层的页面（主页→大厅→房间）为 forward，
 * 回到更浅的页面为 back，CSS 据此对调新旧两层的前后关系。浏览器的前进后退同样经过这里。
 * 布局副作用在 React Router 发起 `startViewTransition` 之前执行，方向总能赶上本次快照。
 */
export function usePageTransitionDirection(): void {
  const ends = usePageTransitionEnds();
  const from = ends?.from;
  const to = ends?.to;
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (from === undefined || to === undefined) {
      delete root.dataset.pageDirection;
      return;
    }
    root.dataset.pageDirection = pathDepth(to) < pathDepth(from) ? "back" : "forward";
  }, [from, to]);
}
