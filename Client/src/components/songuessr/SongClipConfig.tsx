import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Music2, Pause, Play, Repeat } from "lucide-react";
import type { SongClipPreview, SongClipRange, SongLyricLine } from "@bakagame/shared";
import { SONG_CLIP_MIN_MS } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import { countdownTickMs, readoutSwap, readoutTick } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import {
  clampClipRange,
  defaultClipRange,
  formatClipTime,
  resolveClipDuration,
} from "./SongClipEditing";
import { SongClipLyricSelector } from "./SongClipLyricSelector";

const formatLength = (ms: number) => `${(Math.max(0, ms) / 1_000).toFixed(1)} 秒`;

function lineIndexAt(lines: SongLyricLine[], timeMs: number): number {
  let index = 0;
  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    if (lines[cursor]!.time <= timeMs) index = cursor;
    else break;
  }
  return index;
}

export interface SongClipConfigProps {
  song: SongClipPreview;
  onConfirm: (clip: SongClipRange) => Promise<void>;
  onCancel: () => void;
}

export function SongClipConfig({ song, onConfirm, onCancel }: SongClipConfigProps) {
  const domain = useMemo(() => resolveClipDuration(song), [song]);
  const [range, setRange] = useState<[number, number]>(() => defaultClipRange(song));
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [loop, setLoop] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(range[0]);
  const [audioFailed, setAudioFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollTargetRef = useRef<"start" | "end" | null>(null);
  const [startTime, endTime] = range;
  const selectedLength = endTime - startTime;
  const selectionValid =
    Number.isInteger(startTime) &&
    Number.isInteger(endTime) &&
    startTime >= 0 &&
    endTime <= domain &&
    selectedLength >= SONG_CLIP_MIN_MS;
  const { chorus } = song;
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
    const left = Math.max(0, Math.min(100, (chorus.startTime / domain) * 100));
    const right = Math.max(left, Math.min(100, (chorus.endTime / domain) * 100));
    return right - left <= 0 ? null : { left, width: right - left };
  }, [chorus, domain]);
  const playheadPercent = Math.max(0, Math.min(100, (currentTimeMs / domain) * 100));
  const playedWidth =
    ((Math.max(startTime, Math.min(endTime, currentTimeMs)) - startTime) / domain) * 100;
  const hint =
    anchorIndex !== null
      ? "已选起点，再点一句设为终点"
      : song.lyrics.length === 0
        ? "拖动上方时间轴选择片段"
        : "点两句歌词定起止，或拖动上方时间轴";

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const ms = audio.currentTime * 1_000;
    if (ms < startTime || ms >= endTime) {
      audio.currentTime = startTime / 1_000;
      setCurrentTimeMs(startTime);
    }
  }, [endTime, startTime]);

  useEffect(() => {
    const target = scrollTargetRef.current;
    if (target === null) return;
    const timeMs = target === "start" ? startTime : endTime;
    const index = lineIndexAt(song.lyrics, timeMs);
    const node = listRef.current?.querySelector<HTMLElement>(`[data-line-index="${index}"]`);
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ block: "nearest" });
    }
  }, [endTime, song.lyrics, startTime]);

  useEffect(
    () => () => {
      audioRef.current?.pause();
    },
    []
  );

  const applyRange = (start: number, end: number, moved: "start" | "end") => {
    setRange(clampClipRange(start, end, domain));
    setAnchorIndex(null);
    scrollTargetRef.current = moved;
  };

  const handleSliderChange = (value: number[]) => {
    const nextStart = value[0] ?? startTime;
    const nextEnd = value[1] ?? endTime;
    const moved = Math.abs(nextStart - startTime) >= Math.abs(nextEnd - endTime) ? "start" : "end";
    applyRange(nextStart, nextEnd, moved);
  };

  const pickLine = (index: number) => {
    const line = song.lyrics[index];
    if (!line) return;
    scrollTargetRef.current = null;
    if (anchorIndex === null) {
      const width = Math.max(selectedLength, SONG_CLIP_MIN_MS);
      setRange(clampClipRange(line.time, line.time + width, domain));
      setAnchorIndex(index);
      return;
    }
    const anchor = song.lyrics[anchorIndex] ?? line;
    const first = anchor.time <= line.time ? anchor : line;
    const last = anchor.time <= line.time ? line : anchor;
    setRange(
      clampClipRange(first.time, Math.max(last.endTime, first.time + SONG_CLIP_MIN_MS), domain)
    );
    setAnchorIndex(null);
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
      if (loop) {
        audio.currentTime = startTime / 1_000;
        setCurrentTimeMs(startTime);
        return;
      }
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
    <div className="w-full text-left">
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

      <section
        className="overflow-hidden rounded-md border bg-panel shadow-2xs"
        data-agent-control="song.clip.range"
        aria-label="截取歌词与片段"
      >
        <div className="flex items-center gap-3 border-b px-4 py-3">
          {song.pictureUrl ? (
            <img
              src={song.pictureUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="size-11 shrink-0 rounded-md bg-background object-cover"
            />
          ) : (
            <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Music2 className="size-4" aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <strong className="block truncate font-serif text-sm font-medium">{song.title}</strong>
            <p className="truncate text-xs text-muted-foreground">
              {[song.artist, song.album].filter(Boolean).join(" · ")}
            </p>
          </div>
          <span className="hidden shrink-0 font-mono text-2xs tabular-nums text-muted-foreground sm:inline">
            {formatLength(selectedLength)}
          </span>
        </div>

        <div className="space-y-4 p-4">
          <div className="flex items-center gap-2">
            <Button
              size="icon"
              onClick={() => void togglePlay()}
              aria-label={playing ? "暂停试听" : "试听片段"}
            >
              {playing ? <Pause /> : <Play />}
            </Button>
            <Button
              variant={loop ? "secondary" : "outline"}
              size="sm"
              aria-pressed={loop}
              onClick={() => setLoop((value) => !value)}
            >
              <Repeat />
              循环
            </Button>
            <span className="ml-auto font-mono text-2xs tabular-nums text-muted-foreground">
              <motion.span
                key={formatClipTime(currentTimeMs)}
                initial={readoutTick.initial}
                animate={readoutTick.animate}
                transition={readoutTick.transition}
                className="inline-block"
              >
                {formatClipTime(currentTimeMs)}
              </motion.span>
              {" / "}
              {formatClipTime(domain)}
            </span>
          </div>

          {audioFailed ? (
            <p role="status" className="text-xs text-destructive">
              试听加载失败；仍可按歌词与时间轴选好片段后出题。
            </p>
          ) : null}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold text-muted-foreground">时间轴</h3>
                <p className="font-mono text-xs tabular-nums">
                  {formatClipTime(startTime)} – {formatClipTime(endTime)}
                </p>
              </div>
              <span className="text-2xs text-muted-foreground">
                片段 {formatLength(selectedLength)}（至少 5 秒，最长整首）
              </span>
            </div>
            <div className="relative flex h-5 items-center">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-muted"
              />
              {chorusBand ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-secondary"
                  style={{ left: `${chorusBand.left}%`, width: `${chorusBand.width}%` }}
                />
              ) : null}
              {song.lyrics.map((line, index) => (
                <span
                  key={`${line.time}-${index}`}
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute top-1/2 h-3.5 w-px -translate-y-1/2",
                    line.time < endTime && line.time >= startTime ? "bg-primary/60" : "bg-border"
                  )}
                  style={{ left: `${(line.time / domain) * 100}%` }}
                />
              ))}
              <span
                aria-hidden="true"
                data-testid="song-clip-play-progress"
                className="pointer-events-none absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-primary/50 transition-[width] ease-linear"
                style={{
                  left: `${(startTime / domain) * 100}%`,
                  width: `${playedWidth}%`,
                  transitionDuration: `${countdownTickMs}ms`,
                }}
              />
              <Slider
                className="w-full py-2"
                min={0}
                max={domain}
                step={100}
                value={range}
                onValueChange={handleSliderChange}
                aria-label="片段起止时间"
                thumbLabels={["片段起点", "片段终点"]}
                thumbValueTexts={[formatClipTime(startTime), formatClipTime(endTime)]}
                trackClassName="h-2 bg-transparent"
                rangeClassName="rounded-full bg-primary/25"
                thumbClassName="h-5 w-5"
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-foreground/60 transition-[left] ease-linear"
                style={{
                  left: `${playheadPercent}%`,
                  transitionDuration: `${countdownTickMs}ms`,
                }}
              />
            </div>
            <div className="flex justify-between font-mono text-2xs tabular-nums text-muted-foreground">
              <span>0:00.0</span>
              <span>{formatClipTime(domain)}</span>
            </div>
          </div>
        </div>

        <div className="border-t bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-muted-foreground">歌词选取</h3>
            <div className="flex min-h-4 items-center justify-end" aria-live="polite">
              <motion.span
                key={hint}
                variants={readoutSwap}
                initial="initial"
                animate="animate"
                className="block text-right text-2xs text-muted-foreground"
              >
                {hint}
              </motion.span>
            </div>
          </div>
        </div>
        <div className="bg-muted/30 px-3 pb-3">
          <SongClipLyricSelector
            lines={song.lyrics}
            range={range}
            anchorIndex={anchorIndex}
            onPick={pickLine}
            audioRef={audioRef}
            playing={playing}
            listRef={listRef}
          />
        </div>

        <div className="space-y-3 border-t p-4">
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              className="flex-1"
              loading={submitting}
              disabled={!selectionValid}
              onClick={() => void confirm()}
              data-agent-control="song.clip.confirm"
            >
              用这段出题
            </Button>
            <Button
              variant="outline"
              disabled={submitting}
              onClick={onCancel}
              data-agent-control="song.clip.cancel"
            >
              返回重新选歌
            </Button>
          </div>
          <p className="text-center text-xs text-muted-foreground">
            出题后全房会听到这段 {formatLength(selectedLength)} 的音频。
          </p>
        </div>
      </section>
    </div>
  );
}
