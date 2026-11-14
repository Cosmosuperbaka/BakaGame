import { useCEEStore } from "@/stores/UseCEEStore";
import { useRoomSounds } from "@/hooks/UseRoomSounds";

/** 只负责把 CEE 的聊天更新接到公共提示音；不发 DOM、不参与房间渲染。 */
export function CEESoundBridge() {
  const chat = useCEEStore((state) => state.snapshot?.chat ?? null);
  const selfPlayerId = useCEEStore((state) => state.privateState?.playerId ?? null);
  const roomId = useCEEStore((state) => state.snapshot?.roomId ?? null);
  const storeRoomId = useCEEStore((state) => state.roomId);
  const hasSnapshotAndPrivate = useCEEStore((state) =>
    Boolean(state.snapshot && state.privateState)
  );
  useRoomSounds({
    roomId,
    storeRoomId,
    chat,
    selfPlayerId,
    hasSnapshotAndPrivate,
    needsAction: null,
  });
  return null;
}
