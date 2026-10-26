import { Suspense, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";
import { useAccountBootstrap } from "@/hooks/UseAccountBootstrap";
import { usePageTransitionDirection } from "@/hooks/UsePageTransition";
import { connectSiteSocket } from "@/lib/SiteWs";

/** 全部页面的根布局：把页面过渡方向写到根元素、引导账号状态，页面本身由子路由渲染。 */
export function RootLayout() {
  usePageTransitionDirection();
  useAccountBootstrap();
  // 站点通道在根布局建连：首页就有 ws（不必先进某个游戏），Agent 活动也才能在这里被看见。
  useEffect(() => connectSiteSocket(), []);
  return (
    <Suspense fallback={<PageLoadingFallback />}>
      <Outlet />
    </Suspense>
  );
}
