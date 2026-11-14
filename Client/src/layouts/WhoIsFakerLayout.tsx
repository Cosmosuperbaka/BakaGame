import { initWhoIsFakerWs, useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { FakerSoundBridge } from "@/components/whoisfaker/FakerSoundBridge";
import { GameLayout } from "@/layouts/GameLayout";

function WhoIsFakerLayout() {
  const toasts = useWhoIsFakerStore((state) => state.toasts);
  return <GameLayout init={initWhoIsFakerWs} soundBridge={<FakerSoundBridge />} toasts={toasts} />;
}

export default WhoIsFakerLayout;
