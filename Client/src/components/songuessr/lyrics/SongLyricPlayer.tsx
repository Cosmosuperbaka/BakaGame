import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { LyricPlayer } from "@applemusic-like-lyrics/react";
import type { LyricLine, LyricWord } from "@applemusic-like-lyrics/core";
import type { SongLyricLine } from "@/types";
import { cn } from "@/lib/Utils";

export interface SongLyricPlayerProps {
  lines: SongLyricLine[];
  audioRef?: RefObject<HTMLAudioElement | null>;
  audioPlaybackState?: "idle" | "playing" | "completed";
  audioStatus?: "loading" | "ready" | "error";
  className?: string;
}

export function SongLyricPlayer({
  lines,
  audioRef,
  audioPlaybackState = "idle",
  audioStatus = "ready",
  className,
}: SongLyricPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // 4. 禁用滚轮滚动歌词组件：在捕获阶段截断事件，阻止进入 AMLL 内部触发重排与内部滚动
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const preventWheel = (e: WheelEvent) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    el.addEventListener("wheel", preventWheel, { capture: true, passive: true });
    return () => {
      el.removeEventListener("wheel", preventWheel, { capture: true });
    };
  }, []);

  // 根除音频就绪导致歌词二次重刷与渐入动画重播：
  // 基于歌词真实内容与时间戳生成稳定的摘要键，阻断外部快照引用突变导致的新数组生成。
  const linesKey = useMemo(() => {
    return lines
      .map(
        (l) =>
          `${l.time}-${l.endTime}-${l.text}-${l.words?.length ?? 0}-${l.translatedLyric ?? ""}`,
      )
      .join("|");
  }, [lines]);

  const amllLines = useMemo<LyricLine[]>(() => {
    return lines.map((line) => {
      const hasWords = Array.isArray(line.words) && line.words.length > 0;
      const words: LyricWord[] = hasWords
        ? line.words!.map((w) => ({
            startTime: w.startTime,
            endTime: w.endTime,
            word: w.word,
            romanWord: w.romanWord ?? "",
          }))
        : [
            {
              startTime: line.time,
              endTime: line.endTime,
              word: line.text,
              romanWord: "",
            },
          ];

      return {
        words,
        translatedLyric: line.translatedLyric ?? "",
        romanLyric: line.romanLyric ?? "",
        startTime: line.time,
        endTime: line.endTime,
        isBG: Boolean(line.isBG),
        isDuet: Boolean(line.isDuet),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey]);

  const firstLineTime = lines[0]?.time ?? 0;
  const [currentTime, setCurrentTime] = useState<number>(firstLineTime);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  // 1. 状态机严格同步：只有当音频明确进入 playing 且 ready 状态时才允许开始逐字时间轴
  useEffect(() => {
    const audio = audioRef?.current;
    if (!audio) {
      setCurrentTime(firstLineTime);
      setIsPlaying(false);
      return;
    }

    const isAudioActuallyPlaying =
      audioPlaybackState === "playing" &&
      audioStatus === "ready" &&
      !audio.paused &&
      !audio.ended;

    const resolveCurrentMs = () => {
      const audioMs = Math.floor(audio.currentTime * 1000);
      if (audio.paused || audioMs < firstLineTime) {
        return firstLineTime;
      }
      return audioMs;
    };

    if (isAudioActuallyPlaying) {
      setCurrentTime(resolveCurrentMs());
      setIsPlaying(true);
    } else {
      setCurrentTime(firstLineTime);
      setIsPlaying(false);
    }

    let rafId: number | null = null;

    const tick = () => {
      if (!audio.paused && !audio.ended && audioPlaybackState === "playing") {
        setCurrentTime(resolveCurrentMs());
        rafId = requestAnimationFrame(tick);
      }
    };

    const onPlay = () => {
      if (audioPlaybackState === "playing") {
        setIsPlaying(true);
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(tick);
      }
    };

    const onPause = () => {
      setIsPlaying(false);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      setCurrentTime(resolveCurrentMs());
    };

    const onTimeUpdate = () => {
      if (audioPlaybackState === "playing") {
        setCurrentTime(resolveCurrentMs());
      }
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onPause);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("seeked", onTimeUpdate);

    if (isAudioActuallyPlaying) {
      rafId = requestAnimationFrame(tick);
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onPause);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("seeked", onTimeUpdate);
    };
  }, [audioRef, firstLineTime, audioPlaybackState, audioStatus]);

  if (lines.length === 0) {
    return (
      <div
        className={cn(
          "flex h-64 sm:h-72 w-full items-center justify-center rounded-md border border-border/40 bg-background/60 p-4 text-center text-sm text-muted-foreground select-none",
          className,
        )}
        data-testid="baka-song-lyric-empty"
      >
        当前歌曲为纯音乐或无歌词
      </div>
    );
  }

  const isCompleted = audioPlaybackState === "completed";

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative flex h-64 sm:h-72 w-full flex-col overflow-hidden rounded-md border border-border/40 bg-background/60 p-3 sm:p-4 select-none",
        className,
      )}
      data-testid="baka-song-lyric-container"
    >
      <AnimatePresence mode="wait" initial={false}>
        {isCompleted ? (
          <motion.div
            key="overview"
            initial={{ opacity: 0, scale: 1.08 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="flex h-full w-full flex-col items-center justify-center space-y-2 sm:space-y-2.5 text-center font-serif"
            data-testid="baka-song-lyric-overview"
          >
            {lines.map((line, idx) => (
              <div key={`${line.time}-${idx}`} className="space-y-0.5">
                <p className="text-base sm:text-lg font-semibold text-foreground font-serif tracking-wide leading-relaxed">
                  {line.text}
                </p>
                {line.translatedLyric ? (
                  <p className="text-xs sm:text-sm text-muted-foreground font-serif opacity-75 leading-normal">
                    {line.translatedLyric}
                  </p>
                ) : null}
              </div>
            ))}
          </motion.div>
        ) : (
          <motion.div
            key="player"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.25 }}
            className="h-full w-full"
            data-testid="baka-song-lyric-player"
          >
            <div className="sr-only">
              {lines.map((l) => l.text).join(" ")}
            </div>
            <LyricPlayer
              className="baka-lyric-player h-full w-full"
              lyricLines={amllLines}
              currentTime={currentTime}
              playing={isPlaying}
              alignAnchor="center"
              alignPosition={0.5}
              enableSpring
              enableBlur
              enableScale={false}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
