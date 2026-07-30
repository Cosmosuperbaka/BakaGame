import { useEffect, type ReactNode } from "react";
import { initGameSocket } from "@/stores/useGameStore";

export function GameProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const cleanup = initGameSocket();
    return cleanup;
  }, []);

  return <>{children}</>;
}

