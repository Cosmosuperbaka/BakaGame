import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Bot } from "lucide-react";
import type { AgentFocusEvent } from "@bakagame/shared";
import { useWhoIsFakerStore } from "@/stores/UseWhoIsFakerStore";
import { useSonGuessrStore } from "@/stores/UseSonGuessrStore";
import { useCEEStore } from "@/stores/UseCEEStore";

type GameId = "faker" | "song" | "cee";

const KIND_LABELS: Record<string, string> = {
  lobby: "正在查看大厅",
  enter_room: "已进入房间",
  state: "正在查看房间状态",
  private_state: "正在查看自己的身份",
  record: "正在查看结算",
  song_search: "正在检索歌曲/番剧",
  song_audio: "正在听本回合音频",
  cee_search: "正在检索角色资料",
  vote: "正在投票",
  describe: "正在发言",
  submit_words: "正在提交出题词语",
  submit_song: "正在提交出题歌曲",
  guess: "正在作答",
  set_answer: "正在设置谜底",
  image_hint: "正在查看角色提示",
  chat: "正在发送聊天",
  settings: "正在修改房间设置",
  claim: "已接管座位",
  action: "正在操作",
};

const ACTION_LABELS: Record<string, string> = {
  focus: "正在看",
  type: "正在输入",
  press: "正在按键",
  click: "正在点击",
  set: "正在设置",
};

const PART_SELECTOR: Record<string, string> = {
  header: '[data-room-part="header"]',
  player: '[data-room-part="player"]',
  game: '[data-room-part="game"]',
  chat: '[data-room-part="chat"]',
  settings: '[data-agent-focus="settings"]',
  dialog: '[role="dialog"]',
};

const KIND_SELECTOR: Record<string, string> = {
  private_state: '[data-agent-focus="private"]',
  vote: '[data-room-part="player"]',
  chat: '[data-room-part="chat"]',
  settings: '[data-agent-focus="settings"]',
};

const useAgentFocus = (game: GameId): AgentFocusEvent | null => {
  const faker = useWhoIsFakerStore((state) => state.agentFocus);
  const song = useSonGuessrStore((state) => state.agentFocus);
  const cee = useCEEStore((state) => state.agentFocus);
  return game === "faker" ? faker : game === "song" ? song : cee;
};

interface BoxRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const visibleTarget = (element: HTMLElement | null): HTMLElement | null => {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return null;
  return getComputedStyle(element).visibility === "hidden" ? null : element;
};

const allControls = (id: string): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>("[data-agent-control]")].filter(
    (element) => element.dataset.agentControl === id
  );

const findControl = (id: string): HTMLElement | null =>
  allControls(id)
    .map((element) => visibleTarget(element))
    .find((element): element is HTMLElement => element !== null) ?? null;

