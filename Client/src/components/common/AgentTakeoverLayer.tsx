import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Bot, LockOpen } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { agentActivityText } from "@/lib/AgentActivityLabel";
import { closePageControl } from "@/lib/SiteWs";
import { agentPace } from "@/lib/motion/NamedMoves";
import { findControlForFocus } from "@/lib/PageView";
import {
  clearPageNotice,
  useAgentFocus,
  usePageControl,
  usePageNotice,
  type AgentFocus,
} from "@/stores/UsePageControl";

/** 接管结束的提示停留多久，够人类读完一句话。 */
const NOTICE_MS = 4_500;

/** 焦点框外扩的留白，以及离视口边缘的最小距离。 */
const BOX_PADDING = 7;
const BOX_EDGE = 4;
/** 状态条：离焦点框的距离、放不下时的上边界、水平方向离边缘的最小距离。 */
const HUD_GAP = 34;
const HUD_MIN_TOP = 56;
const HUD_EDGE = 150;
/** 底部留给「收回控制」，状态条不压上去。 */
const HUD_BOTTOM_RESERVE = 104;

interface BoxRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const measure = (target: HTMLElement): BoxRect | null => {
  const rect = target.getBoundingClientRect();
  if (rect.width < BOX_EDGE || rect.height < BOX_EDGE) return null;
  const left = Math.max(BOX_EDGE, rect.left - BOX_PADDING);
  const top = Math.max(BOX_EDGE, rect.top - BOX_PADDING);
  return {
    top,
    left,
    width: Math.max(0, Math.min(window.innerWidth - left - BOX_EDGE, rect.width + BOX_PADDING * 2)),
    height: Math.max(
      0,
      Math.min(window.innerHeight - top - BOX_EDGE, rect.height + BOX_PADDING * 2)
    ),
  };
};

const sameRect = (left: BoxRect | null, right: BoxRect | null): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.top === right.top &&
    left.left === right.left &&
    left.width === right.width &&
    left.height === right.height);

const resolveFocusTarget = (focus: AgentFocus | null): HTMLElement | null => {
  if (focus?.element?.isConnected) return focus.element;
  return focus?.controlId ? findControlForFocus(focus.controlId) : null;
};

/**
 * 逐帧跟住目标：页面滚动、布局变化、节点重建时框都要贴着控件。
 * 只有换目标时才打开位置过渡，跟随滚动时直接落位，否则框会拖在控件后面。
 */
function useTrackedRect(focus: AgentFocus | null): { rect: BoxRect | null; moving: boolean } {
  const [rect, setRect] = useState<BoxRect | null>(null);
  const [moving, setMoving] = useState(false);
  const lastTarget = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let frame = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const target = resolveFocusTarget(focus);
      const next = target ? measure(target) : null;
      if (target !== lastTarget.current) {
        if (lastTarget.current && target) {
          setMoving(true);
          clearTimeout(settle);
          settle = setTimeout(() => setMoving(false), agentPace.moveMs);
        }
        lastTarget.current = target;
      }
      setRect((current) => (sameRect(current, next) ? current : next));
      frame = window.requestAnimationFrame(tick);
    };
    tick();
    return () => {
      window.cancelAnimationFrame(frame);
      clearTimeout(settle);
    };
  }, [focus]);

  return { rect, moving };
}

/** 浏览器级快捷键留给人类：刷新、开发者工具与切换标签页都不属于页面操作。 */
const isBrowserShortcut = (event: Event): boolean => {
  if (!event.type.startsWith("key")) return false;
  const { metaKey, ctrlKey, key } = event as KeyboardEvent;
  return metaKey || ctrlKey || key === "F5" || key === "F12";
};

const BLOCKED_EVENTS = [
  "pointerdown",
  "pointerup",
  "mousedown",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "touchstart",
  "touchmove",
  "touchend",
  "wheel",
  "keydown",
  "keypress",
  "keyup",
  "beforeinput",
  "compositionstart",
  "paste",
  "cut",
  "drop",
  "dragstart",
  "selectstart",
] as const;

/**
 * 接管期间人类不能操作这张标签页，判据是事件是否可信：人类的输入都是 `isTrusted`，
 * Agent 回放的是脚本事件。不用 `inert`：它会让真实控件失去焦点，Agent 的输入与 Radix
 * 的焦点管理都依赖真实焦点；也管不到挂在 body 上的弹窗。收回入口始终放行，
 * 键盘用户按 Tab 或 Esc 直接落到收回按钮上，不会被关在里面。
 */
function useTakeoverLock(
  active: boolean,
  releaseRef: RefObject<HTMLButtonElement | null>,
  onBlocked: () => void
): void {
  useEffect(() => {
    if (!active) return;
    // 模态弹窗的焦点陷阱会把焦点拉回去，所以按过 Tab / Esc 之后，确认键不看焦点在哪。
    let armed = false;
    const block = (event: Event) => {
      if (!event.isTrusted || isBrowserShortcut(event)) return;
      const target = event.target;
      if (target instanceof Element && target.closest("[data-agent-release]")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "pointerdown" || event.type === "touchstart") onBlocked();
      if (event.type === "keydown") {
        const { key } = event as KeyboardEvent;
        if (key === "Tab" || key === "Escape") {
          armed = true;
          releaseRef.current?.focus();
        } else if (armed && (key === "Enter" || key === " ")) {
          void closePageControl();
        } else {
          armed = false;
          onBlocked();
        }
      }
    };
    for (const type of BLOCKED_EVENTS)
      window.addEventListener(type, block, { capture: true, passive: false });
    document.documentElement.dataset.agentLocked = "true";
    return () => {
      for (const type of BLOCKED_EVENTS) window.removeEventListener(type, block, true);
      delete document.documentElement.dataset.agentLocked;
    };
  }, [active, onBlocked, releaseRef]);
}

