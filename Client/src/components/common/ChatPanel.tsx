import { useState, useRef, useEffect, useMemo } from "react";
import * as Popover from "@radix-ui/react-popover";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, Send, Smile } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { MessageBubble, type ChatMentionPlayer } from "@/components/common/chat/ChatMessage";
import { MentionList } from "@/components/common/chat/MentionList";
import { trailingRepeatChain } from "@/components/common/chat/RepeatChain";
import { MessageShell, SendThrow } from "@/components/common/chat/ChatThrow";
import { Input } from "@/components/ui/Input";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { EmojiPicker } from "@/components/common/EmojiPicker";
import { chatMessageLaunch, popover, repeatStair, systemNotice } from "@/lib/Motion";
import { STICKER_PREFIX, loadStickerLabels, type StickerLabelIndex } from "@/lib/Stickers";
import { cn } from "@/lib/Utils";
import { useChatDraft } from "@/hooks/UseChatDraft";
import { useChatSend } from "@/hooks/UseChatSend";
import { useMentionInput } from "@/hooks/UseMentionInput";
import { useStickToBottom } from "@/hooks/UseStickToBottom";
import type { ChatMessage } from "@bakagame/shared";

/** 系统提示、阶段提醒与频道说明共用的无背景居中文本 */
const SYSTEM_TEXT =
  "min-w-0 whitespace-pre-wrap py-1 text-center text-xs text-muted-foreground [overflow-wrap:anywhere]";

export interface ChatPanelProps {
  /** 聊天消息列表（按时间戳正序） */
  messages: ChatMessage[];
  /** 房间成员列表（用于 @提及 解析与候选联想匹配） */
  players?: ChatMentionPlayer[];
  /** 当前玩家 ID（用于区分左右气泡与自身高亮） */
  myPlayerId?: string;
  /**
   * 发送文本消息回调。
   * 成功与否只看这个 promise：正常 resolve 即已发出（哪怕回显晚到），reject 才算失败；
   * 调用方自己吞掉异常会让面板以为发送成功，玩家输入的原文就回不到输入框了。
   */
  onSendMessage: (text: string) => Promise<void> | void;
  /** 发送表情包回调（未传入时默认以 STICKER_PREFIX 拼接入 onSendMessage） */
  onSendSticker?: (path: string) => Promise<void> | void;
  /** 发送失败异常处理回调（面板已把原文收回输入框，这里只负责报错） */
  onError?: (error: unknown) => void;
  /** 复读一条别人的消息：点击 +1 直接发送同一条文本（未提供时不渲染按钮）。 */
  onRepeatMessage?: (text: string) => Promise<void> | void;
  /** 频道说明：以系统提示样式固定为消息流第一行，用于交代谁能看到这里的消息 */
  notice?: string;
  /** 输入框占位符，缺省为 "请输入文本" */
  placeholder?: string;
  /** 输入框最大长度，缺省为 200 */
  maxLength?: number;
  /** 外层容器扩展类名 */
  className?: string;
}

