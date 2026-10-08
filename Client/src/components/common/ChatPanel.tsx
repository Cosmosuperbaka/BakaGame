import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  type MotionValue,
  type Transition,
} from "framer-motion";
import { AtSign, Send, Smile } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { EmojiPicker } from "@/components/common/EmojiPicker";
import {
  byAxes,
  chatMessageLaunch,
  chatThrow,
  jitterShape,
  optionTappable,
  popover,
  spring,
  springWithVelocity,
  stepJitterAnimation,
  systemNotice,
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

/** 掷出中的胶囊：气泡接手时读它此刻的位置与速度。 */
interface ThrowHandle {
  node: HTMLDivElement | null;
  x: MotionValue<number>;
  y: MotionValue<number>;
}

/** 一次发送的胶囊：起点贴着输入框里的文字。 */
interface SendThrowState {
  key: number;
  text: string;
  anchor: { left: number; top: number; height: number; maxWidth: number };
  /** `fly` 掷出并悬停等回显；`recall` 等不到回显，收回输入框 */
  phase: "fly" | "recall";
}

/** 回显接手胶囊所需的两样东西：胶囊句柄，与接手后撤掉胶囊的回调。 */
interface ThrowHandoff {
  capsule: RefObject<ThrowHandle | null>;
  onTake: () => void;
}

const centerOf = (rect: DOMRect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

/** 气泡接手时相对胶囊的尺寸比；量不到尺寸（未布局）时按原大处理。 */
const handoffScale = (from: number, own: number) =>
  own > 0 ? Math.min(chatThrow.scale.max, Math.max(chatThrow.scale.min, from / own)) : 1;

/**
 * 发送的第一段：输入框里的文字凝成一枚胶囊，被掷到输入区右上方等回显。
 * 两轴推力不同：纵向走 `spring.thrust` 先到，横向走更慢的 `spring.push` 后到，轨迹是一道向右上方弯过去的弧；
 * 掷出的冲量（`chatThrow.impulse`）让主轴尺度鼓起、副轴收窄，起止都是原大，形变只来自初速度，按 thrust / wobble 回弹。
 * 收回时按 `spring.recall` 退回输入框、缩成一道缝。挂在 body 上，不被输入区与列表的滚动区裁切。
 */
function SendThrow({
  ref,
  text,
  anchor,
  phase,
  onRecalled,
}: Omit<SendThrowState, "key"> & { ref: Ref<ThrowHandle>; onRecalled: () => void }) {
  const nodeRef = useRef<HTMLDivElement>(null);
  const vectorRef = useRef({ dx: 0, dy: 0 });
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scaleX = useMotionValue(1);
  const scaleY = useMotionValue(1);
  useImperativeHandle(ref, () => ({ node: nodeRef.current, x, y }), [x, y]);

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    // 落点：升到输入框上方，右缘对齐输入框右缘，靠向自己那一侧的气泡。
    const vector = { dx: Math.max(0, anchor.maxWidth - node.offsetWidth), dy: -anchor.height * chatThrow.lift };
    vectorRef.current = vector;
    const { impulse, launch } = chatThrow;
    const velocity = byAxes(vector, impulse.along, impulse.across);
    const springs = byAxes<Transition>(vector, spring.thrust, spring.wobble);
    const controls = [
      animate(x, vector.dx, springWithVelocity(spring.push, launch, 0, vector.dx)),
      animate(y, vector.dy, springWithVelocity(spring.thrust, launch, 0, vector.dy)),
      animate(scaleX, 1, { ...springs.scaleX, velocity: velocity.scaleX }),
      animate(scaleY, 1, { ...springs.scaleY, velocity: velocity.scaleY }),
    ];
    return () => controls.forEach((control) => control.stop());
  }, [anchor, x, y, scaleX, scaleY]);

  useLayoutEffect(() => {
    if (phase !== "recall") return;
    const shape = byAxes(vectorRef.current, chatThrow.into.along, chatThrow.into.across);
    const controls = [
      animate(x, 0, spring.recall),
      animate(y, 0, spring.recall),
      animate(scaleX, shape.scaleX, spring.recall),
      animate(scaleY, shape.scaleY, spring.recall),
    ];
    void Promise.all(controls.map((control) => control.finished)).then(onRecalled);
    return () => controls.forEach((control) => control.stop());
  }, [phase, x, y, scaleX, scaleY, onRecalled]);

  return createPortal(
    <motion.div
      ref={nodeRef}
      aria-hidden="true"
      className="pointer-events-none fixed z-popover flex items-center truncate rounded-xl rounded-br-sm bg-primary px-3 text-sm text-primary-foreground shadow-2xs"
      style={{ left: anchor.left, top: anchor.top, height: anchor.height, maxWidth: anchor.maxWidth, x, y, scaleX, scaleY }}
    >
      {text}
    </motion.div>,
    document.body,
  );
}

/**
 * 发送的第二段：回显的气泡从胶囊手里接过这条消息。
 * 先藏两帧（`visibility`，不经过透明度）等列表滚到底，再量出胶囊此刻的位置与尺寸，
 * 把气泡摆到胶囊上、继承胶囊的速度，按 thrust / wobble 飞进自己的落点；气泡显形与胶囊撤掉在同一帧。
 */
