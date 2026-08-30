import { useEffect, type ReactNode } from "react";
import { initWhoIsFakerWs } from "@/stores/UseWhoIsFakerStore";

export function WhoIsFakerProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const cleanup = initWhoIsFakerWs();
    return cleanup;
  }, []);

  return <>{children}</>;
}

export const GameProvider = WhoIsFakerProvider;
