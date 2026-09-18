import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { LyricPlayer, type LyricPlayerRef } from "@applemusic-like-lyrics/react";
import type { LyricLine, LyricWord } from "@applemusic-like-lyrics/core";
import type { SongLyricLine } from "@/types";
import { cn } from "@/lib/Utils";
import {
  calculateLyricContainerHeight,
  measureLyricOverviewHeight,
  resolveLyricContentHeight,
} from "./lyricHeight";

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

/** 总览原生实测的最大重试帧数：内核按 overscan 挂载歌词行 DOM，通常 2 ~ 4 帧即测量齐全 */
const MAX_MEASURE_FRAMES = 60;

export interface SongLyricPlayerProps {
  lines: SongLyricLine[];
  audioRef?: RefObject<HTMLAudioElement | null>;
  audioPlaybackState?: "idle" | "playing" | "paused" | "completed";
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
  const lyricPlayerRef = useRef<LyricPlayerRef>(null);

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
      const hasTranslation = Boolean(line.translatedLyric?.trim());

      // 规范铁律：有些歌词同时有翻译和注音，请只显示翻译
      const words: LyricWord[] = hasWords
        ? line.words!.map((w) => ({
            startTime: w.startTime,
            endTime: w.endTime,
            word: w.word,
            romanWord: hasTranslation ? "" : (w.romanWord ?? ""),
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
        romanLyric: hasTranslation ? "" : (line.romanLyric ?? ""),
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
      // 未播放或音频时间严重异常（如切歌时短暂滞留在 0 秒）时，安全锚定在首句
      const minPlausibleMs = Math.max(0, firstLineTime - 3_000);
      if (audio.paused || audioMs < minPlausibleMs) {
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

  // 容器真实可用宽度与上下内边距：折行行数与外壳高度补偿都依赖真实盒模型，严禁写死数值
  const [shellMetrics, setShellMetrics] = useState({ contentWidth: 0, containerPadding: 0 });

  const syncShellMetrics = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const styles = getComputedStyle(node);
    const paddingX = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
    const paddingY = (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0);
    const borderY =
      (parseFloat(styles.borderTopWidth) || 0) + (parseFloat(styles.borderBottomWidth) || 0);
    const contentWidth = Math.max(node.clientWidth - paddingX, 0);
    const containerPadding = paddingY + borderY;
    setShellMetrics((prev) =>
      prev.contentWidth === contentWidth && prev.containerPadding === containerPadding
        ? prev
        : { contentWidth, containerPadding },
    );
  }, []);

  const attachContainer = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      syncShellMetrics(node);
    },
    [syncShellMetrics],
  );

  // 宽度变化会改变折行行数，必须重新核算高度（高度变化不改变宽度，不会自激）
  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => syncShellMetrics(node));
    observer.observe(node);
    return () => observer.disconnect();
  }, [syncShellMetrics]);

  const isCompleted = audioPlaybackState === "completed";

  // 总览高度优先取 AMLL 原生实测值（Σ 各组实测行高，与容器高度无关），
  // 测量齐全前用解析式估算兜底：估算误差只会短暂存在，不会固化为多余留白或裁切。
  // 实测结果与「题目 + 宽度 + 模式」绑定，键不匹配即视为无效（无需在 Effect 内重置状态）。
  const measurementKey = `${isCompleted}:${linesKey}:${shellMetrics.contentWidth}`;
  const [measurement, setMeasurement] = useState<{ key: string; height: number } | null>(null);

  useEffect(() => {
    if (!isCompleted) return;

    let rafId = 0;
    let attempts = 0;

    const poll = () => {
      const player = lyricPlayerRef.current?.lyricPlayer;
      const measured = measureLyricOverviewHeight(player);
      if (measured !== null) {
        setMeasurement({ key: measurementKey, height: measured });
        return;
      }
      if (attempts < MAX_MEASURE_FRAMES) {
        attempts += 1;
        rafId = requestAnimationFrame(poll);
      }
    };

    rafId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(rafId);
  }, [isCompleted, measurementKey]);

  const measuredContentHeight =
    measurement && measurement.key === measurementKey ? measurement.height : null;

  // 根据当前题目歌词行数、文本折行与翻译副行，核算总览所需的精确高度
  const { contentHeight, containerHeight } = useMemo(() => {
    const options = {
      lines,
      contentWidth: shellMetrics.contentWidth,
      containerPadding: shellMetrics.containerPadding,
      measuredContentHeight,
      overview: isCompleted,
    };
    return {
      contentHeight: resolveLyricContentHeight(options),
      containerHeight: calculateLyricContainerHeight(options),
    };
  }, [
    lines,
    shellMetrics.contentWidth,
    shellMetrics.containerPadding,
    measuredContentHeight,
    isCompleted,
  ]);

  // 关键：在总览模式下强制将 AMLL 顶部对齐并同步立即重排，消除顶部下沉与未触发 layout 导致的少显示歌词
  useEffect(() => {
    const player = lyricPlayerRef.current?.lyricPlayer;
    if (!player) return;

    if (isCompleted) {
      player.setAlignAnchor("top");
      player.setAlignPosition(0);
      player.setCurrentTime(firstLineTime, true);
      player.resetScroll();
      player.calcLayout(true, true);
    } else {
      player.setAlignAnchor("center");
      player.setAlignPosition(0.5);
      player.calcLayout(true, false);
    }
  }, [isCompleted, firstLineTime]);

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

  return (
    <div
      ref={attachContainer}
      style={{ height: `${containerHeight}px` }}
      className={cn(
        // 高度过渡与 AMLL 总览的 scale(0.92) 缩放同频同缓动：
        // 若两者不同步，过渡途中外壳会瞬时矮于已缩放内容而产生裁切
        "relative flex w-full flex-col overflow-hidden rounded-md border border-border/40 bg-background/60 p-3 sm:p-4 select-none transition-[height] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]",
        className,
      )}
      data-testid="baka-song-lyric-container"
    >
      <div
        className="h-full w-full"
        data-testid={isCompleted ? "baka-song-lyric-overview" : "baka-song-lyric-player"}
      >
        <div className="sr-only">
          {lines.map((l) => [l.text, l.translatedLyric].filter(Boolean).join(" ")).join(" ")}
        </div>
        <LyricPlayer
          ref={lyricPlayerRef}
          // 播放器本体锁定「未缩放的歌词自然高度」：外壳已按 0.92 反向补偿，
          // 本体保持自然高度才能既不被裁切、也不留多余留白
          style={
            {
              "--baka-lyric-player-height": `${Math.round(contentHeight)}px`,
            } as CSSProperties
          }
          className={cn(
            "baka-lyric-player h-full w-full",
            isCompleted && "baka-overview-mode",
          )}
          lyricLines={amllLines}
          currentTime={isCompleted ? firstLineTime : currentTime}
          playing={isCompleted ? false : isPlaying}
          alignAnchor={isCompleted ? "top" : "center"}
          alignPosition={isCompleted ? 0 : 0.5}
          isSeeking={isCompleted}
          enableSpring
          enableBlur={!isCompleted}
          enableScale={false}
        />
      </div>
    </div>
  );
}
