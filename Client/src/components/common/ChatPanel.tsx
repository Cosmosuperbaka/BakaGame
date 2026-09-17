import { useState, useRef, useCallback, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AtSign, Send, Smile } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { EmojiPicker } from "@/components/common/EmojiPicker";
import { chatMessageLaunch, duration, ease, popover, tappable } from "@/lib/Motion";
import { STICKER_PREFIX, isValidStickerPath } from "@/lib/Stickers";
import {
  applyMention,
  filterMentionCandidates,
  mentionsPlayer,
  readMentionQuery,
  splitMentions,
} from "@/lib/Mentions";
import { cn } from "@/lib/Utils";
import { useAutoScrollToBottom } from "@/hooks/UseAutoScrollToBottom";
import type { ChatMessage } from "@/types";

/** 提及候选一次最多列出的人数，超出靠继续输入收窄 */
const MENTION_LIMIT = 6;

/** 系统提示 / 阶段提醒动效：从中线展开 */
const systemMessage = {
  initial: { opacity: 0, scaleY: 0.6 },
  animate: { opacity: 1, scaleY: 1, transition: { duration: duration.base, ease: ease.out } },
  exit: { opacity: 0, transition: { duration: duration.instant } },
};

/** 提及联想与高亮匹配所需的最小玩家契约 */
export interface ChatMentionPlayer {
  id: string;
  name: string;
}

