import { useCEEStore } from "@/stores/UseCEEStore";
import { useChatMessageSound } from "@/hooks/UseNotificationSounds";

/** 只负责把 CEE 的聊天更新接到公共提示音；不发 DOM、不参与房间渲染。 */
export function CEESoundBridge() {
  const chat = useCEEStore((state) => state.snapshot?.chat ?? null);
  const selfPlayerId = useCEEStore((state) => state.privateState?.playerId ?? null);
  const roomId = useCEEStore((state) => state.snapshot?.roomId ?? null);
  useChatMessageSound(chat, selfPlayerId, roomId);
  return null;
}
