import { useState, useRef, useCallback, useEffect, useId, useMemo } from "react";
import * as Popover from "@radix-ui/react-popover";
import { AnimatePresence, animate, motion, useReducedMotion } from "framer-motion";
import { ArrowDown, AtSign, Send, Smile } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { MessageBubble, type ChatMentionPlayer } from "@/components/common/chat/ChatMessage";
import { trailingRepeatChain } from "@/components/common/chat/RepeatChain";
import {
  MessageShell,
  SendThrow,
  type SendThrowState,
  type ThrowHandle,
  type ThrowHandoff,
} from "@/components/common/chat/ChatThrow";
import { Input } from "@/components/ui/Input";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { EmojiPicker } from "@/components/common/EmojiPicker";
import {
  chatMessageLaunch,
  chatThrow,
  jitterShape,
  optionTappable,
  popover,
  repeatStair,
  stepJitterAnimation,
  systemNotice,
} from "@/lib/Motion";
import { STICKER_PREFIX, loadStickerLabels, type StickerLabelIndex } from "@/lib/Stickers";
import { applyMention, filterMentionCandidates, readMentionQuery } from "@/lib/Mentions";
import { cn } from "@/lib/Utils";
import { useChatDraft } from "@/hooks/UseChatDraft";
import { useStickToBottom } from "@/hooks/UseStickToBottom";
import type { ChatMessage } from "@bakagame/shared";

