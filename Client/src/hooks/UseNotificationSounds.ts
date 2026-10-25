import { useEffect, useRef } from "react";
import type { ChatMessage } from "@bakagame/shared";
import { playSound } from "@/lib/SoundEffects";

/**
 * 服务端先推公开快照、再推私有态。快照进入新阶段的一瞬间，私有态可能还是上一阶段的，
 * 直接响会用旧权限误报；留一个稳定窗口，等紧随其后的私有态落地再决定。
 */
const ACTION_SOUND_DELAY_MS = 150;

/**
 * 行动提示只在本地玩家从「无需操作」进入「可以操作」时响一次。
 * 首次进房、重连恢复时当前值只作为基线，不补响。
 */
export function useActionRequiredSound(
  needsAction: boolean,
  roomKey: string | null,
  ready: boolean
): void {
  const previous = useRef<{ roomKey: string; value: boolean } | null>(null);

  useEffect(() => {
    if (!ready || !roomKey) {
      previous.current = null;
      return;
    }
    const last = previous.current;
    if (!last || last.roomKey !== roomKey) {
      previous.current = { roomKey, value: needsAction };
      return;
    }
    if (last.value === needsAction) return;
    previous.current = { roomKey, value: needsAction };
    if (!needsAction) return;
    const timer = window.setTimeout(() => playSound("actionRequired"), ACTION_SOUND_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [needsAction, ready, roomKey]);
}

/**
 * 聊天提示只对「他人、非系统、尚未见过」的消息响一次。
 * 首次进房/重连拿到的历史消息只入基线；同一批多条新消息只响一声。
 */
export function useChatMessageSound(
  messages: readonly ChatMessage[] | null,
  selfPlayerId: string | null,
  roomKey: string | null
): void {
  const previous = useRef<{ roomKey: string; seen: Set<string> } | null>(null);

  useEffect(() => {
    if (!messages || !roomKey) {
      previous.current = null;
      return;
    }
    const last = previous.current;
    const baseline = !last || last.roomKey !== roomKey;
    const seen = baseline ? new Set<string>() : last.seen;
    let incoming = false;
    for (const message of messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      if (!baseline && !message.system && selfPlayerId && message.playerId !== selfPlayerId) {
        incoming = true;
      }
    }
    previous.current = { roomKey, seen };
    if (incoming) playSound("chatMessage");
  }, [messages, roomKey, selfPlayerId]);
}
