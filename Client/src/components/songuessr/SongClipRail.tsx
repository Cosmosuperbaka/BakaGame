import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { SongClipPreview } from "@bakagame/shared";
import { SONG_CLIP_MIN_MS } from "@bakagame/shared/values";
import { countdownTickMs } from "@/lib/motion/CssTokens";
import { cn } from "@/lib/Utils";
import { formatClipTime } from "./SongClipEditing";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const percentOf = (ms: number, domain: number) => clamp((ms / domain) * 100, 0, 100);

const roundTime = (ms: number) => Math.round(ms / 100) * 100;

type DragKind = "seek" | "start" | "end";

interface DragState {
  kind: DragKind;
  pointerId: number;
}

export interface SongClipRailProps {
  domain: number;
  range: readonly [number, number];
  currentTimeMs: number;
  chorus?: SongClipPreview["chorus"];
  onSeek: (timeMs: number) => void;
  onRangeChange: (startTime: number, endTime: number) => void;
}

function keyboardNudge(event: KeyboardEvent<HTMLElement>, current: number, domain: number) {
  const step = event.shiftKey ? 100 : 1_000;
  switch (event.key) {
    case "ArrowLeft":
    case "ArrowDown":
      return current - step;
    case "ArrowRight":
    case "ArrowUp":
      return current + step;
    case "PageDown":
      return current - 5_000;
    case "PageUp":
      return current + 5_000;
    case "Home":
      return 0;
    case "End":
      return domain;
    default:
      return null;
  }
}

/**
 * 截取条：一条轨道承担定位、起点、终点三种手势，公共 Slider 的轨道点击只会移动手柄，这里放不下。
 * 手柄长在选区外侧，短片段时两个触摸热区也不互相盖住。
 */
