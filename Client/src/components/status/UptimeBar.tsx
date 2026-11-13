import {
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { AnimatePresence, motion, useSpring } from "framer-motion";
import { TriangleAlert, Wrench } from "lucide-react";
import { hoverMarkFade, uptimeGlide, uptimeReveal } from "@/lib/motion/NamedMoves";
import { popover } from "@/lib/motion/Choreography";
import { cn } from "@/lib/Utils";
import { LEVEL_TEXT, cellTone, formatLatency, formatRatio, type BarCell } from "./StatusFormat";

/** 悬停说明的固定宽度（w-56）的一半：靠边时按它把说明往条带内侧收，不越过条带两端。 */
const TOOLTIP_HALF_WIDTH = 112;

const describeCell = (cell: BarCell): string => {
  if (cell.total === 0) return "没有探测样本";
  if (cell.level === "unknown" || cell.ratio === null) return "未知 · 探测没有得出结论";
  return `${LEVEL_TEXT[cell.level]} · 可用率 ${formatRatio(cell.ratio)}`;
};

/** 方向键与 Home / End 对应的目标格；不是这几个键返回 null。 */
const keyTarget = (key: string, current: number, total: number): number | null => {
  if (key === "ArrowLeft") return current - 1;
  if (key === "ArrowRight") return current + 1;
  if (key === "Home") return 0;
  if (key === "End") return total - 1;
  return null;
};

/** 读屏播报用的一句话：与悬停说明同一份信息，只是写成连贯的文字。 */
const announceCell = (cell: BarCell): string =>
  [cell.when, describeCell(cell), ...cell.events.map((event) => event.title)].join("，");

function CellTooltip({ cell }: { cell: BarCell }) {
  return (
    <div className="floating-surface w-56 rounded-md px-3 py-2 text-left shadow-md">
      <p className="font-mono text-2xs text-muted-foreground">{cell.when}</p>
      <p className="mt-1 flex items-center gap-1.5 text-xs">
        <span aria-hidden="true" className="flex h-3 w-1 shrink-0 items-end">
          <span className={cn("w-full rounded-xs", cellTone(cell))} />
        </span>
        {describeCell(cell)}
      </p>
      {cell.latencyMs !== null ? (
        <p className="mt-0.5 pl-2.5 font-mono text-2xs text-muted-foreground">
          平均延迟 {formatLatency(cell.latencyMs)}
        </p>
      ) : null}
      {cell.events.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5 border-t border-border pt-1.5">
          {cell.events.map((event) => (
            <li key={event.id} className="flex items-center gap-1.5 text-2xs">
              {event.kind === "maintenance" ? (
                <Wrench aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <TriangleAlert aria-hidden="true" className="size-3 shrink-0 text-destructive" />
              )}
              <span className="truncate">{event.title}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const summarize = (cells: BarCell[]): string => {
  const sampled = cells.filter((cell) => cell.total > 0);
  if (sampled.length === 0) return "这段时间还没有探测样本";
  const operational = sampled.filter((cell) => cell.level === "operational").length;
  const degraded = sampled.filter((cell) => cell.level === "degraded").length;
  const unknown = sampled.length - operational - degraded;
  return `${sampled.length} 个时段有数据，其中 ${operational} 个正常、${degraded} 个异常${
    unknown > 0 ? `、${unknown} 个未知` : ""
  }`;
};

interface UptimeBarProps {
  /** 格子序列，左旧右新；`null` 表示数据还没到或读失败，按占位桩画，布局不跳。 */
  cells: BarCell[] | null;
  /** 占位桩的格数，与数据到达后的格数一致。 */
  placeholderCount: number;
  /** 数据仍在读取：占位桩随统一的呼吸令牌起伏；读失败就静止，不冒充「还在加载」。 */
  loading: boolean;
  /** 变化即重播显影（数据首次到达、切换视图）；分钟轮询的更新不换键，不重播。 */
  revealKey: string;
  /** 显影的延迟（秒）：整页按行错峰。 */
  revealDelay: number;
  className?: string;
}

/**
 * 日格 / 实时共用的条带：左旧右新，一格一个时段。
 *
 * 悬停说明与选中框各只有一份 DOM，顺着指针在格子之间滑动（`uptimeGlide`），
 * 120 格也不产生 120 份浮层，同一个对象移动时始终是同一个元素。
 * 整条带作为一张图像读给读屏；逐格细节除悬停外还有两条入口：键盘聚焦条带后用方向键逐格查看
 * （同一个浮层，同时由播报区读出），触屏点按一格后说明固定显示、点条带之外收起
 * （手指抬起时浏览器会补发 pointerleave，触屏必须忽略它，否则说明只在按下期间可见）。
 * 每行右侧另有文字状态与可用率，颜色不是唯一线索。
 */
export function UptimeBar({
  cells,
  placeholderCount,
  loading,
  revealKey,
  revealDelay,
  className,
}: UptimeBarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hoveringRef = useRef(false);
  const [hover, setHover] = useState<{
    index: number;
    width: number;
    source: "pointer" | "touch" | "keyboard";
  } | null>(null);
  const tipX = useSpring(0, uptimeGlide);
  const markX = useSpring(0, uptimeGlide);

  const dense = (cells?.length ?? placeholderCount) > 60;
  const hovered = hover && cells ? cells[hover.index] : undefined;

  const showCell = (index: number, cell: HTMLElement, source: "pointer" | "touch" | "keyboard") => {
    const container = containerRef.current;
    if (!container) return;
    const center = cell.offsetLeft + cell.offsetWidth / 2;
    const clamped = Math.min(
      Math.max(center, TOOLTIP_HALF_WIDTH),
      Math.max(TOOLTIP_HALF_WIDTH, container.offsetWidth - TOOLTIP_HALF_WIDTH)
    );
    // 刚移入时直接落位，之后在格子之间才滑动：从上一次离开的地方飘过来没有成因。
    if (hoveringRef.current) {
      tipX.set(clamped);
      markX.set(cell.offsetLeft);
    } else {
      tipX.jump(clamped);
      markX.jump(cell.offsetLeft);
    }
    hoveringRef.current = true;
    setHover({ index, width: cell.offsetWidth, source });
  };

  const onEnter = (index: number) => (event: ReactPointerEvent<HTMLSpanElement>) =>
    showCell(index, event.currentTarget, event.pointerType === "touch" ? "touch" : "pointer");

  const dismiss = () => {
    hoveringRef.current = false;
    setHover(null);
  };

  const onLeave = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    dismiss();
  };

  /** 键盘定位到第 `index` 格（夹在有效范围内）。 */
  const focusCell = (index: number) => {
    const total = cells?.length ?? 0;
    const element =
      containerRef.current?.querySelectorAll<HTMLElement>("[data-cell]")[
        Math.min(Math.max(index, 0), total - 1)
      ];
    if (element) showCell(Math.min(Math.max(index, 0), total - 1), element, "keyboard");
  };

  const onFocus = (event: ReactFocusEvent<HTMLDivElement>) => {
    // 鼠标点击聚焦不弹说明（悬停已经在管）；只有键盘聚焦才从最新一格开始。
    let keyboard = true;
    try {
      keyboard = event.currentTarget.matches(":focus-visible");
    } catch {
      // 不认识 :focus-visible 的环境一律按键盘处理。
    }
    if (keyboard && !hoveringRef.current && cells?.length) focusCell(cells.length - 1);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const total = cells?.length ?? 0;
    if (total === 0) return;
    const current = hover?.index ?? total - 1;
    const target = keyTarget(event.key, current, total);
    if (event.key === "Escape") {
      dismiss();
      return;
    }
    if (target === null) return;
    event.preventDefault();
    focusCell(target);
  };

  // 触屏固定显示的说明没有「移开」这回事：点到条带之外才收起。
  const touchPinned = hover?.source === "touch";
  useEffect(() => {
    if (!touchPinned) return;
    const onDocumentPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        hoveringRef.current = false;
        setHover(null);
      }
    };
    document.addEventListener("pointerdown", onDocumentPointerDown);
    return () => document.removeEventListener("pointerdown", onDocumentPointerDown);
  }, [touchPinned]);

  return (
    <div ref={rootRef} className={cn("relative", className)} onPointerLeave={onLeave}>
      <motion.div
        style={{ x: tipX }}
        className="pointer-events-none absolute bottom-full left-0 z-popover mb-2"
      >
        <AnimatePresence>
          {hovered ? (
            <motion.div
              key="tooltip"
              aria-hidden="true"
              variants={popover}
              initial="initial"
              animate="animate"
              exit="exit"
              className="origin-bottom -translate-x-1/2"
            >
              <CellTooltip cell={hovered} />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
      <div
        ref={containerRef}
        role="img"
        aria-label={cells ? summarize(cells) : "这段时间还没有探测样本"}
        tabIndex={cells && cells.length > 0 ? 0 : undefined}
        onFocus={onFocus}
        onBlur={dismiss}
        onKeyDown={onKeyDown}
        className={cn(
          "relative flex h-6 items-end",
          // 格缝随宽度放开：窄屏 120 格只够留一像素，宽屏留出呼吸，条带读作一排刻度而不是一整块色带。
          dense ? "gap-px sm:gap-0.5" : "gap-0.5 sm:gap-1"
        )}
      >
        {cells
          ? cells.map((cell, index) => (
              <span
                key={cell.key}
                data-cell=""
                aria-hidden="true"
                onPointerEnter={onEnter(index)}
                className="flex h-full min-w-0 flex-1 items-end"
              >
                <span
                  className={cn(
                    "w-full rounded-xs transition-colors duration-(--motion-duration-base) ease-(--motion-ease-out)",
                    cellTone(cell)
                  )}
                />
              </span>
            ))
          : Array.from({ length: placeholderCount }, (_, index) => (
              <span
                key={index}
                data-cell=""
                aria-hidden="true"
                className="flex h-full min-w-0 flex-1 items-end"
              >
                <span
                  className={cn(
                    "h-1/4 w-full rounded-xs bg-border",
                    loading && "motion-safe:animate-breathe"
                  )}
                />
              </span>
            ))}
        <AnimatePresence>
          {hovered && hover ? (
            <motion.span
              key="mark"
              aria-hidden="true"
              style={{ x: markX, width: hover.width }}
              variants={hoverMarkFade}
              initial="initial"
              animate="animate"
              exit="exit"
              className="pointer-events-none absolute -inset-y-1 left-0 rounded-xs ring-1 ring-foreground/60"
            />
          ) : null}
        </AnimatePresence>
        {cells ? (
          <motion.span
            key={revealKey}
            aria-hidden="true"
            initial={{ scaleX: 1 }}
            animate={{ scaleX: 0 }}
            transition={{ ...uptimeReveal.transition, delay: revealDelay }}
            className="pointer-events-none absolute -inset-y-px -right-px left-0 origin-right bg-card"
          />
        ) : null}
      </div>
      {/* 键盘逐格查看时的播报：浮层本身是 aria-hidden 的纯视觉层。 */}
      <span aria-live="polite" className="sr-only">
        {hovered && hover?.source === "keyboard" ? announceCell(hovered) : ""}
      </span>
    </div>
  );
}
