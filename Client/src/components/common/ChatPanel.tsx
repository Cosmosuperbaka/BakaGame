import { useState, useRef, useCallback, useId, useLayoutEffect, useMemo, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, animate, motion, useReducedMotion, type AnimationPlaybackControls } from "framer-motion";
import { AtSign, Send, Smile } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { EmojiPicker } from "@/components/common/EmojiPicker";
import {
  chatMessageLaunch,
  chatSend,
  ease,
  genieKeyframes,
  genieShape,
  optionTappable,
  popover,
  systemNotice,
  type OriginPoint,
} from "@/lib/Motion";
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

/** 系统提示、阶段提醒与频道说明共用的无背景居中文本 */
const SYSTEM_TEXT =
  "min-w-0 whitespace-pre-wrap py-1 text-center text-xs text-muted-foreground [overflow-wrap:anywhere]";

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
  /** 频道说明：以系统提示样式固定为消息流第一行，用于交代谁能看到这里的消息 */
  notice?: string;
  /** 输入框占位符，缺省为 "请输入文本" */
  placeholder?: string;
  /** 输入框最大长度，缺省为 200 */
  maxLength?: number;
  /** 外层容器扩展类名 */
  className?: string;
}

/** 一次发送的飞行：发送按钮中心与按下发送的时刻（`performance.now()`）。 */
interface SendLaunch {
  from: OriginPoint;
  sentAt: number;
}

const centerOf = (rect: DOMRect): OriginPoint => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

/** 起飞前至少留一帧：自动滚到底在下一帧才发生，量早了起点会偏。 */
const MIN_RISE_DELAY_MS = 32;

/**
 * 发送的第二段：回显的气泡从发送按钮里倒出来、飞到自己的位置展开（神灯）。
 * 回显早于收进动作播完时，等它播完再起飞；起飞那一刻才量位置，滚到底之后起点仍对准按钮。
 * 动的是气泡本身（同一个 DOM 元素），列表滚动区会裁掉按钮到列表下缘那一小段，读作从输入区里升起来。
 */
function useLaunchFlight(ref: RefObject<HTMLElement | null>, launch: SendLaunch | undefined) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !launch) return;
    node.style.opacity = "0";
    let controls: AnimationPlaybackControls | undefined;
    const wait = Math.max(MIN_RISE_DELAY_MS, chatSend.collapse * 1000 - (performance.now() - launch.sentAt));
    const timer = window.setTimeout(() => {
      const center = centerOf(node.getBoundingClientRect());
      const vector = { dx: launch.from.x - center.x, dy: launch.from.y - center.y };
      controls = animate(
        node,
        { ...genieKeyframes(vector, false), opacity: [0, 1, 1] },
        { duration: chatSend.rise, ease: ease.out, times: [...genieShape.times] },
      );
      void controls.finished.then(() => {
        node.style.transform = "";
        node.style.clipPath = "";
      });
    }, wait);
    return () => {
      window.clearTimeout(timer);
      controls?.stop();
      node.style.opacity = "";
      node.style.transform = "";
      node.style.clipPath = "";
    };
  }, [ref, launch]);
}

