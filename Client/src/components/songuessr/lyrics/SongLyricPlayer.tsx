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
  resolveLyricPlayerHeight,
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

/** 原生实测的最大重试帧数：全量挂载后通常 2 ~ 4 帧即测量齐全 */
const MAX_MEASURE_FRAMES = 600;
/** 测量值需连续稳定这么多帧才采信，过滤字体加载与占位尺寸造成的瞬态 */
const MEASURE_STABLE_FRAMES = 8;
/**
 * 视野缓冲距离调大到全量级别：内核只挂载「进入视野」的歌词行，若按默认 300px，
 * 外壳偏矮时末尾行永远不会挂载 → 永远测不到 → 高度永远算不准（死循环）。
 * 题目歌词最多十来行，全量挂载毫无性能压力。
 */
const LYRIC_OVERSCAN_PX = 4000;

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

  // 容器真实可用宽度、上下内边距与播放器实测字号：
  // 折行行数、装箱常量与外壳高度补偿都依赖真实盒模型，严禁写死数值
  // （根字号并非固定 16px，`rem` 相关常量必须实测，否则整体偏差可达 20%）
  const [shellMetrics, setShellMetrics] = useState({
    contentWidth: 0,
    containerPadding: 0,
    baseFontSize: 0,
  });

  const syncShellMetrics = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const styles = getComputedStyle(node);
    const paddingX = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
    const paddingY = (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0);
    const borderY =
      (parseFloat(styles.borderTopWidth) || 0) + (parseFloat(styles.borderBottomWidth) || 0);
    const playerEl = node.querySelector(".amll-lyric-player");
    const baseFontSize = playerEl ? parseFloat(getComputedStyle(playerEl).fontSize) || 0 : 0;
    const contentWidth = Math.max(node.clientWidth - paddingX, 0);
    const containerPadding = paddingY + borderY;
    setShellMetrics((prev) =>
      prev.contentWidth === contentWidth &&
      prev.containerPadding === containerPadding &&
      prev.baseFontSize === baseFontSize
        ? prev
        : { contentWidth, containerPadding, baseFontSize },
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

  // 高度优先取 AMLL 原生实测值（Σ 各组实测行高，与容器高度、播放/总览模式均无关），
  // 播放阶段即完成测量并锁定：切入总览时外壳高度零变化，动画只剩缩放本身。
  // 测量齐全前用解析式估算兜底（常量随实测字号等比推导，误差通常 < 3%）。
  // 实测结果与「题目 + 宽度 + 字号」绑定，键不匹配即视为无效（避免在 Effect 内同步 setState）。
  const measurementKey = `${linesKey}:${shellMetrics.contentWidth}:${shellMetrics.baseFontSize}`;
  const [measurement, setMeasurement] = useState<{ key: string; height: number } | null>(null);

  useEffect(() => {
    let rafId = 0;
    let frames = 0;
    let candidate: number | null = null;
    let stableFrames = 0;

    const poll = () => {
      const player = lyricPlayerRef.current?.lyricPlayer;
      if (player && player.getOverscanPx() < LYRIC_OVERSCAN_PX) {
        player.setOverscanPx(LYRIC_OVERSCAN_PX);
      }
      const measured = measureLyricOverviewHeight(player);
      if (measured !== null) {
        // 首帧测量常落在字体加载 / content-visibility 占位等瞬态上（实测可偏差 3%），
        // 必须等数值连续多帧稳定后才采信，否则会把瞬态值固化为外壳高度
        if (candidate !== null && Math.abs(candidate - measured) < 1) {
          stableFrames += 1;
        } else {
          candidate = measured;
          stableFrames = 0;
        }
        if (stableFrames >= MEASURE_STABLE_FRAMES && measured > 0) {
          setMeasurement({ key: measurementKey, height: measured });
          return;
        }
      }
      frames += 1;
      if (frames < MAX_MEASURE_FRAMES) {
        rafId = requestAnimationFrame(poll);
      }
    };

    rafId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(rafId);
  }, [measurementKey]);

  const measuredContentHeight =
    measurement && measurement.key === measurementKey ? measurement.height : null;

  // 外壳高度恒定（播放/总览同一高度）：切入总览时只有缩放在动，过渡天然连贯
  const { contentHeight, containerHeight } = useMemo(() => {
    const options = {
      lines,
      contentWidth: shellMetrics.contentWidth,
      containerPadding: shellMetrics.containerPadding,
      baseFontSize: shellMetrics.baseFontSize,
      measuredContentHeight,
    };
    return {
      contentHeight: resolveLyricContentHeight(options),
      containerHeight: calculateLyricContainerHeight(options),
    };
  }, [
    lines,
    shellMetrics.contentWidth,
    shellMetrics.containerPadding,
    shellMetrics.baseFontSize,
    measuredContentHeight,
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
        // 高度全程恒定，过渡仅是保险；总览缩放为 500ms / cubic-bezier(0.16,1,0.3,1)
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
          // 播放态本体与外壳同高（保证居中锚点落在可视区正中）；
          // 总览态本体保持未缩放的歌词自然高度，缩放后恰好填满外壳，既不裁切也不留白
          style={
            {
              "--baka-lyric-player-height": `${Math.round(resolveLyricPlayerHeight(contentHeight, isCompleted))}px`,
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
