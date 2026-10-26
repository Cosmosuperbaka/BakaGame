import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Music2, Pause, Play, TriangleAlert } from "lucide-react";
import type { SongClipPreview, SongClipRange } from "@bakagame/shared";
import { SONG_CLIP_MIN_MS } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { countdownTickMs, readoutSwap, spring } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import {
  clampClipRange,
  defaultClipRange,
  formatClipTime,
  resolveClipDuration,
} from "./SongClipEditing";
import { SongClipLyricSheet } from "./SongClipLyricSheet";

const formatLength = (ms: number) => `${(Math.max(0, ms) / 1_000).toFixed(1)} 秒`;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const percentOf = (ms: number, domain: number) => clamp((ms / domain) * 100, 0, 100);

const roundTime = (ms: number) => Math.round(ms / 100) * 100;

type DragKind = "seek" | "start" | "end";

interface DragState {
  kind: DragKind;
  pointerId: number;
}

interface SongClipRailProps {
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

function SongClipRail({
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
    <div
      ref={railRef}
      className={cn(
        "relative h-10 w-full touch-none select-none",
        dragKind ? "cursor-ew-resize" : "cursor-pointer"
      )}
      data-testid="song-clip-rail"
      onPointerLeave={() => {
        if (!dragRef.current) setHoverMs(null);
      }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-border/80"
      />
      {chorusBand ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-secondary/80"
          style={{ left: `${chorusBand.left}%`, width: `${chorusBand.width}%` }}
        />
      ) : null}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-primary/20 ring-1 ring-inset ring-primary/30"
        style={{ left: `${startPercent}%`, width: `${endPercent - startPercent}%` }}
      />
      <div
        aria-hidden="true"
        data-testid="song-clip-play-progress"
        className="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary/80 transition-[width] ease-linear"
        style={{
          left: `${startPercent}%`,
          width: `${playedWidth}%`,
          transitionDuration: `${countdownTickMs}ms`,
        }}
      />
      {hoverMs !== null ? (
        <>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0.5 w-px bg-foreground/15"
            style={{ left: `${bubbleLeft}%` }}
          />
          <div
            aria-hidden="true"
            data-testid="song-clip-hover-time"
            className="pointer-events-none absolute -top-5 -translate-x-1/2 rounded-sm border bg-popover px-1.5 py-0.5 font-mono text-2xs tabular-nums text-popover-foreground shadow-xs"
            style={{ left: `${clamp(bubbleLeft, 7, 93)}%` }}
          >
            {formatClipTime(hoverMs)}
          </div>
        </>
      ) : null}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-panel transition-[left] ease-linear"
        style={{
          left: `${playPercent}%`,
          transitionDuration: `${countdownTickMs}ms`,
        }}
      />
      <div
        role="slider"
        tabIndex={0}
        aria-label="播放位置"
        aria-orientation="horizontal"
        aria-valuemin={startTime}
        aria-valuemax={endTime}
        aria-valuenow={Math.round(clamp(currentTimeMs, startTime, endTime))}
        aria-valuetext={formatClipTime(clamp(currentTimeMs, startTime, endTime))}
        className="absolute inset-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
        onPointerDown={(event) => beginDrag("seek", event)}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={loseDrag}
        onPointerLeave={() => {
          if (!dragRef.current) setHoverMs(null);
        }}
        onKeyDown={nudgeSeek}
        onBlur={() => setHoverMs(null)}
      />
      {(["start", "end"] as const).map((kind) => {
        const active = dragKind === kind;
        return (
          <div
            key={kind}
            {...handleProps(kind)}
            className={cn(
              "group absolute top-1/2 flex h-10 w-6 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel",
              active && "cursor-ew-resize"
            )}
            style={{ left: `${kind === "start" ? startPercent : endPercent}%` }}
          >
            <span
              aria-hidden="true"
              className={cn(
                "h-6 w-1.5 rounded-full bg-primary shadow-sm transition-transform",
                active ? "scale-y-110" : "group-hover:scale-y-110"
              )}
            />
          </div>
        );
      })}
    </div>
  );
}

export interface SongClipEditorProps {
  song: SongClipPreview;
  onConfirm: (clip: SongClipRange) => Promise<void>;
  onCancel: () => void;
}

export function SongClipEditor({ song, onConfirm, onCancel }: SongClipEditorProps) {
  const domain = useMemo(() => resolveClipDuration(song), [song]);
  const [range, setRange] = useState<[number, number]>(() => defaultClipRange(song));
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(range[0]);
  const [audioFailed, setAudioFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [startTime, endTime] = range;
  const selectedLength = endTime - startTime;
  const selectionValid =
    Number.isInteger(startTime) &&
    Number.isInteger(endTime) &&
    startTime >= 0 &&
    endTime <= domain &&
    selectedLength >= SONG_CLIP_MIN_MS;
  const anchorLine = anchorIndex === null ? null : song.lyrics[anchorIndex];
  const hint = anchorLine
    ? `已点一句 ${formatClipTime(anchorLine.time)}，再点另一句定起止`
    : song.lyrics.length === 0
      ? "纯音乐：拖动上方截取条选择片段"
      : "点两句歌词定起止，拖动截取条可微调";

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const ms = audio.currentTime * 1_000;
    if (ms < startTime || ms >= endTime) {
      audio.currentTime = startTime / 1_000;
      setCurrentTimeMs(startTime);
    }
  }, [endTime, startTime]);

