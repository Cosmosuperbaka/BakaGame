import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { useActionRequiredSound, useChatMessageSound } from "@/hooks/UseNotificationSounds";
import { sonGuessrNeedsAction } from "@/lib/SonGuessrActionSignals";

/** 只负责把猜歌的行动态与聊天更新接到公共提示音。 */
export function SongSoundBridge() {
  const snapshot = useSonGuessrStore((state) => state.snapshot);
  const privateState = useSonGuessrStore((state) => state.privateState);
  const storeRoomId = useSonGuessrStore((state) => state.roomId);
  const ready = Boolean(snapshot && privateState && snapshot.roomId === storeRoomId);
  useActionRequiredSound(
    sonGuessrNeedsAction(snapshot, privateState),
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
