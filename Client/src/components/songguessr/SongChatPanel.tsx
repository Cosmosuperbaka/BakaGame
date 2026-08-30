import { useState, useRef, useCallback, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AtSign, Send, Smile } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { EmojiPicker } from "@/components/common/EmojiPicker";
import { duration, ease, popover, spring, tappable } from "@/lib/Motion";
import { STICKER_PREFIX, isValidStickerPath } from "@/lib/Stickers";
import {
  applyMention,
  filterMentionCandidates,
  mentionsPlayer,
  readMentionQuery,
  splitMentions,
} from "@/lib/Mentions";
import { cn } from "@/lib/Utils";
import { useSonGuessrStore as useSongGuessrStore } from "@/stores/UseSonGuessrStore";
import { useAutoScrollToBottom } from "@/hooks/UseAutoScrollToBottom";

/** 提及候选一次最多列出的人数，超出靠继续输入收窄 */
const MENTION_LIMIT = 6;

const systemMessage = {
  initial: { opacity: 0, scaleY: 0.6 },
  animate: { opacity: 1, scaleY: 1, transition: { duration: duration.base, ease: ease.out } },
  exit: { opacity: 0, transition: { duration: duration.instant } },
};

/** 消息正文：命中房间成员的 `@名字` 高亮，其余按普通文本渲染。 */
function MessageText({
  text,
  players,
  isMe,
}: {
  text: string;
  players: Array<{ id: string; name: string }>;
  isMe: boolean;
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
              isMe ? "bg-primary-foreground/20" : "bg-primary/12 text-primary",
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

export function SongChatPanel() {
  const sendCommand = useSongGuessrStore((state) => state.sendCommand);
  const setNotice = useSongGuessrStore((state) => state.setNotice);
  const chat = useSongGuessrStore((state) => state.snapshot?.chat ?? []);
  const players = useSongGuessrStore((state) => state.snapshot?.players);
  const myId = useSongGuessrStore((state) => state.privateState?.playerId);
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(0);
  // 提及候选：null 表示当前没在输入提及
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useAutoScrollToBottom(chat.length);

  // 提及只对照当前房间名单判断，改名或退房不会留下失效标记。
  const mentionablePlayers = useMemo(
    () => (players ?? []).filter((player) => player.id !== myId),
    [players, myId],
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

  /** 输入时同步提及查询：光标位置决定当前是否正在写一个提及。 */
  const handleChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setText(next);
    setMention(readMentionQuery(next, event.target.selectionStart ?? next.length));
    setMentionIndex(0);
  }, []);

  /** 选中候选：写回输入框并把光标留在名字之后。 */
  const pickMention = useCallback(
    (name: string) => {
      if (!mention) return;
      const caret = inputRef.current?.selectionStart ?? text.length;
      const applied = applyMention(text, mention.start, caret, name);
      setText(applied.value);
      closeMention();
      // 写回后光标要落在插入内容之后，否则继续输入会插在中间。
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
      await sendCommand("song.chat.send", { text: trimmed });
    } catch (error) {
      setNotice((error as { message: string }).message, "error");
    }
  };

  const handleSendSticker = async (path: string) => {
    try {
      await sendCommand("song.chat.send", { text: `${STICKER_PREFIX}${path}` });
    } catch (error) {
      setNotice((error as { message: string }).message, "error");
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <ScrollArea className="min-h-0 min-w-0 flex-1 px-3 py-3">
        <div ref={messagesRef} className="min-w-0 space-y-2">
          <AnimatePresence initial={false}>
            {chat.map((message) => {
              const isMe = message.playerId === myId;
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
              // 被点到名的消息加一圈描边，便于在滚动中回头找到
              const mentionsMe =
                !isSticker && Boolean(myId) && mentionsPlayer(message.text, myId!, players ?? []);

              return (
                <motion.div
                  key={message.id}
                  layout="position"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.94, transition: { duration: duration.instant } }}
                  transition={spring.swift}
                  style={{ originX: isMe ? 1 : 0, originY: 1 }}
                  className={cn("flex w-full min-w-0 flex-col", isMe ? "items-end" : "items-start")}
                >
                  <span className="text-[11px] text-muted-foreground/60 mb-0.5 px-1">
                    {message.playerName}
                  </span>
                  <div
                    className={cn(
                      "min-w-0 max-w-[85%] whitespace-pre-wrap rounded-xl text-sm leading-relaxed [overflow-wrap:anywhere]",
                      safeStickerPath ? "p-1.5" : "px-3 py-1.5",
                      isMe
                        ? "rounded-br-sm bg-primary text-primary-foreground"
                        : "rounded-bl-sm bg-muted text-foreground",
                      mentionsMe && "ring-1 ring-primary/45",
                    )}
                  >
                    {safeStickerPath ? (
                      <img
                        src={safeStickerPath}
                        alt="表情"
                        draggable={false}
                        className="h-20 w-20 object-contain"
                      />
                    ) : (
                      <MessageText text={message.text} players={players ?? []} isMe={isMe} />
                    )}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </ScrollArea>

      <div className="relative p-3 border-t flex gap-2 shrink-0">
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
              className="absolute bottom-full left-3 right-3 z-50 mb-1 overflow-hidden rounded-xl border bg-background/95 shadow-lg backdrop-blur-md"
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
          placeholder="发送消息..."
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
          maxLength={200}
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
