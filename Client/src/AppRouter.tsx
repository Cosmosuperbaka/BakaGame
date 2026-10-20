import type { ComponentType } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";
import { RootLayout } from "@/layouts/RootLayout";
import { retryLazyImport } from "@/lib/LazyImport";

/**
 * 路由级懒加载：数据路由先取到页面分块、再提交导航，
 * 跨页过渡因此总在新页可渲染之后才开始，不会把加载占位拍进快照。
 */
const page = (load: () => Promise<{ default: ComponentType }>, key: string) => async () => ({
  Component: (await retryLazyImport(load, key)).default,
});

/** 数据路由：跨页过渡（`viewTransition`）只在数据路由下生效，见 Animation §2.4。 */
export function createAppRouter() {
  return createBrowserRouter([
    {
      element: <RootLayout />,
      // 首次进入时页面分块还没到，由这里占位；之后的导航都先取分块，旧页留到新页就绪。
      hydrateFallbackElement: <PageLoadingFallback />,
      children: [
        { path: "/", lazy: page(() => import("@/pages/LandingPage"), "landing") },
        {
          path: "/whoisfaker",
          lazy: page(() => import("@/layouts/WhoIsFakerLayout"), "faker-layout"),
          children: [
            { index: true, lazy: page(() => import("@/pages/WhoIsFakerPage"), "faker") },
            {
              path: "room/:roomId",
              lazy: page(() => import("@/pages/WhoIsFakerRoomPage"), "faker-room"),
            },
            // 子路径打错时退回本游戏大厅，而不是留在空白页
            { path: "*", element: <Navigate to="/whoisfaker" replace /> },
          ],
        },
        {
          path: "/songuessr",
          lazy: page(() => import("@/layouts/SonGuessrLayout"), "song-layout"),
          children: [
            { index: true, lazy: page(() => import("@/pages/SonGuessrPage"), "song") },
            {
              path: "solo",
              lazy: async () => {
                const { default: SonGuessrRoomPage } = await retryLazyImport(
                  () => import("@/pages/SonGuessrRoomPage"),
                  "song-room"
                );
                return { element: <SonGuessrRoomPage solo /> };
              },
            },
            {
              path: "room/:roomId",
              lazy: page(() => import("@/pages/SonGuessrRoomPage"), "song-room"),
            },
            { path: "*", element: <Navigate to="/songuessr" replace /> },
          ],
        },
        {
          path: "/cee",
          lazy: page(() => import("@/layouts/CEELayout"), "cee-layout"),
          children: [
            { index: true, lazy: page(() => import("@/pages/CEEPage"), "cee") },
            { path: "room/:roomId", lazy: page(() => import("@/pages/CEERoomPage"), "cee-room") },
            { path: "*", element: <Navigate to="/cee" replace /> },
          ],
        },
        { path: "/admin", lazy: page(() => import("@/pages/AdminPage"), "admin") },
        // 版本信息页（更新日志 / 提交历史 / 开源致谢）：由页脚版本号进入，走专属的整页升起转场。
        { path: "/credits", lazy: page(() => import("@/pages/CreditsPage"), "credits") },
        // 法务页：仅从页脚进入，noindex，不进静态外壳与营销页登记位。
        { path: "/privacy", lazy: page(() => import("@/pages/PrivacyPage"), "privacy") },
        { path: "/terms", lazy: page(() => import("@/pages/TermsPage"), "terms") },
        // 公开状态页：noindex，不进营销页登记位；后端不可达时按未知降级。
        { path: "/status", lazy: page(() => import("@/pages/StatusPage"), "status") },
        // 其余无法识别的路径一律回落地页
        { path: "*", element: <Navigate to="/" replace /> },
      ],
    },
  ]);
}

export type AppRouter = ReturnType<typeof createAppRouter>;
