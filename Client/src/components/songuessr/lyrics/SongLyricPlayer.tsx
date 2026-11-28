import { useLayoutEffect, useRef, type RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { SongLyricLine } from "@bakagame/shared";
import { skeletonFade } from "@/lib/motion/Choreography";
import { lyricReveal } from "@/lib/motion/NamedMoves";
import { cn } from "@/lib/Utils";
import { SongLyricScene } from "./SongLyricScene";

export interface SongLyricPlayerProps {
  lines: SongLyricLine[];
  audioRef?: RefObject<HTMLAudioElement | null>;
  /** 片段音频的起点（毫秒）：手动片段可以早于首句，异常判定要以它为准。 */
  clipStartTime?: number;
  audioPlaybackState?: "idle" | "playing" | "paused" | "completed";
  audioStatus?: "loading" | "ready" | "error";
  /**
   * 歌词先排好版但不露面：猜歌时本机音频还不能播，歌词不能先于声音出现。
   * 占位与歌词共用同一个框，揭开时占位原地淡出、歌词淡入，框的高度不跳。
   */
  concealed?: boolean;
  className?: string;
}

export function SongLyricPlayer({
  lines,
  audioRef,
  clipStartTime,
  audioPlaybackState = "idle",
  audioStatus = "ready",
  concealed = false,
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
  const pending = concealed && !empty;
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
      ) : pending ? null : (
        <div className="sr-only">
          {lines
            .map((line) =>
              [line.text, line.translatedLyric || line.romanLyric].filter(Boolean).join(" ")
            )
            .join(" ")}
        </div>
      )}
      <motion.div
        hidden={empty}
        className="baka-lyric-viewport scrollbar-hidden p-3 sm:p-4"
        data-testid="baka-song-lyric-viewport"
        data-concealed={pending || undefined}
        variants={lyricReveal}
        initial={false}
        animate={pending ? "concealed" : "revealed"}
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
      </motion.div>
      <AnimatePresence initial={false}>
        {pending ? (
          <motion.p
            key="pending"
            exit={skeletonFade.exit}
            className="pointer-events-none absolute inset-0 flex items-center justify-center p-3 text-center text-sm text-muted-foreground sm:p-4"
            data-testid="baka-song-lyric-pending"
          >
            音频加载后显示歌词
          </motion.p>
        ) : null}
      </AnimatePresence>
      <div aria-hidden="true" className="baka-lyric-edge baka-lyric-edge-top" />
      <div aria-hidden="true" className="baka-lyric-edge baka-lyric-edge-bottom" />
    </div>
  );
}
