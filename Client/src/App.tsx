import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";
import { VersionUpdateNotice } from "@/components/VersionUpdateNotice";

const LandingPage = lazy(() => import("@/pages/LandingPage"));
const WhoIsFakerPage = lazy(() => import("@/pages/WhoIsFakerPage"));
const WhoIsFakerRoomPage = lazy(() => import("@/pages/WhoIsFakerRoomPage"));
const SonGuessrPage = lazy(() => import("@/pages/SonGuessrPage"));
const SonGuessrRoomPage = lazy(() => import("@/pages/SonGuessrRoomPage"));

const WhoIsFakerLayout = lazy(() => import("@/layouts/WhoIsFakerLayout"));
const SonGuessrLayout = lazy(() => import("@/layouts/SonGuessrLayout"));

function App() {
  return (
    <BrowserRouter>
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
          <Suspense fallback={<PageLoadingFallback />}>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route path="/whoisfaker" element={<WhoIsFakerLayout />}>
                <Route index element={<WhoIsFakerPage />} />
                <Route path="room/:roomId" element={<WhoIsFakerRoomPage />} />
                {/* 子路径打错时退回本游戏大厅，而不是留在空白页 */}
                <Route path="*" element={<Navigate to="/whoisfaker" replace />} />
              </Route>
              <Route path="/songuessr" element={<SonGuessrLayout />}>
                <Route index element={<SonGuessrPage />} />
                <Route path="room/:roomId" element={<SonGuessrRoomPage />} />
                <Route path="*" element={<Navigate to="/songuessr" replace />} />
              </Route>
              {/* 其余无法识别的路径一律回落地页 */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
          <VersionUpdateNotice />
        </TooltipProvider>
      </MotionConfig>
    </BrowserRouter>
  );
}

export default App;
