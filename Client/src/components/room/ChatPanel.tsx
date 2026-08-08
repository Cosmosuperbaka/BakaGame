import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Smile } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { duration, ease, spring } from "@/lib/motion";
import { useGameStore } from "@/stores/useGameStore";
import { STICKER_PREFIX } from "@/lib/stickers";
import { cn } from "@/lib/utils";
import { EmojiPicker } from "@/components/room/EmojiPicker";

/** 系统提示：无归属方，从中线撑开 */
const systemMessage = {
  initial: { opacity: 0, scaleY: 0.6 },
  animate: { opacity: 1, scaleY: 1, transition: { duration: duration.base, ease: ease.out } },
  exit: { opacity: 0, transition: { duration: duration.instant } },
};

export function ChatPanel() {
  const sendCommand = useGameStore((s) => s.sendCommand);
  const addToast = useGameStore((s) => s.addToast);
  const chat = useGameStore((s) => s.snapshot?.chat ?? []);
  const myId = useGameStore((s) => s.privateState?.playerId);
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);


  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.length]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText("");
    try {
      await sendCommand("chat.send", { text: trimmed });
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  };

  const handleSendSticker = async (path: string) => {
    try {
      await sendCommand("chat.send", { text: `${STICKER_PREFIX}${path}` });
    } catch (e) {
      addToast((e as { message: string }).message, "error");
    }
  };

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1 px-3 py-3">
        <div className="space-y-2">
          <AnimatePresence initial={false}>
            {chat.map((msg) => {
              const isMe = msg.playerId === myId;
              if (msg.system) {
                return (
                  <motion.div
                    key={msg.id}
                    variants={systemMessage}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    className="py-1 text-center text-xs italic text-muted-foreground/70"
                  >
                    {msg.text}
                  </motion.div>
                );
              }

              const isSticker = msg.text.startsWith(STICKER_PREFIX);
              const stickerPath = isSticker ? msg.text.slice(STICKER_PREFIX.length) : null;

              return (
                <motion.div
                  key={msg.id}
                  layout="position"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.94, transition: { duration: duration.instant } }}
                  transition={spring.swift}
                  style={{ originX: isMe ? 1 : 0, originY: 1 }}
                  className={cn("flex flex-col", isMe ? "items-end" : "items-start")}
                >
                  <span className="text-[11px] text-muted-foreground/60 mb-0.5 px-1">
                    {msg.playerName}
                  </span>
                  <div
                    className={cn(
                      "max-w-[85%] break-words rounded-xl text-sm leading-relaxed",
                      isSticker ? "p-1.5" : "px-3 py-1.5",
                      isMe
                        ? "rounded-br-sm bg-primary text-primary-foreground"
                        : "rounded-bl-sm bg-muted text-foreground"
                    )}
                  >
                    {isSticker ? (
                      <img
                        src={stickerPath!}
                        alt="表情"
                        draggable={false}
                        className="h-20 w-20 object-contain"
                      />
                    ) : (
                      msg.text
                    )}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* 输入区：表情包选择器浮层 + 输入框 */}
      <div className="relative p-3 border-t flex gap-2 shrink-0">
        <EmojiPicker
          open={pickerOpen}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onSelect={handleSendSticker}
          onClose={() => setPickerOpen(false)}
        />
        <Button
          size="icon"
          variant="ghost"
          className="shrink-0 text-muted-foreground"
          onClick={() => setPickerOpen((v) => !v)}
          aria-label="发送表情"
          aria-expanded={pickerOpen}
        >
          <Smile className="h-5 w-5" />
        </Button>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="发送消息..."
          className="flex-1"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSend();
            if (e.key === "Escape") setPickerOpen(false);
          }}
          maxLength={200}
        />
        <Button
          size="icon"
          className="shrink-0"
          onClick={handleSend}
          disabled={!text.trim()}
          aria-label="发送消息"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
