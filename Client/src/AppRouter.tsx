import type { ComponentType } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { RouteErrorFallback } from "@/components/common/AppErrorFallback";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";
import { RootLayout } from "@/layouts/RootLayout";

/**
 * 路由级懒加载：数据路由先取到页面分块、再提交导航，
 * 跨页过渡因此总在新页可渲染之后才开始，不会把加载占位拍进快照。
 */
const page =
  <P extends object = object>(load: () => Promise<{ default: ComponentType<P> }>, props?: P) =>
  async () => {
    const Page = (await load()).default;
    // 要给页面传固定属性（如单人房）时只能走 element；其余一律交给路由库按 Component 渲染。
    return props ? { element: <Page {...props} /> } : { Component: Page as ComponentType };
  };

/** 数据路由：跨页过渡（`viewTransition`）只在数据路由下生效，见 DesignGuide §8。 */
export function createAppRouter() {
  return createBrowserRouter([
    {
      element: <RootLayout />,
      // 页面渲染错误与分块加载失败都落到这里，与入口的错误边界同一套上报与回退界面。
      errorElement: <RouteErrorFallback />,
      // 首次进入时页面分块还没到，由这里占位；之后的导航都先取分块，旧页留到新页就绪。
      hydrateFallbackElement: <PageLoadingFallback />,
      children: [
        { path: "/", lazy: page(() => import("@/pages/LandingPage")) },
        {
          path: "/whoisfaker",
          lazy: page(() => import("@/layouts/WhoIsFakerLayout")),
          children: [
            { index: true, lazy: page(() => import("@/pages/WhoIsFakerPage")) },
            {
              path: "room/:roomId",
              lazy: page(() => import("@/pages/WhoIsFakerRoomPage")),
            },
            // 子路径打错时退回本游戏大厅，而不是留在空白页
            { path: "*", element: <Navigate to="/whoisfaker" replace /> },
          ],
        },
        {
          path: "/songuessr",
          lazy: page(() => import("@/layouts/SonGuessrLayout")),
          children: [
            { index: true, lazy: page(() => import("@/pages/SonGuessrPage")) },
            {
              path: "solo",
              lazy: page(() => import("@/pages/SonGuessrRoomPage"), { solo: true }),
            },
            {
              path: "room/:roomId",
              lazy: page(() => import("@/pages/SonGuessrRoomPage")),
            },
            { path: "*", element: <Navigate to="/songuessr" replace /> },
          ],
        },
        {
          path: "/cee",
          lazy: page(() => import("@/layouts/CEELayout")),
          children: [
            { index: true, lazy: page(() => import("@/pages/CEEPage")) },
            { path: "room/:roomId", lazy: page(() => import("@/pages/CEERoomPage")) },
            { path: "ranked", lazy: page(() => import("@/pages/CEERankedPage")) },
            { path: "*", element: <Navigate to="/cee" replace /> },
          ],
        },
        { path: "/admin", lazy: page(() => import("@/pages/AdminPage")) },
        // 关于项目：开源致谢 / 更新日志 / 提交历史 / 隐私说明 / 用户条款统一走 ?tab=。
        { path: "/abouts", lazy: page(() => import("@/pages/CreditsPage")) },
        // 公开状态页：noindex，不进营销页登记位；后端不可达时按未知降级。
        { path: "/status", lazy: page(() => import("@/pages/StatusPage")) },
        // 其余无法识别的路径一律回落地页
        { path: "*", element: <Navigate to="/" replace /> },
      ],
    },
  ]);
}

export type AppRouter = ReturnType<typeof createAppRouter>;
