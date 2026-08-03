import { BrowserRouter, Routes, Route, Outlet } from "react-router-dom";
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
      <TooltipProvider>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/whoisfaker" element={<WhoIsFakerLayout />}>
            <Route index element={<WhoIsFakerPage />} />
            <Route path="room/:roomId" element={<RoomPage />} />
          </Route>
          <Route path="/songguessr/*" element={<SongGuessrPage />} />
          <Route path="/animecharguessr/*" element={<AnimeCharacterGuessrPage />} />
        </Routes>
      </TooltipProvider>
    </BrowserRouter>
  );
}

export default App;
