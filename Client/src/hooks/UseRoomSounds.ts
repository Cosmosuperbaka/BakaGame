import type { ChatMessage } from "@bakagame/shared";
import { useActionRequiredSound, useChatMessageSound } from "@/hooks/UseNotificationSounds";

/**
 * 三款玩法共用的房间提示音组合。去重、冷却与稳定窗口都在 UseNotificationSounds 里，
 * 这里只把各玩法的快照字段接成同一组入参，差异以参数表达。
 */
export function useRoomSounds(input: {
  roomId: string | null;
  storeRoomId: string | null;
  chat: readonly ChatMessage[] | null;
  selfPlayerId: string | null;
  hasSnapshotAndPrivate: boolean;
  /** CEE 传 null：没有行动提示音。 */
  needsAction: boolean | null;
}): void {
  const ready = input.hasSnapshotAndPrivate && input.roomId === input.storeRoomId;
  useActionRequiredSound(input.needsAction ?? false, input.roomId, ready);
  useChatMessageSound(input.chat, input.selfPlayerId, input.roomId);
}
