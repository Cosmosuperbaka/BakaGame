import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AudioLines, Minus, Music2, Plus, RotateCcw, TriangleAlert, X } from "lucide-react";
import type { SongClipPreview, SongClipRange } from "@bakagame/shared";
import { isLyricLineInClip, SONG_CLIP_MIN_MS } from "@bakagame/shared/values";
import { Button } from "@/components/ui/Button";
import { useClipPreviewAudio } from "@/hooks/UseClipPreviewAudio";
import { readoutSwap } from "@/lib/motion/NamedMoves";
import {
  chorusRange,
  clampClipRange,
  defaultClipRange,
  formatClipTime,
  lineSpanRange,
  resolveClipDuration,
} from "./SongClipEditing";
import { SongClipLyricSheet } from "./SongClipLyricSheet";
import { SongClipFooter } from "./SongClipFooter";
import { SongClipTransport } from "./SongClipTransport";
import { errorMessage } from "./SongErrorMessage";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 触屏上一像素就是近一秒，起止的最后一点靠这里按 0.1 秒对齐。 */
const FINE_STEP_MS = 100;

interface ClipBoundStepperProps {
  label: string;
  testId: string;
  value: number;
  canBack: boolean;
  canForward: boolean;
  onStep: (deltaMs: number) => void;
}

function ClipBoundStepper({
  label,
  testId,
  value,
  canBack,
  canForward,
  onStep,
}: ClipBoundStepperProps) {
  return (
    <div role="group" aria-label={`片段${label}微调`} className="flex items-center gap-0.5">
      <span className="mr-1 shrink-0 text-2xs text-muted-foreground">{label}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground"
        aria-label={`${label}提前 0.1 秒`}
        disabled={!canBack}
        onClick={() => onStep(-FINE_STEP_MS)}
      >
        <Minus aria-hidden="true" />
      </Button>
      <span
        className="min-w-11 text-center font-mono text-xs tabular-nums text-foreground"
        data-testid={testId}
      >
        {formatClipTime(value)}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground"
        aria-label={`${label}延后 0.1 秒`}
        disabled={!canForward}
        onClick={() => onStep(FINE_STEP_MS)}
      >
        <Plus aria-hidden="true" />
      </Button>
    </div>
  );
}

export interface SongClipEditorProps {
  song: SongClipPreview;
  /** 猜歌播放音量，与正式播放同一份设置。 */
  volume: number;
  onConfirm: (clip: SongClipRange) => Promise<void>;
  onCancel: () => void;
}

