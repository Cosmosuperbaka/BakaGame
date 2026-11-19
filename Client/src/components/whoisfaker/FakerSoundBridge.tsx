import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useRoomSounds } from "@/hooks/UseRoomSounds";
import { whoIsFakerNeedsAction } from "@/lib/WhoIsFakerActionSignals";

/** 只负责把谁是卧底的行动态与聊天更新接到公共提示音。 */
export function FakerSoundBridge() {
  const snapshot = useWhoIsFakerStore((state) => state.snapshot);
  const privateState = useWhoIsFakerStore((state) => state.privateState);
  const storeRoomId = useWhoIsFakerStore((state) => state.roomId);
  useRoomSounds({
    roomId: snapshot?.roomId ?? null,
    storeRoomId,
    chat: snapshot?.chat ?? null,
    selfPlayerId: privateState?.playerId ?? null,
    hasSnapshotAndPrivate: Boolean(snapshot && privateState),
    needsAction: whoIsFakerNeedsAction(snapshot, privateState),
  });
  return null;
}
