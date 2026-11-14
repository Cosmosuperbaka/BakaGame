import { SonGuessrProvider } from "@/contexts/SonGuessrContext";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { SongSoundBridge } from "@/components/songuessr/SongSoundBridge";
import { GameLayout } from "@/layouts/GameLayout";
import { toToastItems } from "@/layouts/ToastItems";

function SonGuessrLayout() {
  const toast = useSonGuessrStore((state) => state.toast);
  return (
    <SonGuessrProvider>
      <GameLayout soundBridge={<SongSoundBridge />} toasts={toToastItems(toast)} />
    </SonGuessrProvider>
  );
}

export default SonGuessrLayout;
