import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Music2, Pause, Play, Repeat } from "lucide-react";
import type { SongClipPreview, SongClipRange, SongLyricLine } from "@bakagame/shared";
import { SONG_CLIP_MIN_MS } from "@bakagame/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import { listContainer, listItem, optionTappable, readoutSwap, readoutTick } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import {
  clampClipRange,
  defaultClipRange,
  formatClipTime,
  resolveClipDuration,
} from "./SongClipEditing";

/** 片段长度只报秒，避免「0:12.4」在小标签里显得啰嗦。 */
const formatLength = (ms: number) => `${(Math.max(0, ms) / 1_000).toFixed(1)} 秒`;

/**
 * 播放头在两次 timeupdate 之间匀速补间，读作连续走动的时间；
 * 与倒计时进度条同一条匀速豁免（见 `Motion.ts` 的 `countdownTickMs`）。
 */
const PLAYHEAD_SMOOTH_MS = 250;

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
 * 手动出题的片段配置：上方是歌曲与试听，下方一张面板里放同一份区间的两个视图——
 * 时间轴是尺子，歌词是被裁的内容。
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
  /** 副歌带铺在时间轴上，给「好听的段落大概在这里」一个参照；数据异常时不画。 */
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
  /** 选中段落在歌词列表里的首末行：竖标的圆角帽画在这两行上。 */
  const [firstSelected, lastSelected] = useMemo(() => {
    let first = -1;
    let last = -1;
    song.lyrics.forEach((line, index) => {
      if (line.time < endTime && line.endTime > startTime) {
        if (first < 0) first = index;
        last = index;
      }
    });
    return [first, last] as const;
  }, [endTime, song.lyrics, startTime]);
  const hint =
    anchorIndex !== null
      ? "已选起点，再点一句设为终点"
      : song.lyrics.length === 0
        ? "拖动上方时间轴选择片段"
        : "点两句歌词定起止，或拖动上方时间轴";

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
            <strong className="block truncate text-sm font-medium">{song.title}</strong>
            <p className="truncate text-xs text-muted-foreground">
              {[song.artist, song.album].filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>
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
          {/* 播放进度连续刷新：新值自贴近终值的位置顶上来，快速刷新不闪。 */}
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
      </section>

      {/* 时间轴与歌词是同一份区间的两个视图，放在同一张面板里：尺子在上，内容在下。 */}
      <section
        className="space-y-4 rounded-md border bg-panel p-4 shadow-2xs"
        data-agent-control="song.clip.range"
        aria-label="截取歌词与片段"
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-muted-foreground">时间轴</h3>
            <span className="text-2xs text-muted-foreground">
              片段 {formatLength(selectedLength)}（至少 5 秒，最长整首）
            </span>
          </div>
          <p className="text-center font-mono text-xs tabular-nums">
            {formatClipTime(startTime)} – {formatClipTime(endTime)}
          </p>
          {/*
            一条时间轴四层内容：底轨与副歌带是尺子，歌词刻度落在轨上，选中段与手柄叠在刻度上，
            播放头最后划过。滑杆轨道透明，选中段取半透明主色，刻度在区间内的部分透出来。
          */}
          <div className="relative flex h-5 items-center">
            <div
              aria-hidden="true"
              className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-muted"
            />
            {chorusBand ? (
              <div
                aria-hidden="true"
                className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-secondary"
                style={{ left: `${chorusBand.left}%`, width: `${chorusBand.width}%` }}
              />
            ) : null}
            {song.lyrics.map((line, index) => (
              <span
                key={`${line.time}-${index}`}
                aria-hidden="true"
                className={cn(
                  "absolute top-1/2 h-3.5 w-px -translate-y-1/2",
                  line.time < endTime && line.time >= startTime ? "bg-primary/60" : "bg-border"
                )}
                style={{ left: `${(line.time / domain) * 100}%` }}
              />
            ))}
            {/* py 撑高触控热区：轨道与手柄的视觉位置不变，整行都能按住拖动。 */}
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
              className="absolute top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-foreground/60 transition-[left] ease-linear"
              style={{
                left: `${(currentTimeMs / domain) * 100}%`,
                transitionDuration: `${PLAYHEAD_SMOOTH_MS}ms`,
              }}
            />
          </div>
          <div className="flex justify-between font-mono text-2xs tabular-nums text-muted-foreground">
            <span>0:00.0</span>
            <span>{formatClipTime(domain)}</span>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-muted-foreground">歌词</h3>
            {/* 提示随选择进度切换：换 key 重挂载，新文案自下方顶上来；polite 只播报这一句，不打断操作。 */}
            <div className="flex min-h-4 items-center justify-end" aria-live="polite">
              <motion.span
                key={hint}
                variants={readoutSwap}
                initial="initial"
                animate="animate"
                className="block text-2xs text-muted-foreground"
              >
                {hint}
              </motion.span>
            </div>
          </div>
          {song.lyrics.length === 0 ? (
            <p className="flex h-24 items-center justify-center rounded-md bg-background px-3 text-center text-sm text-muted-foreground sm:h-28">
              纯音乐或无歌词，拖动上方时间轴选择片段。
            </p>
          ) : (
            <motion.div
              ref={listRef}
              variants={listContainer(song.lyrics.length)}
              initial="initial"
              animate="animate"
              className="max-h-64 overflow-y-auto rounded-md bg-background p-1.5"
            >
              {song.lyrics.map((line, index) => {
                const selected = line.time < endTime && line.endTime > startTime;
                const active = currentTimeMs >= line.time && currentTimeMs < line.endTime;
                return (
                  <motion.button
                    key={`${line.time}-${index}`}
                    type="button"
                    {...optionTappable}
                    variants={listItem}
                    data-line-index={index}
                    data-selected={selected ? "true" : undefined}
                    data-active={active ? "true" : undefined}
                    aria-label={`${formatClipTime(line.time)} ${line.text}`}
                    onClick={() => pickLine(index)}
                    className={cn(
                      "relative flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/40",
                      selected && "bg-primary/10",
                      line.isBG && "opacity-70"
                    )}
                  >
                    {selected ? (
                      /* 选中行左缘连成一条主色竖标，首末行收圆角，读出区间的边界落在哪两行。 */
                      <span
                        aria-hidden="true"
                        className={cn(
                          "absolute inset-y-0 left-0 w-0.5 bg-primary",
                          index === firstSelected && "rounded-t-full",
                          index === lastSelected && "rounded-b-full"
                        )}
                      />
                    ) : null}
                    <span
                      className={cn(
                        "w-12 shrink-0 font-mono text-2xs leading-5 tabular-nums text-muted-foreground",
                        selected && "text-primary"
                      )}
                    >
                      {formatClipTime(line.time)}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 break-words text-sm leading-5",
                        active && "text-primary"
                      )}
                    >
                      {line.text}
                      {line.translatedLyric ? (
                        <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
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
            </motion.div>
          )}
        </div>
      </section>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="space-y-2">
        <div className="flex gap-2">
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
    </div>
  );
}
