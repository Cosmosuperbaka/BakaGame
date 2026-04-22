import { BrowserRouter, Routes, Route } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GameProvider } from "@/contexts/GameContext";
import { ToastContainer } from "@/components/Toast";
import HomePage from "@/pages/HomePage";
import RoomPage from "@/pages/RoomPage";

function App() {
  return (
    <BrowserRouter>
      <TooltipProvider>
        <GameProvider>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/room/:roomId" element={<RoomPage />} />
          </Routes>
          <ToastContainer />
        </GameProvider>
      </TooltipProvider>
    </BrowserRouter>
  );
}

export default App;
