import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { LyricPlayer } from "@applemusic-like-lyrics/react";
import type { LyricLine, LyricWord } from "@applemusic-like-lyrics/core";
import type { SongLyricLine } from "@/types";
import { cn } from "@/lib/Utils";
import { calculateLyricContainerHeight } from "./lyricHeight";

// 拦截 AMLL 内部开发环境输出的调试日志（“设置歌词行”、“歌词处理完成”等），保持控制台纯净
if (
  typeof window !== "undefined" &&
  !(window as unknown as { __BAKA_AMLL_LOG_FILTERED__?: boolean }).__BAKA_AMLL_LOG_FILTERED__
) {
  (window as unknown as { __BAKA_AMLL_LOG_FILTERED__?: boolean }).__BAKA_AMLL_LOG_FILTERED__ = true;
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    if (
      typeof args[0] === "string" &&
      (args[0].startsWith("设置歌词行") || args[0].startsWith("歌词处理完成"))
    ) {
      return;
    }
    originalLog(...args);
  };
}

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

  // 根据当前题目歌词行数、文本长度与双语翻译，自适应计算能够完整容纳所有歌词的高度，全程固定避免总览跳动或溢出
  const containerHeight = useMemo(() => {
    return calculateLyricContainerHeight(lines);
  }, [lines]);

  if (lines.length === 0) {
    return (
      <div
        className={cn(
          "flex h-24 sm:h-28 w-full items-center justify-center rounded-md border border-border/40 bg-background/60 p-4 text-center text-sm text-muted-foreground select-none",
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
      style={{ height: `${containerHeight}px` }}
      className={cn(
        "relative flex w-full flex-col overflow-hidden rounded-md border border-border/40 bg-background/60 p-3 sm:p-4 select-none transition-[height] duration-300",
        className,
      )}
      data-testid="baka-song-lyric-container"
    >
      <div
        className="h-full w-full"
        data-testid={isCompleted ? "baka-song-lyric-overview" : "baka-song-lyric-player"}
      >
        <div className="sr-only">
          {lines.map((l) => l.text).join(" ")}
        </div>
        <LyricPlayer
          className={cn(
            "baka-lyric-player h-full w-full",
            isCompleted && "baka-overview-mode",
          )}
          lyricLines={amllLines}
          currentTime={isCompleted ? firstLineTime : currentTime}
          playing={isCompleted ? false : isPlaying}
          alignAnchor={isCompleted ? "top" : "center"}
          alignPosition={isCompleted ? 0.02 : 0.5}
          enableSpring
          enableBlur={!isCompleted}
          enableScale={false}
        />
      </div>
    </div>
  );
}
