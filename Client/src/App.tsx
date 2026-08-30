import { BrowserRouter, Routes, Route, Outlet, Navigate, useMatch } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { WhoIsFakerProvider } from "@/contexts/WhoIsFakerContext";
import { SongGuessrToastContainer, ToastContainer } from "@/components/Toast";
import LandingPage from "@/pages/LandingPage";
import WhoIsFakerPage from "@/pages/WhoIsFakerPage";
import WhoIsFakerRoomPage from "@/pages/WhoIsFakerRoomPage";
import SonGuessrPage from "@/pages/SonGuessrPage";
import SonGuessrRoomPage from "@/pages/SonGuessrRoomPage";
import { SonGuessrProvider } from "@/contexts/SonGuessrContext";
import { VersionUpdateNotice } from "@/components/VersionUpdateNotice";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";

// WhoIsFaker 子路由布局 — 初始化 GameSocket、展示 Toast
function WhoIsFakerLayout() {
  const inRoom = Boolean(useMatch("/whoisfaker/room/:roomId"));
  const active = useWhoIsFakerStore((state) => inRoom && Boolean(state.roomId && state.snapshot));
  return (
    <WhoIsFakerProvider>
      <Outlet />
      <ToastContainer />
      <VersionUpdateNotice active={active} />
    </WhoIsFakerProvider>
  );
}

function SonGuessrLayout() {
  const inRoom = Boolean(useMatch("/songuessr/room/:roomId"));
  const active = useSonGuessrStore((state) => inRoom && Boolean(state.roomId && state.snapshot));
  return (
    <SonGuessrProvider>
      <Outlet />
      <SongGuessrToastContainer />
      <VersionUpdateNotice active={active} />
    </SonGuessrProvider>
  );
}

function App() {
  return (
    <BrowserRouter>
      <MotionConfig reducedMotion="user">
        <TooltipProvider>
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
        </TooltipProvider>
      </MotionConfig>
    </BrowserRouter>
  );
}

export default App;
