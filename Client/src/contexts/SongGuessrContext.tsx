import { useEffect, type ReactNode } from "react";
import { initSongGuessrSocket } from "@/stores/useSongGuessrStore";

export function SongGuessrProvider({ children }: { children: ReactNode }) {
  useEffect(() => initSongGuessrSocket(), []);
  return <>{children}</>;
}