function FocusBox({ focus, rect, moving }: { focus: AgentFocus; rect: BoxRect; moving: boolean }) {
  const echo =
    !focus.idle &&
    (focus.action === "click" || focus.action === "press" || focus.action === "select");
  return (
    <div
      aria-hidden="true"
      style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
      data-animate={moving ? "true" : undefined}
      className="agent-focus-box pointer-events-none fixed z-agent rounded-md border-2 border-primary/75 shadow-md ring-4 ring-primary/15"
    >
      {echo ? (
        <span
          key={focus.seq}
          className="agent-click-echo absolute inset-0 rounded-md border-2 border-primary"
        />
      ) : null}
    </div>
  );
}

/** 贴着操作区的状态条：优先放在框上方，顶部放不下时落到框下方，避开底部的收回入口。 */
function FocusHud({ text, rect }: { text: string; rect: BoxRect }) {
  const left = Math.min(
    Math.max(rect.left + rect.width / 2, HUD_EDGE),
    Math.max(HUD_EDGE, window.innerWidth - HUD_EDGE)
  );
  const top =
    rect.top > HUD_MIN_TOP
      ? rect.top - HUD_GAP
      : Math.min(window.innerHeight - HUD_BOTTOM_RESERVE, rect.top + rect.height + 8);
  return (
    <div
      aria-hidden="true"
      className="agent-focus-hud pointer-events-none fixed z-agent -translate-x-1/2"
      style={{ left, top }}
    >
      <div className="flex max-w-[calc(100vw-2rem)] items-center whitespace-nowrap rounded-full border border-primary/40 bg-card px-2.5 py-1 text-2xs shadow-md">
        <span className="min-w-0 truncate text-muted-foreground">{text}</span>
      </div>
    </div>
  );
}

function TakeoverBar({
  agentName,
  activity,
  reconnecting,
  nudge,
  releaseRef,
}: {
  agentName: string;
  activity: string;
  reconnecting: boolean;
  nudge: number;
  releaseRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-agent flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div
        key={nudge}
        data-agent-release
        data-nudge={nudge > 0 ? "true" : undefined}
        // 模态弹窗会把 body 设成不响应指针，这里要显式打开；按下也不能算作「点到弹窗外」。
        onPointerDown={(event) => event.stopPropagation()}
        className="agent-takeover-bar pointer-events-auto flex min-w-0 max-w-full items-center gap-2 rounded-full border border-primary/40 bg-card py-1 pl-3 pr-1 text-xs shadow-lg"
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary motion-safe:animate-breathe"
        />
        <Bot aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="max-w-36 shrink-0 truncate font-medium">{agentName}</span>
        <span role="status" className="min-w-0 truncate text-muted-foreground">
          {reconnecting ? "连接中断，正在恢复" : activity}
        </span>
        <Button
          ref={releaseRef}
          type="button"
          variant="outline"
          size="sm"
          className="h-7 shrink-0 rounded-full px-3 text-xs"
          onClick={() => void closePageControl()}
        >
          收回控制
        </Button>
      </div>
    </div>
  );
}

function EndNotice({ text }: { text: string }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-agent flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div
        role="status"
        className="agent-takeover-bar flex min-w-0 max-w-full items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-xs shadow-lg"
      >
        <LockOpen aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{text}</span>
      </div>
    </div>
  );
}

function Takeover({ agentName, reconnecting }: { agentName: string; reconnecting: boolean }) {
  const focus = useAgentFocus();
  const { rect, moving } = useTrackedRect(focus);
  const [nudge, setNudge] = useState(0);
  const releaseRef = useRef<HTMLButtonElement | null>(null);
  const bump = useCallback(() => setNudge((value) => value + 1), []);
  useTakeoverLock(true, releaseRef, bump);
  const activity = agentActivityText(focus?.action, focus?.label, focus?.idle);

  return (
    <>
      {/* 透明挡板：不改变页面观感，只让人类的鼠标与触摸落不到控件上，也不触发悬停反馈。 */}
      <div aria-hidden="true" className="fixed inset-0 z-agent touch-none cursor-default" />
      {focus && rect ? (
        <>
          <FocusBox focus={focus} rect={rect} moving={moving} />
          {focus.idle ? null : <FocusHud text={activity} rect={rect} />}
        </>
      ) : null}
      <TakeoverBar
        agentName={agentName}
        activity={activity}
        reconnecting={reconnecting}
        nudge={nudge}
        releaseRef={releaseRef}
      />
    </>
  );
}

/**
 * 接管期间人类看到的全部东西：挡板、焦点框、状态条与收回入口，任何页面都是同一套。
 * 不依赖路由与页面数据，挂在根布局上；页面崩溃或懒加载失败时收回入口依然在。
 */
export function AgentTakeoverLayer() {
  const { status, agentName, reconnecting } = usePageControl();
  const notice = usePageNotice();
  const controlled = status === "controlled";

  useEffect(() => {
    if (!notice || controlled) return;
    const timer = setTimeout(clearPageNotice, NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice, controlled]);

  if (!controlled && !notice) return null;
  return createPortal(
    <div data-agent-layer>
      {controlled ? (
        <Takeover agentName={agentName || "Agent"} reconnecting={reconnecting === true} />
      ) : notice ? (
        <EndNotice key={notice.seq} text={notice.text} />
      ) : null}
    </div>,
    document.body
  );
}
