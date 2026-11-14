import { initSonGuessrWs, useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { SongSoundBridge } from "@/components/songuessr/SongSoundBridge";
import { GameLayout } from "@/layouts/GameLayout";

function SonGuessrLayout() {
  const toasts = useSonGuessrStore((state) => state.toasts);
  return (
    <GameLayout
      init={initSonGuessrWs}
      soundBridge={<SongSoundBridge />}
      toasts={toasts}
      toastActions={useSonGuessrStore.getState()}
    />
  );
}

export default SonGuessrLayout;