/** 气泡外壳：贴合内容宽度，神灯飞行以它的中心为准。 */
function MessageShell({
  launch,
  isMe,
  children,
}: {
  launch?: SendLaunch;
  isMe: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLaunchFlight(ref, launch);
  return (
    <div ref={ref} className={cn("flex min-w-0 max-w-[85%] flex-col", isMe ? "items-end" : "items-start")}>
      {children}
    </div>
  );
}

/**
 * 发送的第一段：输入框里的文字凝成一枚气泡，被吸进发送按钮（神灯收回）。
 * 输入框此刻已经清空，这枚气泡是文字离开输入框的样子；挂在 body 上，不被输入区裁切。
 */
function SendCollapse({
  text,
  anchor,
  target,
  onDone,
}: {
  text: string;
  anchor: { left: number; top: number; height: number; maxWidth: number };
  target: OriginPoint;
  onDone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const center = centerOf(node.getBoundingClientRect());
    const vector = { dx: target.x - center.x, dy: target.y - center.y };
    const controls = animate(
      node,
      { ...genieKeyframes(vector, true), opacity: [1, 1, 0] },
      { duration: chatSend.collapse, ease: ease.inOut, times: [...genieShape.times] },
    );
    void controls.finished.then(onDone);
    return () => controls.stop();
  }, [target, onDone]);

  return createPortal(
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none fixed z-popover flex items-center truncate rounded-xl rounded-br-sm bg-primary px-3 text-sm text-primary-foreground shadow-2xs"
      style={{ left: anchor.left, top: anchor.top, height: anchor.height, maxWidth: anchor.maxWidth }}
    >
      {text}
    </div>,
    document.body,
  );
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
                // 他人气泡上主色作文字对比度不足（Design §3.1），浅底标出提及，文字保持正文色。
                : "bg-primary/10 text-foreground",
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
  notice,
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
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();
  // 发送动画：先把文字吸进发送按钮（collapse），回显到达后气泡再从按钮飞出（launch）
  const [collapse, setCollapse] = useState<{
    key: number;
    text: string;
    anchor: { left: number; top: number; height: number; maxWidth: number };
    target: OriginPoint;
  } | null>(null);
  const [pendingLaunch, setPendingLaunch] = useState<(SendLaunch & { baselineId: string | undefined }) | null>(null);
  const [launched, setLaunched] = useState<SendLaunch & { id: string } | null>(null);
  const finishCollapse = useCallback(() => setCollapse(null), []);
  // 输入框是提及候选的组合框：候选列表与当前高亮项经 id 关联，读屏随上下键读出高亮的名字。
  const mentionListId = useId();
  const mentionOptionId = (index: number) => `${mentionListId}-option-${index}`;
  const messagesRef = useAutoScrollToBottom(messages.length);

  // 提及只对照当前房间名单判断，改名或退房不会留下失效标记
  const mentionablePlayers = useMemo(
    () => players.filter((player) => player.id !== myPlayerId),
    [players, myPlayerId],
  );

  // 本人最新一条消息：发送后它换了，就是这次发送的回显
  const lastMineId = useMemo(
    () => messages.findLast((message) => !message.system && message.playerId === myPlayerId)?.id,
    [messages, myPlayerId],
  );
  if (pendingLaunch && lastMineId && lastMineId !== pendingLaunch.baselineId) {
    setLaunched({ id: lastMineId, from: pendingLaunch.from, sentAt: pendingLaunch.sentAt });
    setPendingLaunch(null);
  }

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

  /** 记下发送这一刻的输入框与按钮位置，起播收进动作并等待回显起飞。 */
  const startSendFlight = (sent: string) => {
    const input = inputRef.current;
    const button = sendButtonRef.current;
    if (reducedMotion || !input || !button) return;
    const inputRect = input.getBoundingClientRect();
    const target = centerOf(button.getBoundingClientRect());
    setCollapse({
      key: performance.now(),
      text: sent,
      anchor: { left: inputRect.left, top: inputRect.top, height: inputRect.height, maxWidth: inputRect.width },
      target,
    });
    setPendingLaunch({ from: target, sentAt: performance.now(), baselineId: lastMineId });
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    startSendFlight(trimmed);
    setText("");
    closeMention();
    try {
      await onSendMessage(trimmed);
    } catch (error) {
      setPendingLaunch(null);
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
                  // 自己刚发出的那条由 MessageShell 从发送按钮飞出，外层不再叠一次弹入
                  initial={launched?.id === message.id ? false : "initial"}
                  animate="animate"
                  exit="exit"
                  style={{ originX: isMe ? 1 : 0, originY: 1 }}
                  className={cn("flex w-full min-w-0 flex-col", isMe ? "items-end" : "items-start")}
                >
                  <MessageShell isMe={isMe} launch={launched?.id === message.id ? launched : undefined}>
                  <span className="font-sans text-2xs font-normal text-muted-foreground mb-0.5 px-1 select-none">
                    {message.playerName}
                  </span>
                  <div
                    data-testid="chat-message-bubble"
                    className={cn(
                      "min-w-0 max-w-full whitespace-pre-wrap rounded-xl text-sm leading-relaxed [overflow-wrap:anywhere] transition-colors",
                      safeStickerPath ? "p-1.5" : "px-3 py-1.5",
                      isMe
                        ? isGhost
                          ? "rounded-br-sm bg-primary/10 border border-dashed border-primary/40 text-foreground"
                          : "rounded-br-sm bg-primary text-primary-foreground shadow-2xs selection:bg-primary-foreground selection:text-primary"
                        : isGhost
                          ? "rounded-bl-sm bg-muted/40 border border-dashed border-border text-foreground/85"
                          : "rounded-bl-sm bg-muted text-foreground",
                      mentionsMe && "ring-1 ring-primary/40",
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
                  </MessageShell>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </ScrollArea>

      {/* 底部输入区：表情包选择器浮层 + 提及候选浮层 + 输入框 */}
      <div className="relative p-3 border-t flex gap-2 shrink-0 bg-background">
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
              id={mentionListId}
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
          role="combobox"
          aria-label="聊天消息"
          aria-autocomplete="list"
          aria-expanded={candidates.length > 0}
          aria-controls={candidates.length > 0 ? mentionListId : undefined}
          aria-activedescendant={candidates.length > 0 ? mentionOptionId(mentionIndex) : undefined}
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
            if (event.key === "Escape") setPickerOpen(false);
          }}
          maxLength={maxLength}
        />
        {collapse ? (
          <SendCollapse
            key={collapse.key}
            text={collapse.text}
            anchor={collapse.anchor}
            target={collapse.target}
            onDone={finishCollapse}
          />
        ) : null}
        <Button
          ref={sendButtonRef}
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
