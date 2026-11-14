import { WhoIsFakerProvider } from "@/contexts/WhoIsFakerContext";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { FakerSoundBridge } from "@/components/whoisfaker/FakerSoundBridge";
import { GameLayout } from "@/layouts/GameLayout";

function WhoIsFakerLayout() {
  const toasts = useWhoIsFakerStore((state) => state.toasts);
  return (
    <WhoIsFakerProvider>
      <GameLayout soundBridge={<FakerSoundBridge />} toasts={toasts} />
    </WhoIsFakerProvider>
  );
}

export default WhoIsFakerLayout;