  useEffect(
    () => () => {
      audioRef.current?.pause();
    },
    []
  );

  const seekDirect = (ms: number) => {
    const target = Math.round(ms);
    const audio = audioRef.current;
    if (audio) audio.currentTime = target / 1_000;
    setCurrentTimeMs((previous) => (previous === target ? previous : target));
  };

  const movePlayhead = (ms: number) => {
    seekDirect(clamp(ms, startTime, endTime));
  };

  const updateRange = (nextStart: number, nextEnd: number) => {
    const [clampedStart, clampedEnd] = clampClipRange(nextStart, nextEnd, domain);
    setRange((previous) =>
      previous[0] === clampedStart && previous[1] === clampedEnd
        ? previous
        : [clampedStart, clampedEnd]
    );
    setAnchorIndex(null);
  };

  const pickLine = (index: number) => {
    const line = song.lyrics[index];
    if (!line) return;
    if (anchorIndex === null) {
      const width = Math.max(selectedLength, SONG_CLIP_MIN_MS);
      const next = clampClipRange(line.time, line.time + width, domain);
      setRange(next);
      setAnchorIndex(index);
      seekDirect(next[0]);
      return;
    }
    const anchor = song.lyrics[anchorIndex] ?? line;
    const first = anchor.time <= line.time ? anchor : line;
    const last = anchor.time <= line.time ? line : anchor;
    const next = clampClipRange(
      first.time,
      Math.max(last.endTime, first.time + SONG_CLIP_MIN_MS),
      domain
    );
    setRange(next);
    setAnchorIndex(null);
    if (currentTimeMs < next[0] || currentTimeMs >= next[1]) {
      seekDirect(next[0]);
    }
  };

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      setPlaying(false);
      return;
    }
    const ms = audio.currentTime * 1_000;
    if (ms < startTime || ms >= endTime) {
      audio.currentTime = startTime / 1_000;
      setCurrentTimeMs(startTime);
    }
    try {
      await audio.play();
      setPlaying(true);
    } catch {
      setPlaying(false);
    }
  };

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const ms = audio.currentTime * 1_000;
    if (ms < startTime - 250) {
      audio.currentTime = startTime / 1_000;
      setCurrentTimeMs(startTime);
      return;
    }
    if (ms >= endTime) {
      audio.pause();
      audio.currentTime = startTime / 1_000;
      setCurrentTimeMs(startTime);
      setPlaying(false);
      return;
    }
    setCurrentTimeMs(ms);
  };

  const confirm = async () => {
    if (!selectionValid) {
      setError(`请选择至少 ${SONG_CLIP_MIN_MS / 1_000} 秒的片段`);
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onConfirm({ startTime, endTime });
    } catch (submitError) {
      setError((submitError as { message?: string }).message ?? "提交出题失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section
      className="w-full overflow-hidden rounded-md border bg-panel text-left shadow-2xs"
      data-agent-control="song.clip.range"
      aria-label="截取歌词与片段"
    >
      {/* 不设 controls，也不加 crossOrigin：解灰音源不返回 CORS 头。 */}
      <audio
        ref={audioRef}
        src={song.audioUrl}
        preload="auto"
        className="hidden"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={handleTimeUpdate}
        onEnded={() => {
          setPlaying(false);
          const audio = audioRef.current;
          if (audio) audio.currentTime = startTime / 1_000;
          setCurrentTimeMs(startTime);
        }}
        onError={() => setAudioFailed(true)}
      />

      <div className="flex items-start gap-3 px-4 pb-1 pt-4 sm:gap-4 sm:px-5 sm:pt-5">
        {song.pictureUrl ? (
          <img
            src={song.pictureUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-12 shrink-0 rounded-sm border bg-background object-cover shadow-2xs sm:size-14"
          />
        ) : (
          <span className="flex size-12 shrink-0 items-center justify-center rounded-sm border bg-muted/60 text-muted-foreground sm:size-14">
            <Music2 className="size-5" aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="truncate font-serif text-base font-semibold leading-6 text-foreground">
            {song.title}
          </p>
          <p className="truncate text-xs leading-5 text-muted-foreground">
            {[song.artist, song.album].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="hidden shrink-0 pt-0.5 text-right sm:block">
          <span className="block text-2xs text-muted-foreground">选段</span>
          <span
            className={cn(
              "font-mono text-xs tabular-nums sm:text-sm",
              selectionValid ? "text-foreground" : "text-destructive"
            )}
          >
            {formatLength(selectedLength)}
          </span>
        </div>
      </div>

      <div className="px-4 pb-4 pt-3 sm:px-5">
        <div className="flex items-start gap-3 sm:gap-4">
          <Button
            type="button"
            size="icon"
            onClick={() => void togglePlay()}
            disabled={audioFailed}
            aria-label={audioFailed ? "试听不可用" : playing ? "暂停试听" : "试听片段"}
            data-agent-control="song.clip.play"
            className="size-11 shrink-0 rounded-full shadow-sm [&_svg]:size-5 sm:size-12"
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={playing ? "pause" : "play"}
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                transition={spring.snap}
                className="flex items-center justify-center"
              >
                {playing ? (
                  <Pause aria-hidden="true" fill="currentColor" />
                ) : (
                  <Play aria-hidden="true" fill="currentColor" className="translate-x-px" />
                )}
              </motion.span>
            </AnimatePresence>
          </Button>

          <div className="min-w-0 flex-1 pt-0.5 sm:pt-1">
            <SongClipRail
              domain={domain}
              range={range}
              currentTimeMs={currentTimeMs}
              chorus={song.chorus}
              onSeek={movePlayhead}
              onRangeChange={updateRange}
            />
            <div className="mt-1 flex items-baseline justify-between gap-3 font-mono text-2xs tabular-nums">
              <span className="min-w-0 truncate">
                <span className="mr-1.5 hidden font-kai text-muted-foreground sm:inline">选段</span>
                <span className="text-foreground" data-testid="song-clip-range">
                  {formatClipTime(startTime)} – {formatClipTime(endTime)}
                </span>
              </span>
              <span className="shrink-0 text-muted-foreground" data-testid="song-clip-clock">
                {formatClipTime(currentTimeMs)}
                <span className="px-1 text-border">/</span>
                {formatClipTime(domain)}
              </span>
            </div>
          </div>
        </div>

        {audioFailed ? (
          <p
            role="status"
            className="mt-3 flex items-start gap-2 rounded-sm bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning"
          >
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            试听加载失败；截取与选词仍可用，可以直接出题。
          </p>
        ) : null}
      </div>

      <div className="border-t bg-background/30">
        <div className="flex items-center justify-between gap-3 px-4 pb-1 pt-3 sm:px-5">
          <h3 className="shrink-0 font-serif text-xs font-semibold text-muted-foreground">歌词</h3>
          <div aria-live="polite" className="min-w-0">
            <AnimatePresence initial={false} mode="wait">
              <motion.p
                key={hint}
                variants={readoutSwap}
                initial="initial"
                animate="animate"
                exit="exit"
                className="text-right text-2xs leading-relaxed text-muted-foreground"
              >
                {hint}
              </motion.p>
            </AnimatePresence>
          </div>
        </div>
        <div className="px-2 pb-2 sm:px-3">
          <SongClipLyricSheet
            lines={song.lyrics}
            range={range}
            anchorIndex={anchorIndex}
            onPick={pickLine}
            audioRef={audioRef}
            playing={playing}
          />
        </div>
      </div>

      <div className="border-t px-4 py-3 sm:px-5">
        {error ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-center text-2xs leading-relaxed text-muted-foreground sm:max-w-xs sm:text-left">
            出题后，全房会听到这段 {formatLength(selectedLength)} 的音频。
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              type="button"
              variant="ghost"
              disabled={submitting}
              onClick={onCancel}
              data-agent-control="song.clip.cancel"
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft aria-hidden="true" />
              返回重新选歌
            </Button>
            <Button
              type="button"
              className="sm:min-w-32"
              loading={submitting}
              disabled={!selectionValid || submitting}
              onClick={() => void confirm()}
              data-agent-control="song.clip.confirm"
            >
              用这段出题
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
