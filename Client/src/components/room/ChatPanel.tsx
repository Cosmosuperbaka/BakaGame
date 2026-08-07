import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Smile } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useGame } from "@/contexts/GameContext";
import { cn } from "@/lib/utils";
import { EmojiPicker, STICKER_PREFIX } from "@/components/room/EmojiPicker";

export function ChatPanel() {
  const { state, sendCommand, addToast } = useGame();
  const [text, setText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputBarRef = useRef<HTMLDivElement>(null);
  const chat = state.snapshot?.chat ?? [];
  const myId = state.privateState?.playerId;

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
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className="text-center text-xs text-muted-foreground/70 italic py-1"
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
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                  className={cn("flex flex-col", isMe ? "items-end" : "items-start")}
                >
                  <span className="text-[11px] text-muted-foreground/60 mb-0.5 px-1">
                    {msg.playerName}
                  </span>
                  {isSticker ? (
                    <img
                      src={stickerPath!}
                      alt="贴纸"
                      draggable={false}
                      className="w-20 h-20 object-contain rounded-lg"
                    />
                  ) : (
                    <div
                      className={cn(
                        "max-w-[85%] px-3 py-1.5 text-sm leading-relaxed rounded-2xl break-words",
                        isMe
                          ? "bg-primary text-primary-foreground rounded-br-md"
                          : "bg-muted text-foreground rounded-bl-md"
                      )}
                    >
                      {msg.text}
                    </div>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* 输入区：表情包选择器浮层 + 输入框 */}
      <div ref={inputBarRef} className="relative p-3 border-t flex gap-2 shrink-0">
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
          className="h-9 w-9 shrink-0 rounded-full text-muted-foreground"
          onClick={() => setPickerOpen((v) => !v)}
        >
          <Smile className="h-5 w-5" />
        </Button>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="发送消息..."
          className="flex-1 h-9 rounded-full px-4"
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSend();
            if (e.key === "Escape") setPickerOpen(false);
          }}
          maxLength={200}
        />
        <Button size="icon" className="h-9 w-9 shrink-0 rounded-full" onClick={handleSend}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