export function SongClipEditor({ song, volume, onConfirm, onCancel }: SongClipEditorProps) {
  const domain = useMemo(() => resolveClipDuration(song), [song]);
  const initialRange = useMemo(() => defaultClipRange(song), [song]);
  const chorus = useMemo(() => chorusRange(song, domain), [song, domain]);
  const [range, setRange] = useState<[number, number]>(initialRange);
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const {
    audioRef,
    playing,
    currentTimeMs,
    failed: audioFailed,
    seek,
    togglePlay,
    audioEvents,
  } = useClipPreviewAudio({ range, volume });
  const [startTime, endTime] = range;
  const selectedLength = endTime - startTime;
  const selectionValid =
    Number.isInteger(startTime) &&
    Number.isInteger(endTime) &&
    startTime >= 0 &&
    endTime <= domain &&
    selectedLength >= SONG_CLIP_MIN_MS;
  const lineCount = song.lyrics.filter(
    (line) => !line.isBG && isLyricLineInClip(line, startTime, endTime)
  ).length;
  const anchorLine = anchorIndex === null ? null : song.lyrics[anchorIndex];
  const hint = anchorLine
    ? `已点一句 ${formatClipTime(anchorLine.time)}，再点另一句定起止`
    : song.lyrics.length === 0
      ? "纯音乐：拖动上方截取条选择片段"
      : "点两句歌词定起止，拖动截取条可微调";

  const movePlayhead = (ms: number) => {
    seek(clamp(ms, startTime, endTime));
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

  const applyPreset = ([presetStart, presetEnd]: readonly [number, number]) => {
    updateRange(presetStart, presetEnd);
    seek(presetStart);
  };

  const pickLine = (index: number) => {
    const line = song.lyrics[index];
    if (!line) return;
    if (anchorIndex === null) {
      const width = Math.max(selectedLength, SONG_CLIP_MIN_MS);
      const [start] = lineSpanRange(song.lyrics, line, line, domain);
      const next = clampClipRange(start, start + width, domain);
      setRange(next);
      setAnchorIndex(index);
      seek(next[0]);
      return;
    }
    const anchor = song.lyrics[anchorIndex] ?? line;
    const first = anchor.time <= line.time ? anchor : line;
    const last = anchor.time <= line.time ? line : anchor;
    const next = lineSpanRange(song.lyrics, first, last, domain);
    setRange(next);
    setAnchorIndex(null);
    if (currentTimeMs < next[0] || currentTimeMs >= next[1]) {
      seek(next[0]);
    }
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
      setError(errorMessage(submitError, "提交出题失败，请重试"));
    } finally {
      setSubmitting(false);
    }
  };

  const atSuggestion = startTime === initialRange[0] && endTime === initialRange[1];
  const atChorus = chorus !== null && startTime === chorus[0] && endTime === chorus[1];

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
        playsInline
        className="hidden"
        {...audioEvents}
      />

      <div className="flex items-center gap-3 px-4 pt-4 sm:gap-4 sm:px-5 sm:pt-5">
        {song.pictureUrl ? (
          <img
            src={song.pictureUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="size-12 shrink-0 rounded-sm border bg-background object-cover shadow-2xs"
          />
        ) : (
          <span className="flex size-12 shrink-0 items-center justify-center rounded-sm border bg-muted/60 text-muted-foreground">
            <Music2 className="size-5" aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-serif text-base font-semibold leading-6 text-foreground">
            {song.title}
          </p>
          <p className="truncate text-xs leading-5 text-muted-foreground">
            {[song.artist, song.album].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>

      <div className="px-4 pb-3 pt-3 sm:px-5">
        <SongClipTransport
          domain={domain}
          range={range}
          currentTimeMs={currentTimeMs}
          chorus={song.chorus}
          playing={playing}
          audioFailed={audioFailed}
          onTogglePlay={() => void togglePlay()}
          onSeek={movePlayhead}
          onRangeChange={updateRange}
          selectionValid={selectionValid}
          selectedLength={selectedLength}
          lineCount={lineCount}
          hasLyrics={song.lyrics.length > 0}
        />

        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <ClipBoundStepper
              label="起点"
              testId="song-clip-start"
              value={startTime}
              canBack={startTime > 0}
              canForward={startTime + FINE_STEP_MS <= endTime - SONG_CLIP_MIN_MS}
              onStep={(delta) => updateRange(startTime + delta, endTime)}
            />
            <ClipBoundStepper
              label="终点"
              testId="song-clip-end"
              value={endTime}
              canBack={endTime - FINE_STEP_MS >= startTime + SONG_CLIP_MIN_MS}
              canForward={endTime < domain}
              onStep={(delta) => updateRange(startTime, endTime + delta)}
            />
          </div>
          <div className="flex items-center gap-1">
            {chorus ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                disabled={atChorus}
                onClick={() => applyPreset(chorus)}
                data-agent-control="song.clip.chorus"
              >
                <AudioLines aria-hidden="true" />
                选副歌
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={atSuggestion}
              onClick={() => applyPreset(initialRange)}
              data-agent-control="song.clip.reset"
            >
              <RotateCcw aria-hidden="true" />
              恢复默认
            </Button>
          </div>
        </div>

        {audioFailed ? (
          <p
            role="status"
            className="mt-2 flex items-start gap-2 rounded-sm bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning"
          >
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            试听加载失败；截取与选词仍可用，可以直接出题。
          </p>
        ) : null}
      </div>

      <div className="border-t">
        <div className="flex min-h-11 items-center justify-between gap-3 px-4 py-1.5 sm:px-5">
          <h3 className="shrink-0 font-serif text-xs font-semibold text-muted-foreground">歌词</h3>
          <div className="flex min-w-0 items-center gap-1">
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
            {anchorLine ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground"
                aria-label="取消已点的歌词"
                onClick={() => setAnchorIndex(null)}
              >
                <X aria-hidden="true" />
              </Button>
            ) : null}
          </div>
        </div>
        <div className="px-1.5 pb-1.5 sm:px-2.5 sm:pb-2.5">
          <SongClipLyricSheet
            lines={song.lyrics}
            range={range}
            anchorIndex={anchorIndex}
            onPick={pickLine}
            onClearAnchor={() => setAnchorIndex(null)}
            audioRef={audioRef}
            playing={playing}
          />
        </div>
      </div>

      <SongClipFooter
        error={error}
        selectedLength={selectedLength}
        submitting={submitting}
        selectionValid={selectionValid}
        onCancel={onCancel}
        onConfirm={() => void confirm()}
      />
    </section>
  );
}
