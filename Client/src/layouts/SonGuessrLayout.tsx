import { SonGuessrProvider } from "@/contexts/SonGuessrContext";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { SongSoundBridge } from "@/components/songuessr/SongSoundBridge";
import { GameLayout } from "@/layouts/GameLayout";

function SonGuessrLayout() {
  const toasts = useSonGuessrStore((state) => state.toasts);
  return (
    <SonGuessrProvider>
      <GameLayout soundBridge={<SongSoundBridge />} toasts={toasts} />
    </SonGuessrProvider>
  );
}

export default SonGuessrLayout;
