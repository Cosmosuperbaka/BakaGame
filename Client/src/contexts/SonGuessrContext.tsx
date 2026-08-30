import { useEffect, type ReactNode } from "react";
import { initSonGuessrWs } from "@/stores/UseSonGuessrStore";

export function SonGuessrProvider({ children }: { children: ReactNode }) {
  useEffect(() => initSonGuessrWs(), []);
  return <>{children}</>;
}

export const SongGuessrProvider = SonGuessrProvider;