/** 绕过 React 的受控值追踪，让 Agent 键入的文字真正落进玩家页面里的输入框。 */
const setNativeInputValue = (element: HTMLElement, value: string) => {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
  if (!prototype) return;
  if ((element as HTMLInputElement | HTMLTextAreaElement).value === value) return;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set?.bind(element);
  if (!setter) return;
  setter(value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

const clearInput = (controlId: string) => {
  for (const element of allControls(controlId)) setNativeInputValue(element, "");
};

/** 把服务端逐字上报的输入回放进真实的输入框；点击发送后像人类一样清空。 */
const applyAgentInput = (focus: AgentFocusEvent) => {
  const controlId = focus.controlId;
  if (!controlId) return;
  if (focus.action === "type" && typeof focus.input === "string") {
    for (const element of allControls(controlId))
      setNativeInputValue(element, focus.input);
    return;
  }
  if (focus.action !== "click") return;
  if (controlId === "chat.send") clearInput("chat.input");
  else if (controlId === "faker.description.send") clearInput("faker.description.input");
  else if (controlId === "faker.words.submit") {
    clearInput("faker.word.civilian");
    clearInput("faker.word.undercover");
    clearInput("faker.word.blankHint");
  } else if (controlId.startsWith("song.guess.search.result.")) {
    clearInput("song.guess.search.input");
  } else if (controlId.startsWith("cee.guess.search.result.")) {
    clearInput("cee.guess.search.input");
  } else if (controlId === "cee.answer.confirm") {
    for (let index = 0; index < 3; index += 1) clearInput(`cee.answer.hint.${index}`);
    clearInput("cee.answer.search.input");
  }
};

/**
 * 搜索结果行在玩家页面里是 Popover 内容，未聚焦时不会挂载；
 * 此时把焦点退回同一条搜索栏的输入框，至少框住 Agent 正在操作的那一组控件。
 */
const searchInputOf = (controlId: string): string | undefined => {
  const marker = controlId.indexOf(".search.");
  if (marker < 0) return undefined;
  return `${controlId.slice(0, marker + ".search".length)}.input`;
};

/** 优先按服务端控件 id 精确命中；没有标记时退回区域，再退回旧的 kind 映射。 */
const resolveTarget = (focus: AgentFocusEvent): HTMLElement | null => {
  if (focus.controlId) {
    const exact = findControl(focus.controlId);
    if (exact) return exact;
    const searchInput = searchInputOf(focus.controlId);
    if (searchInput) {
      const input = findControl(searchInput);
      if (input) return input;
    }
  }
  const part = focus.part ? PART_SELECTOR[focus.part] : undefined;
  if (part) {
    const visible = visibleTarget(document.querySelector<HTMLElement>(part));
    if (visible) return visible;
  }
  const kind = KIND_SELECTOR[focus.kind];
  if (kind) {
    const visible = visibleTarget(document.querySelector<HTMLElement>(kind));
    if (visible) return visible;
  }
  return visibleTarget(document.querySelector<HTMLElement>('[data-room-part="game"]'));
};

const measure = (target: HTMLElement): BoxRect => {
  const rect = target.getBoundingClientRect();
  const padding = 7;
  const left = Math.max(4, rect.left - padding);
  const top = Math.max(4, rect.top - padding);
  return {
    top,
    left,
    width: Math.max(0, Math.min(window.innerWidth - left - 4, rect.width + padding * 2)),
    height: Math.max(0, Math.min(window.innerHeight - top - 4, rect.height + padding * 2)),
  };
};

/**
 * 局内 Agent 操作追踪：控件级焦点框 + 跟随操作区的状态条。
 *
 * 焦点框在两个控件之间平滑变形移动；输入内容回放进真实输入框，和人类键入一致。
 * 输入进度只来自接管座位的人类查看器（服务端只发给该座位），同房其他玩家看不到。
 */
export function AgentFocusOverlay({ game }: { game: GameId }) {
  const focus = useAgentFocus(game);
  const visibleFocus = useVisibleFocus(focus);
  const [rect, setRect] = useState<BoxRect | null>(null);
  const [animateMove, setAnimateMove] = useState(false);
  const targetRef = useRef<HTMLElement | null>(null);
  const lastControlRef = useRef<string | undefined>(undefined);
  const hadRectRef = useRef(false);

  useEffect(() => {
    if (!visibleFocus) {
      targetRef.current = null;
      lastControlRef.current = undefined;
      hadRectRef.current = false;
      return;
    }
    applyAgentInput(visibleFocus);
    if (lastControlRef.current !== visibleFocus.controlId) {
      // 控件变了才重新找目标；同一控件内的连续打字事件只更新内容。
      lastControlRef.current = visibleFocus.controlId;
      targetRef.current = null;
    }
    let frame = 0;
    let observer: ResizeObserver | undefined;

    const update = () => {
      let target = visibleTarget(targetRef.current);
      if (!target) {
        target = resolveTarget(visibleFocus);
        targetRef.current = target;
        if (target) {
          const initial = target.getBoundingClientRect();
          if (initial.top < 0 || initial.bottom > window.innerHeight) {
            target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
          }
          observer?.disconnect();
          observer = new ResizeObserver(update);
          observer.observe(target);
        }
      }
      if (!target) {
        setRect(null);
        return;
      }
      const next = measure(target);
      setRect((current) => {
        if (
          current &&
          current.top === next.top &&
          current.left === next.left &&
          current.width === next.width &&
          current.height === next.height
        )
          return current;
        if (!hadRectRef.current) {
          // 第一次出现直接落在目标上，只做淡入；之后换控件才启用位置过渡。
          hadRectRef.current = true;
          setAnimateMove(false);
          window.requestAnimationFrame(() => setAnimateMove(true));
        }
        return next;
      });
    };

    const start = () => {
      update();
      frame = window.requestAnimationFrame(update);
    };
    start();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [visibleFocus]);

  const shown = useMemo(() => {
    if (!visibleFocus) return null;
    const action = visibleFocus.action ? ACTION_LABELS[visibleFocus.action] : undefined;
    const label = visibleFocus.label ?? KIND_LABELS[visibleFocus.kind] ?? "正在操作";
    return action ? `${action} · ${label}` : label;
  }, [visibleFocus]);

  if (!visibleFocus) return null;

  // 状态条贴着 Agent 正在操作的那块区域居中：优先放在框上方，顶部放不下时落到框下方。
  const hudLeft = rect
    ? Math.min(Math.max(rect.left + rect.width / 2, 150), Math.max(150, window.innerWidth - 150))
    : window.innerWidth / 2;
  const hudTop = rect
    ? rect.top > 56
      ? rect.top - 34
      : Math.min(window.innerHeight - 36, rect.top + rect.height + 8)
    : 72;

  return createPortal(
    <>
      <div
        className="agent-focus-hud pointer-events-none fixed z-[81] -translate-x-1/2"
        style={{ left: hudLeft, top: hudTop }}
      >
        <motion.div
          role="status"
          aria-live="polite"
          layout
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className="flex max-w-[min(34rem,calc(100vw-2rem))] items-center gap-1.5 whitespace-nowrap rounded-full border border-primary/40 bg-card/95 px-2.5 py-1 text-[11px] shadow-md"
        >
          <Bot aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="shrink-0 font-medium">{visibleFocus.agentName}</span>
          <span className="min-w-0 truncate text-muted-foreground">{shown}</span>
        </motion.div>
      </div>

      <div
        aria-hidden="true"
        style={{
          top: rect?.top ?? 0,
          left: rect?.left ?? 0,
          width: rect?.width ?? 0,
          height: rect?.height ?? 0,
          opacity: rect ? 1 : 0,
          transform: rect ? "scale(1)" : "scale(0.96)",
        }}
        data-animate={animateMove ? "true" : undefined}
        className="agent-focus-box pointer-events-none fixed z-[80] rounded-lg border-2 border-primary/75 shadow-[0_0_0_1px_rgba(255,255,255,0.18),0_0_22px_rgba(99,102,241,0.35)]"
      >
        <AnimatePresence>
          {visibleFocus.action === "click" ||
          visibleFocus.action === "press" ||
          visibleFocus.action === "set" ? (
            <motion.span
              key={visibleFocus.at}
              initial={{ opacity: 0.55, scale: 1 }}
              animate={{ opacity: 0, scale: 1.045 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.55, ease: "easeOut" }}
              className="absolute inset-0 rounded-lg border-2 border-primary"
            />
          ) : null}
        </AnimatePresence>
      </div>
    </>,
    document.body
  );
}

/** 同一焦点事件只显示 6 秒；新事件到达时重新计时。 */
function useVisibleFocus(focus: AgentFocusEvent | null): AgentFocusEvent | null {
  const [dismissedAt, setDismissedAt] = useState(0);
  useEffect(() => {
    if (!focus) return;
    const timer = setTimeout(() => setDismissedAt(focus.at), 6_000);
    return () => clearTimeout(timer);
  }, [focus]);
  return focus && focus.at !== dismissedAt ? focus : null;
}
