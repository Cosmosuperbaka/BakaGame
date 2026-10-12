import { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";
import { useAccountBootstrap } from "@/hooks/UseAccountBootstrap";
import { usePageTransitionDirection } from "@/hooks/UsePageTransition";

/** 全部页面的根布局：把页面过渡方向写到根元素、引导账号状态，页面本身由子路由渲染。 */
export function RootLayout() {
  usePageTransitionDirection();
  useAccountBootstrap();
  return (
    <Suspense fallback={<PageLoadingFallback />}>
      <Outlet />
    </Suspense>
  );
}

export default RootLayout;
