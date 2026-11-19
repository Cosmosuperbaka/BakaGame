import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { useRoomSounds } from "@/hooks/UseRoomSounds";
import { sonGuessrNeedsAction } from "@/lib/SonGuessrActionSignals";

/** 只负责把猜歌的行动态与聊天更新接到公共提示音。 */
export function SongSoundBridge() {
  const snapshot = useSonGuessrStore((state) => state.snapshot);
  const privateState = useSonGuessrStore((state) => state.privateState);
  const storeRoomId = useSonGuessrStore((state) => state.roomId);
  useRoomSounds({
    roomId: snapshot?.roomId ?? null,
    storeRoomId,
    chat: snapshot?.chat ?? null,
    selfPlayerId: privateState?.playerId ?? null,
    hasSnapshotAndPrivate: Boolean(snapshot && privateState),
    needsAction: sonGuessrNeedsAction(snapshot, privateState),
  });
  return null;
}