export function ChatPanel({
  messages,
  players = [],
  myPlayerId,
  onSendMessage,
  onSendSticker,
  onError,
  onRepeatMessage,
  notice,
  placeholder = "请输入文本",
  maxLength = 200,
  className,
}: ChatPanelProps) {
  const [text, setText] = useChatDraft();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const sendIconRef = useRef<HTMLSpanElement>(null);
  // 只在玩家本来就在底部时跟随；自己发出的那条无论玩家翻到哪都贴底，胶囊交接要落在可见的落点上。
  const lastMessage = messages.at(-1);
  const { viewportRef, contentRef, unseen, scrollToBottom } = useStickToBottom(
    lastMessage?.id,
    Boolean(lastMessage && !lastMessage.system && lastMessage.playerId === myPlayerId)
  );

  // 提及只对照当前房间名单判断，改名或退房不会留下失效标记
  const mentionablePlayers = useMemo(
    () => players.filter((player) => player.id !== myPlayerId),
    [players, myPlayerId]
  );

  const mentionInput = useMentionInput({
    text,
    setText,
    inputRef,
    players: mentionablePlayers,
  });

  const { thrown, capsuleRef, handoff, handoffId, finishRecall, handleSend } = useChatSend({
    messages,
    myPlayerId,
    text,
    setText,
    inputRef,
    sendIconRef,
    onSendMessage,
    onError,
    onSent: mentionInput.close,
  });

  // 最新一条玩家消息：只有它可以被 +1；系统提示没有气泡，不算复读对象
  const latestMessageId = useMemo(
    () => messages.findLast((message) => !message.system)?.id,
    [messages]
  );
  const repeatChain = useMemo(() => trailingRepeatChain(messages), [messages]);

  // 表情的替代文本要用清单里的表情名。清单仍旧按需加载：只在消息里真的出现表情时才取，
  // 没发过表情的房间不为整份清单买单。
  const [stickerLabels, setStickerLabels] = useState<StickerLabelIndex | null>(null);
  const hasSticker = useMemo(
    () => messages.some((message) => !message.system && message.text.startsWith(STICKER_PREFIX)),
    [messages]
  );
  useEffect(() => {
    if (hasSticker && !stickerLabels) void loadStickerLabels().then(setStickerLabels);
  }, [hasSticker, stickerLabels]);

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

  // 连点只放一次请求过网：每次点击都是一条新消息，避免手抖重复发送。
  const repeatInFlight = useRef(false);
  const handleRepeatMessage = async (text: string) => {
    if (!onRepeatMessage || repeatInFlight.current) return;
    repeatInFlight.current = true;
    try {
      await onRepeatMessage(text);
    } catch (error) {
      onError?.(error);
    } finally {
      repeatInFlight.current = false;
    }
  };

  return (
    <div className={cn("flex h-full min-w-0 flex-col overflow-hidden", className)}>
      {/* 内边距留在滚动区之外：滚动内容在内边距处被裁切，与滚动区自己带内边距时不同 */}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden px-3 py-3">
        <ScrollArea ref={viewportRef} className="h-full min-w-0">
          {/* 消息流按 log 播报：只报新到的那几条，不每次把整段历史重读一遍 */}
          <div
            ref={contentRef}
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            // 复读台阶的错开与放大会把整宽的外壳推出右缘：横向裁掉这截空白，不让滚动区长出横向滚动条
            className="min-w-0 space-y-2 overflow-x-clip"
          >
            {notice ? <p className={SYSTEM_TEXT}>{notice}</p> : null}
            <AnimatePresence initial={false}>
              {messages.map((message) => {
                const isMe = message.playerId === myPlayerId;
                const isGhost = message.channel === "ghost";

                // 阶段提醒与系统提示：统一定义为通透无背景居中文本样式
                if (message.system) {
                  return (
                    <motion.div
                      key={message.id}
                      variants={systemNotice}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      className={SYSTEM_TEXT}
                    >
                      {message.text}
                    </motion.div>
                  );
                }

                const takesThrow = handoffId === message.id;
                // 复读链台阶：第几级就向内错开、放大几级；链断了 step 回到 0，按同一条弹簧收回。
                const chainOrder = repeatChain.get(message.id);
                const step = Math.min(chainOrder ?? 0, repeatStair.maxSteps);
                const isChainFront =
                  chainOrder !== undefined && chainOrder === repeatChain.size - 1;

                return (
                  <motion.div
                    key={message.id}
                    layout="position"
                    variants={chatMessageLaunch}
                    // 自己刚发出的那条由 MessageShell 从胶囊手里接过去，外层不再叠一次弹入
                    initial={takesThrow ? false : "initial"}
                    animate="animate"
                    exit="exit"
                    style={{ originX: isMe ? 1 : 0, originY: 1 }}
                    className={cn(
                      "flex w-full min-w-0 flex-col",
                      isMe ? "items-end" : "items-start"
                    )}
                  >
                    {/* 台阶单独占一层：外层管弹入与重排，MessageShell 管接手胶囊，三者的 transform 互不覆盖 */}
                    <motion.div
                      initial={false}
                      animate={{
                        x: (isMe ? -1 : 1) * step * repeatStair.shift,
                        scale: 1 + step * repeatStair.grow,
                      }}
                      transition={repeatStair.transition}
                      style={{ originX: isMe ? 1 : 0, originY: 1 }}
                      className={cn(
                        "flex w-full min-w-0 flex-col",
                        isMe ? "items-end" : "items-start"
                      )}
                    >
                      <MessageShell isMe={isMe} handoff={takesThrow ? handoff : undefined}>
                        <span className="font-sans text-2xs font-normal text-muted-foreground mb-0.5 px-1 select-none">
                          {message.playerName}
                        </span>
                        <MessageBubble
                          message={message}
                          isMe={isMe}
                          isGhost={isGhost}
                          stickerLabels={stickerLabels}
                          players={players}
                          myPlayerId={myPlayerId}
                          showRepeat={Boolean(onRepeatMessage) && message.id === latestMessageId}
                          repeatCount={isChainFront ? repeatChain.size : 0}
                          onRepeatMessage={handleRepeatMessage}
                        />
                      </MessageShell>
                    </motion.div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </ScrollArea>
        {/* 玩家上翻期间来了新消息：给一个回到底部的入口，不替他滚动 */}
        <AnimatePresence>
          {unseen ? (
            <motion.div
              variants={popover}
              initial="initial"
              animate="animate"
              exit="exit"
              style={{ originY: 1 }}
              className="pointer-events-none absolute inset-x-0 bottom-3 z-panel flex justify-center"
            >
              <Button
                size="sm"
                variant="secondary"
                className="pointer-events-auto shadow-md"
                onClick={scrollToBottom}
              >
                <ArrowDown />
                有新消息
              </Button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {/* 底部输入区：表情包选择器浮层 + 提及候选浮层 + 输入框；选择器以这一行为锚点展开 */}
      <Popover.Root open={pickerOpen} onOpenChange={setPickerOpen}>
        <Popover.Anchor asChild>
          <div className="relative p-3 border-t flex gap-2 shrink-0 bg-background">
            <EmojiPicker
              open={pickerOpen}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              onSelect={(path) => {
                void handleSendSticker(path);
                setPickerOpen(false);
              }}
            />

            {/* 候选自输入框上缘展开 */}
            <MentionList
              candidates={mentionInput.candidates}
              activeIndex={mentionInput.activeIndex}
              listId={mentionInput.listId}
              optionId={mentionInput.optionId}
              onPick={mentionInput.pick}
              onHover={mentionInput.setActiveIndex}
            />

            <Popover.Trigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="shrink-0 text-muted-foreground"
                aria-label="发送表情"
              >
                <Smile className="h-5 w-5" />
              </Button>
            </Popover.Trigger>
            <Input
              ref={inputRef}
              value={text}
              onChange={mentionInput.handleChange}
              onSelect={mentionInput.handleSelect}
              onBlur={mentionInput.close}
              placeholder={placeholder}
              className="flex-1"
              data-agent-control="chat.input"
              role="combobox"
              aria-label="聊天消息"
              aria-autocomplete="list"
              aria-expanded={mentionInput.candidates.length > 0}
              aria-controls={mentionInput.candidates.length > 0 ? mentionInput.listId : undefined}
              aria-activedescendant={
                mentionInput.candidates.length > 0
                  ? mentionInput.optionId(mentionInput.activeIndex)
                  : undefined
              }
              onKeyDown={(event) => {
                // 输入法选词的回车只确认候选字，不发送、不选提及。
                if (event.nativeEvent.isComposing) return;
                if (mentionInput.handleKeyDown(event)) return;
                if (event.key === "Enter") void handleSend();
              }}
              maxLength={maxLength}
            />
            {thrown ? (
              <SendThrow
                key={thrown.key}
                ref={capsuleRef}
                text={thrown.text}
                anchor={thrown.anchor}
                phase={thrown.phase}
                onRecalled={finishRecall}
              />
            ) : null}
            <Button
              size="icon"
              className="shrink-0"
              onClick={() => void handleSend()}
              disabled={!text.trim()}
              aria-label="发送消息"
              data-agent-control="chat.send"
            >
              <span ref={sendIconRef} className="inline-flex">
                <Send className="h-4 w-4" />
              </span>
            </Button>
          </div>
        </Popover.Anchor>
      </Popover.Root>
    </div>
  );
}
