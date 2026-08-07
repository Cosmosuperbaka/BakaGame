import { BrowserRouter, Routes, Route, Outlet, Navigate } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GameProvider } from "@/contexts/GameContext";
import { ToastContainer } from "@/components/Toast";
import LandingPage from "@/pages/LandingPage";
import WhoIsFakerPage from "@/pages/WhoIsFakerPage";
import RoomPage from "@/pages/RoomPage";
import SongGuessrPage from "@/pages/SongGuessrPage";
import AnimeCharacterGuessrPage from "@/pages/AnimeCharacterGuessrPage";

// WhoIsFaker 子路由布局 — 初始化 GameSocket、展示 Toast
function WhoIsFakerLayout() {
  return (
    <GameProvider>
      <Outlet />
      <ToastContainer />
    </GameProvider>
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
          <Route path="/songguessr/*" element={<SongGuessrPage />} />
          <Route path="/animecharguessr/*" element={<AnimeCharacterGuessrPage />} />
          {/* 其余无法识别的路径一律回落地页 */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </TooltipProvider>
      </MotionConfig>
    </BrowserRouter>
  );
}

export default App;
