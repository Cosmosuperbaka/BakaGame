import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { PageLoadingFallback } from "@/components/common/PageLoadingFallback";
import { VersionUpdateNotice } from "@/components/VersionUpdateNotice";

import { retryLazyImport } from "@/lib/LazyImport";

const LandingPage = lazy(() => retryLazyImport(() => import("@/pages/LandingPage"), "landing"));
const WhoIsFakerPage = lazy(() => retryLazyImport(() => import("@/pages/WhoIsFakerPage"), "faker"));
const WhoIsFakerRoomPage = lazy(() => retryLazyImport(() => import("@/pages/WhoIsFakerRoomPage"), "faker-room"));
const SonGuessrPage = lazy(() => retryLazyImport(() => import("@/pages/SonGuessrPage"), "song"));
const SonGuessrRoomPage = lazy(() => retryLazyImport(() => import("@/pages/SonGuessrRoomPage"), "song-room"));

const WhoIsFakerLayout = lazy(() => retryLazyImport(() => import("@/layouts/WhoIsFakerLayout"), "faker-layout"));
const SonGuessrLayout = lazy(() => retryLazyImport(() => import("@/layouts/SonGuessrLayout"), "song-layout"));

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
                <Route path="solo" element={<SonGuessrRoomPage solo />} />
                <Route path="room/:roomId" element={<SonGuessrRoomPage />} />
                <Route path="*" element={<Navigate to="/songuessr" replace />} />
              </Route>
              <Route path="/ccb/*" element={<Navigate to="/" replace />} />
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