export function SongClipRail({
  domain,
  range,
  currentTimeMs,
  chorus,
  onSeek,
  onRangeChange,
}: SongClipRailProps) {
  const [startTime, endTime] = range;
  const railRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [dragKind, setDragKind] = useState<DragKind | null>(null);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  const chorusBand = useMemo(() => {
    if (
      !chorus ||
      chorus.endTime === undefined ||
      !Number.isFinite(chorus.startTime) ||
      !Number.isFinite(chorus.endTime) ||
      chorus.endTime <= chorus.startTime
    ) {
      return null;
    }
    const left = percentOf(chorus.startTime, domain);
    const right = percentOf(chorus.endTime, domain);
    return right > left ? { left, width: right - left } : null;
  }, [chorus, domain]);

  const startPercent = percentOf(startTime, domain);
  const endPercent = percentOf(endTime, domain);
  const playPercent = percentOf(clamp(currentTimeMs, startTime, endTime), domain);
  const playedWidth = ((clamp(currentTimeMs, startTime, endTime) - startTime) / domain) * 100;
  // 播放进度在选区宽的条上横向缩放（直角条，缩放不变形），只动 transform，播放中不逐帧重排。
  const playedScale = endPercent > startPercent ? playedWidth / (endPercent - startPercent) : 0;
  const bubbleLeft = hoverMs === null ? 0 : percentOf(hoverMs, domain);

  const timeAt = (clientX: number) => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    return clamp(((clientX - rect.left) / rect.width) * domain, 0, domain);
  };

  const capture = (element: HTMLElement, pointerId: number) => {
    try {
      element.setPointerCapture(pointerId);
    } catch {
      // 合成事件或不支持指针捕获时退化为普通拖动，不影响点击定位。
    }
  };

  const release = (element: HTMLElement, pointerId: number) => {
    try {
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    } catch {
      // 捕获已丢失时无需再释放。
    }
  };

  const beginDrag = (kind: DragKind, event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    capture(event.currentTarget, event.pointerId);
    dragRef.current = { kind, pointerId: event.pointerId };
    setDragKind(kind);
    event.currentTarget.focus({ preventScroll: true });
    if (kind === "seek") {
      const raw = timeAt(event.clientX);
      if (raw === null) return;
      const target = clamp(roundTime(raw), startTime, endTime);
      setHoverMs(target);
      onSeek(target);
      return;
    }
    setHoverMs(kind === "start" ? startTime : endTime);
  };

  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const raw = timeAt(event.clientX);
    if (raw === null) return;
    if (!drag) {
      setHoverMs(raw);
      return;
    }
    if (drag.kind === "seek") {
      const target = clamp(roundTime(raw), startTime, endTime);
      setHoverMs(target);
      onSeek(target);
      return;
    }
    if (drag.kind === "start") {
      const next = clamp(roundTime(raw), 0, endTime - SONG_CLIP_MIN_MS);
      setHoverMs(next);
      onRangeChange(next, endTime);
      return;
    }
    const next = clamp(roundTime(raw), startTime + SONG_CLIP_MIN_MS, domain);
    setHoverMs(next);
    onRangeChange(startTime, next);
  };

  const endDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    release(event.currentTarget, event.pointerId);
    dragRef.current = null;
    setDragKind(null);
    setHoverMs(null);
  };

  const loseDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragKind(null);
    setHoverMs(null);
  };

  const nudgeStart = (event: KeyboardEvent<HTMLElement>) => {
    const next = keyboardNudge(event, startTime, domain);
    if (next === null) return;
    event.preventDefault();
    onRangeChange(clamp(roundTime(next), 0, endTime - SONG_CLIP_MIN_MS), endTime);
    setHoverMs(null);
  };

  const nudgeEnd = (event: KeyboardEvent<HTMLElement>) => {
    const next = keyboardNudge(event, endTime, domain);
    if (next === null) return;
    event.preventDefault();
    onRangeChange(startTime, clamp(roundTime(next), startTime + SONG_CLIP_MIN_MS, domain));
    setHoverMs(null);
  };

  const nudgeSeek = (event: KeyboardEvent<HTMLElement>) => {
    const next = keyboardNudge(event, currentTimeMs, domain);
    if (next === null) return;
    event.preventDefault();
    onSeek(clamp(roundTime(next), startTime, endTime));
    setHoverMs(null);
  };

  /** 指针离开轨道时收起悬停读数，拖动中不收（指针已被捕获，仍在拖）。 */
  const leaveRail = () => {
    if (!dragRef.current) setHoverMs(null);
  };

  const handleProps = (kind: "start" | "end") => ({
    role: "slider" as const,
    tabIndex: 0,
    "aria-label": kind === "start" ? "片段起点" : "片段终点",
    "aria-orientation": "horizontal" as const,
    "aria-valuemin": kind === "start" ? 0 : startTime + SONG_CLIP_MIN_MS,
    "aria-valuemax": kind === "start" ? Math.max(0, endTime - SONG_CLIP_MIN_MS) : domain,
    "aria-valuenow": kind === "start" ? startTime : endTime,
    "aria-valuetext": formatClipTime(kind === "start" ? startTime : endTime),
    onPointerDown: (event: PointerEvent<HTMLElement>) => beginDrag(kind, event),
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: loseDrag,
    onKeyDown: kind === "start" ? nudgeStart : nudgeEnd,
    onBlur: () => setHoverMs(null),
  });

  return (
    <div className="px-2">
      <div
        ref={railRef}
        className={cn(
          "relative h-12 w-full touch-none select-none",
          dragKind ? "cursor-ew-resize" : "cursor-pointer"
        )}
        data-testid="song-clip-rail"
        onPointerLeave={leaveRail}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-sm bg-muted"
        />
        {chorusBand ? (
          <div
            aria-hidden="true"
            data-testid="song-clip-chorus"
            className="pointer-events-none absolute top-1/2 h-1.5 -translate-y-1/2 rounded-sm bg-secondary"
            style={{ left: `${chorusBand.left}%`, width: `${chorusBand.width}%` }}
          />
        ) : null}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 h-7 -translate-y-1/2 border-y border-primary/40 bg-primary/10"
          style={{ left: `${startPercent}%`, width: `${endPercent - startPercent}%` }}
        />
        <div
          aria-hidden="true"
          data-testid="song-clip-play-progress"
          className="pointer-events-none absolute top-1/2 h-1.5 origin-left -translate-y-1/2 bg-primary transition-transform ease-linear"
          style={{
            left: `${startPercent}%`,
            width: `${endPercent - startPercent}%`,
            transform: `scaleX(${playedScale})`,
            transitionDuration: `${countdownTickMs}ms`,
          }}
        />
        {hoverMs !== null ? (
          <>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-1 w-px bg-foreground/20"
              style={{ left: `${bubbleLeft}%` }}
            />
            <div
              aria-hidden="true"
              data-testid="song-clip-hover-time"
              className="pointer-events-none absolute -top-3 z-panel -translate-x-1/2 rounded-sm border bg-popover px-1.5 py-0.5 font-mono text-2xs tabular-nums text-popover-foreground shadow-xs"
              style={{ left: `${clamp(bubbleLeft, 7, 93)}%` }}
            >
              {formatClipTime(hoverMs)}
            </div>
          </>
        ) : null}
        {/* 播放头挂在与轨道同宽的层上平移：百分比位移按层宽计，等同于按轨道定位，但不触发重排。 */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 transition-transform ease-linear"
          style={{
            transform: `translateX(${playPercent}%)`,
            transitionDuration: `${countdownTickMs}ms`,
          }}
        >
          <div className="absolute left-0 top-1/2 h-7 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-primary" />
        </div>
        <div
          role="slider"
          tabIndex={0}
          aria-label="播放位置"
          aria-orientation="horizontal"
          aria-valuemin={startTime}
          aria-valuemax={endTime}
          aria-valuenow={Math.round(clamp(currentTimeMs, startTime, endTime))}
          aria-valuetext={formatClipTime(clamp(currentTimeMs, startTime, endTime))}
          // 整条轨道就是这个滑块：环外扩会压到下方「选段 / 时间」读数行，改为内收（DesignGuide §7）
          className="absolute inset-0 rounded-sm focus-visible:-outline-offset-2"
          onPointerDown={(event) => beginDrag("seek", event)}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={loseDrag}
          onPointerLeave={leaveRail}
          onKeyDown={nudgeSeek}
          onBlur={() => setHoverMs(null)}
        />
        {(["start", "end"] as const).map((kind) => (
          <div
            key={kind}
            {...handleProps(kind)}
            className={cn(
              "group absolute top-0 flex h-12 w-8 cursor-ew-resize touch-none items-center rounded-sm focus-visible:outline-offset-2",
              kind === "start" ? "-translate-x-full justify-end" : "justify-start"
            )}
            style={{ left: `${kind === "start" ? startPercent : endPercent}%` }}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex h-8 w-2 items-center justify-center bg-primary shadow-sm transition-transform duration-(--motion-spring-snap-duration) ease-(--motion-spring-snap)",
                kind === "start" ? "rounded-l-sm" : "rounded-r-sm",
                dragKind === kind ? "scale-y-110" : "group-hover:scale-y-110"
              )}
            >
              <span className="h-3 w-px bg-primary-foreground/70" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