export interface ChatPanelProps {
  /** 聊天消息列表（按时间戳正序） */
  messages: ChatMessage[];
  /** 房间成员列表（用于 @提及 解析与候选联想匹配） */
  players?: ChatMentionPlayer[];
  /** 当前玩家 ID（用于区分左右气泡与自身高亮） */
  myPlayerId?: string;
  /** 发送文本消息回调 */
  onSendMessage: (text: string) => Promise<void> | void;
  /** 发送表情包回调（未传入时默认以 STICKER_PREFIX 拼接入 onSendMessage） */
  onSendSticker?: (path: string) => Promise<void> | void;
  /** 发送失败异常处理回调 */
  onError?: (error: unknown) => void;
  /** 输入框占位符，缺省为 "请输入文本" */
  placeholder?: string;
  /** 输入框最大长度，缺省为 200 */
  maxLength?: number;
  /** 外层容器扩展类名 */
  className?: string;
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
                ? "bg-primary-foreground/20"
                : "bg-primary/12 text-primary",
            )}
          >
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export function ChatPanel({
  messages,
  players = [],
  myPlayerId,
  onSendMessage,
  onSendSticker,
  onError,
  placeholder = "请输入文本",
  maxLength = 200,
  className,
}: ChatPanelProps) {
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(0);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useAutoScrollToBottom(messages.length);

  // 提及只对照当前房间名单判断，改名或退房不会留下失效标记
  const mentionablePlayers = useMemo(
    () => players.filter((player) => player.id !== myPlayerId),
    [players, myPlayerId],
  );

  const candidates = useMemo(
    () =>
      mention
        ? filterMentionCandidates(mentionablePlayers, mention.query).slice(0, MENTION_LIMIT)
        : [],
    [mention, mentionablePlayers],
  );

  const closeMention = useCallback(() => {
    setMention(null);
    setMentionIndex(0);
  }, []);

  /** 输入时同步提及查询：光标位置决定当前是否正在写一个提及 */
  const handleChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setText(next);
    setMention(readMentionQuery(next, event.target.selectionStart ?? next.length));
    setMentionIndex(0);
  }, []);

  /** 选中候选：写回输入框并把光标留在名字之后 */
  const pickMention = useCallback(
    (name: string) => {
      if (!mention) return;
      const caret = inputRef.current?.selectionStart ?? text.length;
      const applied = applyMention(text, mention.start, caret, name);
      setText(applied.value);
      closeMention();
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(applied.caret, applied.caret);
      });
    },
    [mention, text, closeMention],
  );

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText("");
    closeMention();
    try {
      await onSendMessage(trimmed);
    } catch (error) {
      onError?.(error);
    }
  };

  const handleSendSticker = async (path: string) => {
    try {
      if (onSendSticker) {
        await onSendSticker(path);
      } else {
        await onSendMessage(`${STICKER_PREFIX}${path}`);
      }
    } catch (error) {
      onError?.(error);
    }
  };

  return (
    <div className={cn("flex h-full min-w-0 flex-col overflow-hidden", className)}>
      <ScrollArea className="min-h-0 min-w-0 flex-1 px-3 py-3">
        <div ref={messagesRef} className="min-w-0 space-y-2">
          <AnimatePresence initial={false}>
            {messages.map((message) => {
              const isMe = message.playerId === myPlayerId;
              const isGhost = message.channel === "ghost";

              // 阶段提醒与系统提示：统一定义为通透无背景居中文本样式
              if (message.system) {
                return (
                  <motion.div
                    key={message.id}
                    variants={systemMessage}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className="min-w-0 whitespace-pre-wrap py-1 text-center text-xs text-muted-foreground/70 [overflow-wrap:anywhere]"
                  >
                    {message.text}
                  </motion.div>
                );
              }

              const isSticker = message.text.startsWith(STICKER_PREFIX);
              const stickerPath = isSticker ? message.text.slice(STICKER_PREFIX.length) : null;
              const safeStickerPath = isValidStickerPath(stickerPath) ? stickerPath : null;
              const mentionsMe =
                !isSticker && Boolean(myPlayerId) && mentionsPlayer(message.text, myPlayerId!, players);

              return (
                <motion.div
                  key={message.id}
                  layout="position"
                  variants={chatMessageLaunch}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  style={{ originX: isMe ? 1 : 0, originY: 1 }}
                  className={cn("flex w-full min-w-0 flex-col", isMe ? "items-end" : "items-start")}
                >
                  <span className="font-sans text-[11px] font-normal text-muted-foreground/70 mb-0.5 px-1 select-none">
                    {message.playerName}
                  </span>
                  <div
                    data-testid="chat-message-bubble"
                    className={cn(
                      "min-w-0 max-w-[85%] whitespace-pre-wrap rounded-xl text-sm leading-relaxed [overflow-wrap:anywhere] transition-colors",
                      safeStickerPath ? "p-1.5" : "px-3 py-1.5",
                      isMe
                        ? isGhost
                          ? "rounded-br-sm bg-stone-500/15 border border-dashed border-stone-400/50 dark:border-stone-500/50 text-foreground"
                          : "rounded-br-sm bg-primary text-primary-foreground shadow-2xs"
                        : isGhost
                          ? "rounded-bl-sm bg-muted/40 border border-dashed border-border/80 text-foreground/85"
                          : "rounded-bl-sm bg-muted text-foreground",
                      mentionsMe && "ring-1 ring-primary/45",
                    )}
                  >
                    {safeStickerPath ? (
                      <img
                        src={safeStickerPath}
                        alt="表情"
                        className="h-20 w-20 object-contain"
                      />
                    ) : (
                      <MessageText
                        text={message.text}
                        players={players}
                        isMe={isMe}
                        isGhost={isGhost}
                      />
                    )}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </ScrollArea>

      {/* 底部输入区：表情包选择器浮层 + 提及候选浮层 + 输入框 */}
      <div className="relative p-3 border-t flex gap-2 shrink-0 bg-background/50">
        <EmojiPicker
          open={pickerOpen}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onSelect={handleSendSticker}
          onClose={() => setPickerOpen(false)}
        />

        {/* 候选自输入框上缘展开 */}
        <AnimatePresence>
          {candidates.length > 0 && (
            <motion.div
              variants={popover}
              initial="initial"
              animate="animate"
              exit="exit"
              style={{ originY: 1 }}
              role="listbox"
              aria-label="提及玩家"
              className="absolute bottom-full left-3 right-3 z-50 mb-1 overflow-hidden rounded-md border bg-background/95 shadow-lg backdrop-blur-md"
            >
              {candidates.map((player, index) => (
                <motion.button
                  key={player.id}
                  type="button"
                  role="option"
                  aria-selected={index === mentionIndex}
                  {...tappable}
                  onMouseEnter={() => setMentionIndex(index)}
                  onClick={() => pickMention(player.name)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                    "border-t first:border-t-0",
                    index === mentionIndex
                      ? "bg-accent text-accent-foreground"
                      : "text-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <AtSign className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-medium">{player.name}</span>
                </motion.button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <Button
          size="icon"
          variant="ghost"
          className="shrink-0 text-muted-foreground"
          onClick={() => setPickerOpen((open) => !open)}
          aria-label="发送表情"
          aria-expanded={pickerOpen}
        >
          <Smile className="h-5 w-5" />
        </Button>
        <Input
          ref={inputRef}
          value={text}
          onChange={handleChange}
          placeholder={placeholder}
          className="flex-1"
          aria-expanded={candidates.length > 0}
          onKeyDown={(event) => {
            if (candidates.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setMentionIndex((cur) => (cur + 1) % candidates.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setMentionIndex((cur) => (cur - 1 + candidates.length) % candidates.length);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                pickMention(candidates[mentionIndex].name);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                closeMention();
                return;
              }
            }
            if (event.key === "Enter") void handleSend();
            if (event.key === "Escape") setPickerOpen(false);
          }}
          maxLength={maxLength}
        />
        <Button
          size="icon"
          className="shrink-0"
          onClick={() => void handleSend()}
          disabled={!text.trim()}
          aria-label="发送消息"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
