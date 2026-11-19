import { useLayoutEffect, useRef, type RefObject } from "react";
import type { SongLyricLine } from "@bakagame/shared";
import { cn } from "@/lib/Utils";
import { SongLyricScene } from "./SongLyricScene";

export interface SongLyricPlayerProps {
  lines: SongLyricLine[];
  audioRef?: RefObject<HTMLAudioElement | null>;
  /** 片段音频的起点（毫秒）：手动片段可以早于首句，异常判定要以它为准。 */
  clipStartTime?: number;
  audioPlaybackState?: "idle" | "playing" | "paused" | "completed";
  audioStatus?: "loading" | "ready" | "error";
  className?: string;
}

export function SongLyricPlayer({
  lines,
  audioRef,
  clipStartTime,
  audioPlaybackState = "idle",
  audioStatus = "ready",
  className,
}: SongLyricPlayerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SongLyricScene | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new SongLyricScene(host);
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  // 单一提交入口；音频帧只驱动 AMLL，不再引起 React 每帧重渲染。
  useLayoutEffect(() => {
    sceneRef.current?.setSource(lines, audioRef?.current ?? null, clipStartTime);
    sceneRef.current?.setPlayback(audioPlaybackState, audioStatus);
  }, [lines, audioRef, clipStartTime, audioPlaybackState, audioStatus]);

  const empty = lines.length === 0;
  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-md bg-background select-none",
        empty &&
          "flex h-24 sm:h-28 items-center justify-center p-3 sm:p-4 text-center text-sm text-muted-foreground",
        className
      )}
      data-testid={empty ? "baka-song-lyric-empty" : "baka-song-lyric-container"}
    >
      {empty ? (
        "当前歌曲为纯音乐或无歌词"
      ) : (
        <div className="sr-only">
          {lines
            .map((line) =>
              [line.text, line.translatedLyric || line.romanLyric].filter(Boolean).join(" ")
            )
            .join(" ")}
        </div>
      )}
      <div
        hidden={empty}
        className="baka-lyric-viewport scrollbar-hidden p-3 sm:p-4"
        data-testid="baka-song-lyric-viewport"
      >
        <div
          ref={hostRef}
          hidden={empty}
          className="baka-lyric-host"
          aria-hidden="true"
          data-testid={
            audioPlaybackState === "completed"
              ? "baka-song-lyric-overview"
              : "baka-song-lyric-player"
          }
        />
      </div>
      <div aria-hidden="true" className="baka-lyric-edge baka-lyric-edge-top" />
      <div aria-hidden="true" className="baka-lyric-edge baka-lyric-edge-bottom" />
    </div>
  );
}
