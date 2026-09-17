import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
  }, [lines]);

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
          "flex h-36 items-center justify-center rounded-md border border-border/40 bg-background/60 p-4 text-center text-sm text-muted-foreground select-none",
          className,
        )}
        data-testid="baka-song-lyric-empty"
      >
        当前歌曲为纯音乐或无歌词
      </div>
    );
  }

  // 3. 歌曲播放完毕后，自动展示全量歌词总览视图（高度自适应完整展示所有行，无滚动条，无冗余描述性文本）
  if (audioPlaybackState === "completed") {
    return (
      <div
        ref={containerRef}
        className={cn(
          "relative flex min-h-[11rem] w-full flex-col items-center justify-center rounded-md border border-border/40 bg-background/70 p-4 sm:min-h-[13rem] sm:p-5 select-none",
          className,
        )}
        data-testid="baka-song-lyric-overview"
      >
        <div className="flex w-full flex-col items-center justify-center space-y-2.5 text-center font-serif">
          {lines.map((line, idx) => (
            <div key={`${line.time}-${idx}`} className="space-y-0.5">
              <p className="text-sm font-semibold text-foreground tracking-wide sm:text-base">
                {line.text}
              </p>
              {line.translatedLyric ? (
                <p className="text-xs text-muted-foreground sm:text-sm font-normal">
                  {line.translatedLyric}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative h-44 w-full overflow-hidden rounded-md border border-border/40 bg-background/60 p-2 sm:h-52 select-none",
        className,
      )}
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
    </div>
  );
}