function useThrowHandoff(ref: RefObject<HTMLDivElement | null>, handoff: ThrowHandoff | undefined) {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !handoff) return;
    node.style.visibility = "hidden";
    let frame = 0;
    let stop: (() => void) | undefined;
    const reset = () => {
      node.style.visibility = "";
      node.style.transform = "";
      node.style.transformOrigin = "";
    };
    const take = () => {
      const capsule = handoff.capsule.current;
      const bubble = node.querySelector<HTMLElement>("[data-testid='chat-message-bubble']");
      if (!capsule?.node || !bubble) {
        node.style.visibility = "";
        return;
      }
      const shell = node.getBoundingClientRect();
      const own = bubble.getBoundingClientRect();
      const from = capsule.node.getBoundingClientRect();
      const ownCenter = centerOf(own);
      const fromCenter = centerOf(from);
      const vector = { dx: fromCenter.x - ownCenter.x, dy: fromCenter.y - ownCenter.y };
      const startScaleX = handoffScale(from.width, own.width);
      const startScaleY = handoffScale(from.height, own.height);
      // 以气泡中心为缩放原点：气泡与胶囊重合，名字随气泡一起被带过来。
      node.style.transformOrigin = `${ownCenter.x - shell.left}px ${ownCenter.y - shell.top}px`;
      const springs = byAxes<Transition>(vector, spring.thrust, spring.wobble);
      const controls = animate(
        node,
        {
          x: [vector.dx, 0],
          y: [vector.dy, 0],
          scaleX: [startScaleX, 1],
          scaleY: [startScaleY, 1],
        },
        {
          x: { ...spring.thrust, velocity: capsule.x.getVelocity() },
          y: { ...spring.thrust, velocity: capsule.y.getVelocity() },
          scaleX: springs.scaleX,
          scaleY: springs.scaleY,
        },
      );
      stop = () => controls.stop();
      void controls.finished.then(reset);
      // animate 在下一帧才写上第一帧；排在它之后再交接，气泡不会在落点上闪现一帧。
      frame = requestAnimationFrame(() => {
        node.style.visibility = "";
        capsule.node!.style.visibility = "hidden";
        handoff.onTake();
      });
    };
    // 两帧：第一帧里自动滚到底（UseAutoScrollToBottom 的 rAF 排在这之后），第二帧量到的才是落点。
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(take);
    });
    return () => {
      cancelAnimationFrame(frame);
      stop?.();
      reset();
    };
  }, [ref, handoff]);
}

/** 气泡外壳：贴合内容宽度，接手胶囊时整体被带过来。 */
function MessageShell({
  handoff,
  isMe,
  children,
}: {
  handoff?: ThrowHandoff;
  isMe: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useThrowHandoff(ref, handoff);
  return (
    <div ref={ref} className={cn("flex min-w-0 max-w-[85%] flex-col", isMe ? "items-end" : "items-start")}>
      {children}
    </div>
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
  const sendIconRef = useRef<HTMLSpanElement>(null);
  const reducedMotion = useReducedMotion();
  // 发送动画：文字凝成胶囊掷出输入框（thrown），回显到达后自己那条气泡从胶囊手里接过去（handoffId）
  const [thrown, setThrown] = useState<SendThrowState | null>(null);
  const capsuleRef = useRef<ThrowHandle>(null);
  const [pendingEcho, setPendingEcho] = useState<{ baselineId: string | undefined } | null>(null);
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const handoff = useMemo<ThrowHandoff>(() => ({ capsule: capsuleRef, onTake: () => setThrown(null) }), []);
  const recallThrow = useCallback(() => setThrown((current) => current && { ...current, phase: "recall" }), []);
  // 收回播完：胶囊撤掉，之后才到的回显按别人的消息那样弹出。
  const finishRecall = useCallback(() => {
    setThrown(null);
    setPendingEcho(null);
  }, []);
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
  if (pendingEcho && lastMineId && lastMineId !== pendingEcho.baselineId) {
    setHandoffId(lastMineId);
    setPendingEcho(null);
  }

  // 胶囊悬停等回显，等不到（频道不回显、网络慢）就收回输入框。
  const waitingKey = pendingEcho && thrown?.phase === "fly" ? thrown.key : null;
  useEffect(() => {
    if (waitingKey === null) return;
    const timer = window.setTimeout(recallThrow, chatThrow.waitMs);
    return () => window.clearTimeout(timer);
  }, [waitingKey, recallThrow]);

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

  /** 记下发送这一刻的输入框位置，把文字掷出去等回显；发送按钮的图标被反冲得逐格抖一下。 */
  const startThrow = (sent: string) => {
    const input = inputRef.current;
    if (reducedMotion || !input) return;
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
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    startThrow(trimmed);
    setText("");
    closeMention();
    try {
      await onSendMessage(trimmed);
    } catch (error) {
      recallThrow();
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
              const takesThrow = handoffId === message.id;

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
                  className={cn("flex w-full min-w-0 flex-col", isMe ? "items-end" : "items-start")}
                >
                  <MessageShell isMe={isMe} handoff={takesThrow ? handoff : undefined}>
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
        >
          <span ref={sendIconRef} className="inline-flex">
            <Send className="h-4 w-4" />
          </span>
        </Button>
      </div>
    </div>
  );
}
