import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Music2, Pause, Play, Repeat } from "lucide-react";
import type { SongClipPreview, SongClipRange, SongLyricLine } from "@bakagame/shared";
import { SONG_CLIP_MIN_MS } from "@bakagame/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import { optionTappable } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import {
  clampClipRange,
  defaultClipRange,
  formatClipTime,
  resolveClipDuration,
} from "./SongClipEditing";

/** 片段长度只报秒，避免「0:12.4」在小标签里显得啰嗦。 */
const formatLength = (ms: number) => `${(Math.max(0, ms) / 1_000).toFixed(1)} 秒`;

/** 时间点落在哪一句歌词上：取最后一句已开始的歌词，前奏阶段归到第一句。 */
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
  /** 确认片段并出题；失败由本组件展示并允许重试。 */
  onConfirm: (clip: SongClipRange) => Promise<void>;
  onCancel: () => void;
}

/**
 * 手动出题的片段配置：上方试听、下方歌词与时间轴共用同一个选定区间。
 *
 * 交互只有两条入口：点两句歌词定起止，或拖时间轴的两个手柄；两边都改同一份 range，
 * 所以歌词高亮、起止读数与试听区间不会出现两套状态。
 */
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
  /** 这次区间变化是否来自时间轴：只有拖动时才把歌词列表滚到对应行。 */
  const scrollTargetRef = useRef<"start" | "end" | null>(null);
  const [startTime, endTime] = range;
  const selectedLength = endTime - startTime;
  /**
   * 提交前的最后一道前端过滤：时间轴与歌词选择都已经夹紧，这里只兜住异常输入
   * （例如歌曲短于 5 秒），绝不让无效区间发到服务端。
   */
  const selectionValid =
    Number.isInteger(startTime) &&
    Number.isInteger(endTime) &&
    startTime >= 0 &&
    endTime <= domain &&
    selectedLength >= SONG_CLIP_MIN_MS;

  // 区间变化后把播放头收进新区间，避免试听跑到选区外。
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const ms = audio.currentTime * 1_000;
    if (ms < startTime || ms >= endTime) {
      audio.currentTime = startTime / 1_000;
      setCurrentTimeMs(startTime);
    }
  }, [endTime, startTime]);

  // 拖时间轴时让歌词列表跟到边界所在行；点歌词选区间时不抢滚动位置。
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
    // 双柄滑杆一次只动一个手柄；比较两端位移就知道这次该按谁收口。
    const moved =
      Math.abs(nextStart - startTime) >= Math.abs(nextEnd - endTime) ? "start" : "end";
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
    <div className="w-full space-y-4 text-left">
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

      <section className="space-y-3 rounded-md bg-muted p-4">
        <div className="flex items-center gap-3">
          {song.pictureUrl ? (
            <img
              src={song.pictureUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="size-10 shrink-0 rounded-md bg-background object-cover"
            />
          ) : (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
              <Music2 className="size-4" aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{song.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              {[song.artist, song.album].filter(Boolean).join(" · ")}
            </p>
          </div>
          <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
            {formatClipTime(currentTimeMs)} / {formatClipTime(domain)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
          <span className="ml-auto text-xs text-muted-foreground">
            {formatClipTime(startTime)} – {formatClipTime(endTime)}（{formatLength(selectedLength)}）
          </span>
        </div>
        {audioFailed ? (
          <p role="status" className="text-xs text-destructive">
            试听加载失败；仍可按歌词与时间轴选好片段后出题。
          </p>
        ) : null}
      </section>

      <section className="space-y-2 rounded-md bg-muted p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground">歌词</h3>
          <span className="text-2xs text-muted-foreground">
            {anchorIndex !== null
              ? "已选起点，再点一句设为终点"
              : song.lyrics.length === 0
                ? "拖动下方时间轴选择片段"
                : "点两句歌词定起止，或拖动下方时间轴"}
          </span>
        </div>
        {song.lyrics.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            纯音乐或无歌词，拖动下方时间轴选择片段。
          </p>
        ) : (
          <div ref={listRef} className="max-h-64 overflow-y-auto">
            {song.lyrics.map((line, index) => {
              const selected = line.time < endTime && line.endTime > startTime;
              const active = currentTimeMs >= line.time && currentTimeMs < line.endTime;
              return (
                <motion.button
                  key={`${line.time}-${index}`}
                  type="button"
                  {...optionTappable}
                  data-line-index={index}
                  data-selected={selected ? "true" : undefined}
                  data-active={active ? "true" : undefined}
                  aria-label={`${formatClipTime(line.time)} ${line.text}`}
                  onClick={() => pickLine(index)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/40",
                    selected && "bg-primary/10",
                    active && "text-primary",
                    line.isBG && "opacity-70"
                  )}
                >
                  <span className="w-12 shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                    {formatClipTime(line.time)}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-sm">
                    {line.text}
                    {line.translatedLyric ? (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {line.translatedLyric}
                      </span>
                    ) : null}
                  </span>
                  {index === anchorIndex ? (
                    <Badge variant="active" size="xs" className="shrink-0">
                      起点
                    </Badge>
                  ) : null}
                </motion.button>
              );
            })}
          </div>
        )}
      </section>

      <section
        className="space-y-3 rounded-md bg-muted p-4"
        data-agent-control="song.clip.range"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground">时间轴</h3>
          <span className="text-2xs text-muted-foreground">
            片段 {formatLength(selectedLength)}（至少 5 秒，最长整首）
          </span>
        </div>
        <div className="relative">
          <Slider
            min={0}
            max={domain}
            step={100}
            value={range}
            onValueChange={handleSliderChange}
            aria-label="片段起止时间"
            thumbLabels={["片段起点", "片段终点"]}
            thumbValueTexts={[formatClipTime(startTime), formatClipTime(endTime)]}
          />
          {/* 歌词刻度与播放头：与滑杆共用同一条时间轴，拖柄时能直接看到落在哪句。 */}
          <div className="relative mt-2 h-3" aria-hidden="true">
            {song.lyrics.map((line, index) => {
              const selected = line.time < endTime && line.time >= startTime;
              return (
                <span
                  key={`${line.time}-${index}`}
                  className={cn(
                    "absolute top-0 h-2 w-px",
                    selected ? "bg-primary/60" : "bg-border"
                  )}
                  style={{ left: `${(line.time / domain) * 100}%` }}
                />
              );
            })}
            <span
              className="absolute -top-1 h-3 w-0.5 bg-foreground/50"
              style={{ left: `${(currentTimeMs / domain) * 100}%` }}
            />
          </div>
          <div className="flex justify-between text-2xs tabular-nums text-muted-foreground">
            <span>0:00.0</span>
            <span>{formatClipTime(domain)}</span>
          </div>
        </div>
      </section>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="space-y-2">
        <Button
          className="w-full"
          loading={submitting}
          disabled={!selectionValid}
          onClick={() => void confirm()}
          data-agent-control="song.clip.confirm"
        >
          用这段出题
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          出题后全房会听到这段 {formatLength(selectedLength)} 的音频。
        </p>
        <div className="flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={onCancel}
            data-agent-control="song.clip.cancel"
          >
            返回重新选歌
          </Button>
        </div>
      </div>
    </div>
  );
}
