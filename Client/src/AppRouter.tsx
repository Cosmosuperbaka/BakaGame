import { createBrowserRouter, Navigate } from "react-router";
import { GAME_IDS, GAME_ROUTES } from "@bakagame/shared/values";
import { RouteErrorFallback } from "@/components/common/AppErrorFallback";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";
import { GAME_CLIENT, lazyPage } from "@/config/GameClient";
import { RootLayout } from "@/layouts/RootLayout";

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
        { path: "/", lazy: lazyPage(() => import("@/pages/LandingPage")) },
        ...GAME_IDS.map((game) => ({
          path: GAME_ROUTES[game].base,
          lazy: lazyPage(GAME_CLIENT[game].layout),
          children: [
            ...GAME_CLIENT[game].routes,
            // 子路径打错时退回本游戏大厅，而不是留在空白页
            { path: "*", element: <Navigate to={GAME_ROUTES[game].base} replace /> },
          ],
        })),
        { path: "/admin", lazy: lazyPage(() => import("@/pages/AdminPage")) },
        // 关于项目：开源致谢 / 更新日志 / 提交历史 / 隐私说明 / 用户条款统一走 ?tab=。
        { path: "/abouts", lazy: lazyPage(() => import("@/pages/CreditsPage")) },
        // 公开状态页：noindex，不进营销页登记位；后端不可达时按未知降级。
        { path: "/status", lazy: lazyPage(() => import("@/pages/StatusPage")) },
        // 已下线的旧入口仍回首页：外部还有指向它的旧链接，那是有意保留的去向，不算未知路径。
        { path: "/animecharguessr", element: <Navigate to="/" replace /> },
        // 其余无法识别的路径明说页面不存在：静默跳回首页会让乱码地址被当成首页的重复页。
        { path: "*", lazy: lazyPage(() => import("@/pages/NotFoundPage")) },
      ],
    },
  ]);
}

export type AppRouter = ReturnType<typeof createAppRouter>;
