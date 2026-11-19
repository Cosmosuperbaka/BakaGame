import { useContext } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BubbleRefContext } from "@/components/common/chat/BubbleRef";
import { receiptMark } from "@/lib/motion/NamedMoves";
import { iconTappable } from "@/lib/motion/Feedback";
import { Hint } from "@/components/ui/Tooltip";
import { cn } from "@/lib/Utils";
import { STICKER_PREFIX, isValidStickerPath, type StickerLabelIndex } from "@/lib/Stickers";
import { mentionsPlayer, splitMentions } from "@/lib/Mentions";
import type { ChatMessage } from "@bakagame/shared";

/** 提及联想与高亮匹配所需的最小玩家契约 */
export interface ChatMentionPlayer {
  id: string;
  name: string;
}

/** 消息正文：命中房间成员的 `@名字` 高亮，其余按普通文本渲染 */
function MessageText({
  text,
  players,
  isMe,
  isGhost,
}: {
  text: string;
  players: ChatMentionPlayer[];
  isMe: boolean;
  isGhost?: boolean;
}) {
  const segments = splitMentions(text, players);

  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "mention" ? (
          <span
            key={index}
            className={cn(
              "rounded-md px-1 font-medium",
              isMe && !isGhost
                ? "bg-bubble-self-foreground/20"
                : // 他人气泡上主色作文字对比度不足（DesignGuide §3），浅底标出提及，文字保持正文色。
                  "bg-primary/10 text-foreground"
            )}
          >
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </>
  );
}

/**
 * 复读按钮：点击即以当前玩家身份再发一条相同文本，不做计数。
 * 悬停说明走 `Hint`（原生 title 不进设计系统的表面与动效），按下走 `iconTappable`，与图标钮同一档手感。
 */
function RepeatButton({ onRepeat }: { onRepeat: () => void }) {
  return (
    // 说明放在按钮右侧：默认朝上会盖住发言人名字与 ×N 角标
    <Hint label="复读这条消息" side="right">
      <motion.button
        type="button"
        aria-label="复读这条消息"
        {...iconTappable}
        onClick={onRepeat}
        className="absolute bottom-0 left-full ml-1.5 flex h-5 cursor-pointer items-center rounded-full border border-border bg-background/85 px-1.5 font-mono text-2xs leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        +1
      </motion.button>
    </Hint>
  );
}

/** 复读链最前面那条的 ×N 角标：计数变了就重新弹一次。只是视觉，读屏照旧逐条读消息。 */
function RepeatCount({ count, isMe }: { count: number; isMe: boolean }) {
  return (
    <AnimatePresence initial={false}>
      <motion.span
        key={count}
        aria-hidden="true"
        initial={receiptMark.initial}
        animate={receiptMark.animate}
        transition={receiptMark.transition}
        className={cn(
          "pointer-events-none absolute -top-2 flex h-4 items-center rounded-full border border-border bg-background px-1 font-mono text-2xs leading-none tabular-nums text-muted-foreground",
          isMe ? "-left-2" : "-right-2"
        )}
      >
        ×{count}
      </motion.span>
    </AnimatePresence>
  );
}

/** 玩家消息气泡与右侧 +1；按钮绝对定位，不改变气泡宽度或滚动位置。 */
export function MessageBubble({
  message,
  isMe,
  isGhost,
  stickerLabels,
  players,
  myPlayerId,
  showRepeat,
  repeatCount,
  onRepeatMessage,
}: {
  message: ChatMessage;
  isMe: boolean;
  isGhost: boolean;
  stickerLabels: StickerLabelIndex | null;
  players: ChatMentionPlayer[];
  myPlayerId?: string;
  showRepeat: boolean;
  /** 这条是复读链最前面那条时的链长，其余为 0 */
  repeatCount: number;
  onRepeatMessage: (text: string) => Promise<void> | void;
}) {
  const bubbleRef = useContext(BubbleRefContext);
  const isSticker = message.text.startsWith(STICKER_PREFIX);
  const stickerPath = isSticker ? message.text.slice(STICKER_PREFIX.length) : null;
  const safeStickerPath = isValidStickerPath(stickerPath) ? stickerPath : null;
  const mentionsMe =
    !isSticker && Boolean(myPlayerId) && mentionsPlayer(message.text, myPlayerId!, players);

  return (
    <div className="relative w-fit max-w-full">
      <div
        ref={bubbleRef}
        data-testid="chat-message-bubble"
        className={cn(
          "min-w-0 max-w-full whitespace-pre-wrap rounded-xl text-sm leading-relaxed [overflow-wrap:anywhere] transition-colors",
          safeStickerPath ? "p-1.5" : "px-3 py-1.5",
          isMe
            ? isGhost
              ? "rounded-br-sm bg-primary/10 border border-dashed border-primary/40 text-foreground"
              : "rounded-br-sm bg-bubble-self text-bubble-self-foreground shadow-2xs selection:bg-bubble-self-foreground selection:text-bubble-self"
            : isGhost
              ? // 半透明底上再叠透明度会把对比度压到线下，降档用语义色而不是 alpha。
                "rounded-bl-sm bg-muted/40 border border-dashed border-border text-muted-foreground"
              : "rounded-bl-sm bg-muted text-foreground",
          mentionsMe && "ring-1 ring-primary/40"
        )}
      >
        {safeStickerPath ? (
          <img
            src={safeStickerPath}
            // 清单未到或路径不在清单里时退回通用文案，不把 alt 留空
            alt={stickerLabels?.get(safeStickerPath) ?? "表情"}
            className="h-20 w-20 object-contain"
          />
        ) : (
          <MessageText text={message.text} players={players} isMe={isMe} isGhost={isGhost} />
        )}
      </div>
      {repeatCount > 1 ? <RepeatCount count={repeatCount} isMe={isMe} /> : null}
      {showRepeat && !isMe ? (
        <RepeatButton onRepeat={() => void onRepeatMessage(message.text)} />
      ) : null}
    </div>
  );
}
