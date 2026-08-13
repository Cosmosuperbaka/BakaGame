import { BrowserRouter, Routes, Route, Outlet, Navigate, useMatch } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GameProvider } from "@/contexts/GameContext";
import { SongGuessrToastContainer, ToastContainer } from "@/components/Toast";
import LandingPage from "@/pages/LandingPage";
import WhoIsFakerPage from "@/pages/WhoIsFakerPage";
import RoomPage from "@/pages/RoomPage";
import SongGuessrPage from "@/pages/SongGuessrPage";
import SongGuessrRoomPage from "@/pages/SongGuessrRoomPage";
import { SongGuessrProvider } from "@/contexts/SongGuessrContext";
import { VersionUpdateNotice } from "@/components/VersionUpdateNotice";
import { useGameStore } from "@/stores/useGameStore";
import { useSongGuessrStore } from "@/stores/useSongGuessrStore";

// WhoIsFaker 子路由布局 — 初始化 GameSocket、展示 Toast
function WhoIsFakerLayout() {
  const inRoom = Boolean(useMatch("/whoisfaker/room/:roomId"));
  const active = useGameStore((state) => inRoom && Boolean(state.roomId && state.snapshot));
  return (
    <GameProvider>
      <Outlet />
      <ToastContainer />
      <VersionUpdateNotice active={active} />
    </GameProvider>
  );
}

function SongGuessrLayout() {
  const inRoom = Boolean(useMatch("/songuessr/room/:roomId"));
  const active = useSongGuessrStore((state) => inRoom && Boolean(state.roomId && state.snapshot));
  return (
    <SongGuessrProvider>
      <Outlet />
      <SongGuessrToastContainer />
      <VersionUpdateNotice active={active} />
    </SongGuessrProvider>
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
              <Route path="room/:roomId" element={<RoomPage />} />
              {/* 子路径打错时退回本游戏大厅，而不是留在空白页 */}
              <Route path="*" element={<Navigate to="/whoisfaker" replace />} />
            </Route>
            <Route path="/songuessr" element={<SongGuessrLayout />}>
              <Route index element={<SongGuessrPage />} />
              <Route path="room/:roomId" element={<SongGuessrRoomPage />} />
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
