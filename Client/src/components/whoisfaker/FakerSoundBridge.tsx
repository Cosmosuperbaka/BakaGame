import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useActionRequiredSound, useChatMessageSound } from "@/hooks/UseNotificationSounds";
import { whoIsFakerNeedsAction } from "@/lib/WhoIsFakerActionSignals";

/** 只负责把谁是卧底的行动态与聊天更新接到公共提示音。 */
export function FakerSoundBridge() {
  const snapshot = useWhoIsFakerStore((state) => state.snapshot);
  const privateState = useWhoIsFakerStore((state) => state.privateState);
  const storeRoomId = useWhoIsFakerStore((state) => state.roomId);
  const ready = Boolean(snapshot && privateState && snapshot.roomId === storeRoomId);
  useActionRequiredSound(
    whoIsFakerNeedsAction(snapshot, privateState),
    snapshot?.roomId ?? null,
    ready
  );
  useChatMessageSound(
    snapshot?.chat ?? null,
    privateState?.playerId ?? null,
    snapshot?.roomId ?? null
  );
  return null;
}
