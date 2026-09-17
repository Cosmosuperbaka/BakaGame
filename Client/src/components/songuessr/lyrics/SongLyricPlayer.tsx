import { useEffect, useMemo, useState, type RefObject } from "react";
import { LyricPlayer } from "@applemusic-like-lyrics/react";
import type { LyricLine, LyricWord } from "@applemusic-like-lyrics/core";
import type { SongLyricLine } from "@/types";
import { cn } from "@/lib/Utils";

export interface SongLyricPlayerProps {
  lines: SongLyricLine[];
  audioRef?: RefObject<HTMLAudioElement | null>;
  className?: string;
}

export function SongLyricPlayer({ lines, audioRef, className }: SongLyricPlayerProps) {
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

  useEffect(() => {
    const audio = audioRef?.current;
    if (!audio) {
      setCurrentTime(firstLineTime);
      return;
    }

    const resolveCurrentMs = () => {
      const audioMs = Math.floor(audio.currentTime * 1000);
      if (audio.paused || audioMs < firstLineTime) {
        return firstLineTime;
      }
      return audioMs;
    };

    setCurrentTime(resolveCurrentMs());
    setIsPlaying(!audio.paused && !audio.ended);

    let rafId: number | null = null;

    const tick = () => {
      if (!audio.paused && !audio.ended) {
        setCurrentTime(resolveCurrentMs());
        rafId = requestAnimationFrame(tick);
      }
    };

    const onPlay = () => {
      setIsPlaying(true);
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
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
      setCurrentTime(resolveCurrentMs());
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onPause);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("seeked", onTimeUpdate);

    if (!audio.paused && !audio.ended) {
      setIsPlaying(true);
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
  }, [audioRef, firstLineTime]);

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

  return (
    <div
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
