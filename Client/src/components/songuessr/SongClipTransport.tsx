import { AnimatePresence, motion } from "framer-motion";
import { Pause, Play } from "lucide-react";
import type { SongClipPreview } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { iconToggle } from "@/lib/Motion";
import { cn } from "@/lib/Utils";
import { formatClipLength, formatClipTime } from "./SongClipEditing";
import { SongClipRail } from "./SongClipRail";

/** 试听播放键、截取条与下方的选段时长与播放时钟读数。 */
export function SongClipTransport({
  domain,
  range,
  currentTimeMs,
  chorus,
  playing,
  audioFailed,
  onTogglePlay,
  onSeek,
  onRangeChange,
  selectionValid,
  selectedLength,
  lineCount,
  hasLyrics,
}: {
  domain: number;
  range: [number, number];
  currentTimeMs: number;
  chorus: SongClipPreview["chorus"];
  playing: boolean;
  audioFailed: boolean;
  onTogglePlay: () => void;
  onSeek: (ms: number) => void;
  onRangeChange: (start: number, end: number) => void;
  selectionValid: boolean;
  selectedLength: number;
  lineCount: number;
  hasLyrics: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <Button
        type="button"
        size="icon"
        onClick={onTogglePlay}
        disabled={audioFailed}
        aria-label={audioFailed ? "试听不可用" : playing ? "暂停试听" : "试听片段"}
        data-agent-control="song.clip.play"
        className="size-11 shrink-0 rounded-full shadow-sm [&_svg]:size-5"
      >
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={playing ? "pause" : "play"}
            variants={iconToggle}
            initial="initial"
            animate="animate"
            exit="exit"
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

      <div className="min-w-0 flex-1">
        <SongClipRail
          domain={domain}
          range={range}
          currentTimeMs={currentTimeMs}
          chorus={chorus}
          onSeek={onSeek}
          onRangeChange={onRangeChange}
        />
        <div className="flex items-baseline justify-between gap-3 px-2 text-2xs">
          <span
            className={cn(
              "min-w-0 truncate",
              selectionValid ? "text-muted-foreground" : "text-destructive"
            )}
            data-testid="song-clip-summary"
          >
            <span className="mr-1 hidden sm:inline">选段</span>
            <span className="mr-1 font-mono tabular-nums text-foreground">
              {formatClipLength(selectedLength)}
            </span>
            {hasLyrics ? `· ${lineCount} 句` : ""}
          </span>
          <span
            className="shrink-0 font-mono tabular-nums text-muted-foreground"
            data-testid="song-clip-clock"
          >
            {formatClipTime(currentTimeMs)}
            {/* 分隔符比读数弱一档即可；描边色当字色在暗色下几乎消失，两段时间读成两个孤立数字 */}
            <span className="px-1 text-muted-foreground/60">/</span>
            {formatClipTime(domain)}
          </span>
        </div>
      </div>
    </div>
  );
}
