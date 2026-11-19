import { useState } from "react";
import type { ChatMessage } from "@bakagame/shared";

/** 最后已读的那条：窗口滚动后它可能已不在列表里，留着时间戳按先后继续数。 */
interface ReadMark {
  id: string;
  createdAt: number;
}

const markOf = (message: ChatMessage | undefined): ReadMark | null =>
  message ? { id: message.id, createdAt: message.createdAt } : null;

/**
 * 聊天收在抽屉里、抽屉关着时攒下的未读条数，属于展示派生，不进 store。
 *
 * 只算别人说的话：系统提示（进出房、阶段播报、频道说明）与自己发的都不算——玩家想知道的是有人说话了。
 * - `messages` 为空值表示还没进房；进房那一刻已有的历史整体算已读，计数从之后的新消息起。
 * - `open` 为真（抽屉开着，或宽屏聊天栏常驻）时把最后一条记为已读，计数归零。
 * - 按「最后已读的那条」往后数；客户端窗口滚掉了那条时，按时间先后继续数。
 */
export function useUnreadCount(
  messages: readonly ChatMessage[] | undefined,
  { open, selfPlayerId }: { open: boolean; selfPlayerId?: string }
): number {
  const last = messages?.at(-1);
  // undefined：还没取基线（不在房里）；null：基线是空房间，之后每条都算。
  const [read, setRead] = useState<ReadMark | null | undefined>(() =>
    messages ? markOf(last) : undefined
  );

  if (!messages) {
    if (read !== undefined) setRead(undefined);
    return 0;
  }
  if (read === undefined || (open && read?.id !== last?.id)) {
    // 渲染期间写回自身状态：React 丢弃这次输出立即重跑，基线与计数同一帧落定。
    const next = markOf(last);
    if (read === undefined || read?.id !== next?.id) setRead(next);
    return 0;
  }
  if (open) return 0;

  let start = 0;
  if (read) {
    const index = messages.findLastIndex((message) => message.id === read.id);
    start =
      index >= 0 ? index + 1 : messages.findIndex((message) => message.createdAt > read.createdAt);
    if (start < 0) return 0;
  }
  let count = 0;
  for (let i = start; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (!message.system && message.playerId !== selfPlayerId) count += 1;
  }
  return count;
}
