import { RouterProvider } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { VersionUpdateNotice } from "@/components/VersionUpdateNotice";
import type { AppRouter } from "@/AppRouter";

/** 路由实例由入口创建一次再传进来；测试按各自的地址新建，互不共享历史记录。 */
function App({ router }: { router: AppRouter }) {
  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <RouterProvider router={router} />
        <VersionUpdateNotice />
      </TooltipProvider>
    </MotionConfig>
  );
}

export default App;