/** 提及候选一次最多列出的人数，超出靠继续输入收窄 */
const MENTION_LIMIT = 6;

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
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const sendIconRef = useRef<HTMLSpanElement>(null);
  const reducedMotion = useReducedMotion();
  // 发送动画：文字凝成胶囊掷出输入框（thrown），回显到达后自己那条气泡从胶囊手里接过去（handoffId）
  const [thrown, setThrown] = useState<SendThrowState | null>(null);
  const capsuleRef = useRef<ThrowHandle>(null);
  const [pendingEcho, setPendingEcho] = useState<{ baselineId: string | undefined } | null>(null);
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const handoff = useMemo<ThrowHandoff>(
    () => ({ capsule: capsuleRef, onTake: () => setThrown(null) }),
    []
  );
  // 收回动画承诺还给输入框的内容；落点写回，业务确认后撤掉。空串表示只是撤掉胶囊。
  const recalledTextRef = useRef("");
  const recallThrow = useCallback((sent: string) => {
    recalledTextRef.current = sent;
    setThrown((current) => current && { ...current, phase: "recall" });
  }, []);
  // 收回播完：胶囊撤掉，内容在这刻真正回到输入框；之后才到的回显按别人的消息那样弹出。
  const finishRecall = useCallback(() => {
    const recalled = recalledTextRef.current;
    setThrown(null);
    setPendingEcho(null);
    // 玩家已经接着打字就不覆盖他的输入
    setText((current) => (current ? current : recalled));
  }, [setText]);
  /** 一次发送的业务回执：成败只看 promise 有没有正常返回，动画时序不参与判定。 */
  const attemptRef = useRef<{ acked: boolean } | null>(null);
  // 输入框是提及候选的组合框：候选列表与当前高亮项经 id 关联，读屏随上下键读出高亮的名字。
  const mentionListId = useId();
  const mentionOptionId = (index: number) => `${mentionListId}-option-${index}`;
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

  // 本人最新一条消息：发送后它换了，就是这次发送的回显
  const lastMineId = useMemo(
    () => messages.findLast((message) => !message.system && message.playerId === myPlayerId)?.id,
    [messages, myPlayerId]
  );
  // 最新一条玩家消息：只有它可以被 +1；系统提示没有气泡，不算复读对象
  const latestMessageId = useMemo(
    () => messages.findLast((message) => !message.system)?.id,
    [messages]
  );
  const repeatChain = useMemo(() => trailingRepeatChain(messages), [messages]);
  if (pendingEcho && lastMineId && lastMineId !== pendingEcho.baselineId) {
    setHandoffId(lastMineId);
    setPendingEcho(null);
  }

  // 胶囊悬停等回显。等不到时按业务回执分流：ACK 已到只是频道不回显，撤掉胶囊即可；
  // 没 ACK 才把内容收回输入框，别让玩家重打。
  const waitingKey = pendingEcho && thrown?.phase === "fly" ? thrown.key : null;
  const waitingText = thrown?.phase === "fly" ? thrown.text : "";
  useEffect(() => {
    if (waitingKey === null) return;
    const timer = window.setTimeout(
      () => recallThrow(attemptRef.current?.acked ? "" : waitingText),
      chatThrow.waitMs
    );
    return () => window.clearTimeout(timer);
  }, [waitingKey, waitingText, recallThrow]);

  const candidates = useMemo(
    () =>
      mention
        ? filterMentionCandidates(mentionablePlayers, mention.query).slice(0, MENTION_LIMIT)
        : [],
    [mention, mentionablePlayers]
  );

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

  const closeMention = useCallback(() => {
    setMention(null);
    setMentionIndex(0);
  }, []);

  /** 输入时同步提及查询：光标位置决定当前是否正在写一个提及 */
  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setText(next);
      setMention(readMentionQuery(next, event.target.selectionStart ?? next.length));
      setMentionIndex(0);
    },
    [setText]
  );

  /** 光标移动、选区变化时重算提及查询：光标离开 `@` 片段，候选就该收起。 */
  const handleSelect = useCallback((event: React.SyntheticEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    setMention((current) => {
      const next = readMentionQuery(input.value, input.selectionStart ?? input.value.length);
      return next?.query === current?.query && next?.start === current?.start ? current : next;
    });
  }, []);

  /** 选中候选：写回输入框并把光标留在名字之后 */
  const pickMention = useCallback(
    (name: string) => {
      if (!mention) return;
      // 光标在 `@` 之前时 slice(caret) 会把前面的文字又拼一遍，最后一道防线。
      const caret = Math.max(mention.start, inputRef.current?.selectionStart ?? text.length);
      const applied = applyMention(text, mention.start, caret, name);
      setText(applied.value);
      closeMention();
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(applied.caret, applied.caret);
      });
    },
    [mention, text, closeMention, setText]
  );

  /**
   * 记下发送这一刻的输入框位置，把文字掷出去等回显；发送按钮的图标被反冲得逐格抖一下。
   * 返回是否真的掷出：减弱动效或量不到输入框时没有胶囊可收回，失败要把内容直接写回输入框。
   */
  const startThrow = (sent: string) => {
    const input = inputRef.current;
    if (reducedMotion || !input) return false;
    const rect = input.getBoundingClientRect();
    setThrown({
      key: performance.now(),
      text: sent,
      anchor: { left: rect.left, top: rect.top, height: rect.height, maxWidth: rect.width },
      phase: "fly",
    });
    setPendingEcho({ baselineId: lastMineId });
    const icon = sendIconRef.current;
    if (icon) {
      const { keyframes, transition } = stepJitterAnimation(jitterShape.sendRecoil);
      void animate(icon, keyframes, transition);
    }
    return true;
  };

  /**
   * 发送成功只认 ACK：回显晚于等待窗口时内容不曾回到输入框，玩家看不到「没发出去」的假信号。
   * 万一先前已经收回，确认后就撤掉那一条原样文本，避免玩家照着它再发一遍；改过就留给他自己判断。
   */
  const confirmSent = (sent: string) => {
    if (recalledTextRef.current !== sent) return;
    recalledTextRef.current = "";
    setText((current) => (current === sent ? "" : current));
  };

  // 发送序号：胶囊、收回动画与回执只有一份，前一条的失败不能去动后一条的胶囊。
  const sendSeqRef = useRef(0);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const attempt = { acked: false };
    attemptRef.current = attempt;
    const seq = ++sendSeqRef.current;
    // 先清输入框再 await：乐观清除是防重复提交，内容找回来看下面的业务回执
    const flying = startThrow(trimmed);
    setText("");
    closeMention();
    try {
      await onSendMessage(trimmed);
      attempt.acked = true;
      confirmSent(trimmed);
    } catch (error) {
      // 掷出过且胶囊还是这一条的，就交给收回动画，落点把内容写回；
      // 没有动画可走（或胶囊已经换成后一条）时立刻写回，输入框里已有新草稿就不覆盖
      if (flying && seq === sendSeqRef.current) recallThrow(trimmed);
      else setText((current) => (current ? current : trimmed));
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
            <AnimatePresence>
              {candidates.length > 0 && (
                <motion.div
                  variants={popover}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  style={{ originY: 1 }}
                  id={mentionListId}
                  // 点候选不能先让输入框失焦：失焦会把候选收起，点击就落空。
                  onMouseDown={(event) => event.preventDefault()}
                  role="listbox"
                  aria-label="提及玩家"
                  className="absolute bottom-full left-3 right-3 z-dropdown mb-1 overflow-hidden floating-surface shadow-md"
                >
                  {candidates.map((player, index) => (
                    <motion.button
                      key={player.id}
                      id={mentionOptionId(index)}
                      type="button"
                      role="option"
                      aria-selected={index === mentionIndex}
                      // 焦点留在输入框里，候选只经 aria-activedescendant 指向，不进 Tab 序列。
                      tabIndex={-1}
                      {...optionTappable}
                      onMouseEnter={() => setMentionIndex(index)}
                      onClick={() => pickMention(player.name)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                        "border-t first:border-t-0",
                        index === mentionIndex
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground hover:bg-accent hover:text-accent-foreground"
                      )}
                    >
                      <AtSign className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-medium">{player.name}</span>
                    </motion.button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>

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
              onChange={handleChange}
              onSelect={handleSelect}
              onBlur={closeMention}
              placeholder={placeholder}
              className="flex-1"
              data-agent-control="chat.input"
              role="combobox"
              aria-label="聊天消息"
              aria-autocomplete="list"
              aria-expanded={candidates.length > 0}
              aria-controls={candidates.length > 0 ? mentionListId : undefined}
              aria-activedescendant={
                candidates.length > 0 ? mentionOptionId(mentionIndex) : undefined
              }
              onKeyDown={(event) => {
                // 输入法选词的回车只确认候选字，不发送、不选提及。
                if (event.nativeEvent.isComposing) return;
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
