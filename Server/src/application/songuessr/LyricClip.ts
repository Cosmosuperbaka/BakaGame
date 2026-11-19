/** 出题歌词切片：窗口选择、提前量与手动片段。 */
import { type RandomSource } from "../../domain/Rules";
import {
  type SongDetails,
  type SongLyricClip,
  type SongClipRange,
  isLyricLineInClip,
  LYRIC_CLIP_TAIL_MS,
  lyricLeadMs,
  MAX_LYRIC_LINE_DURATION_MS,
  SONG_CLIP_MIN_MS,
} from "../../shared/Index";
import { countTitleLines, prepareTitleNames } from "./LyricTitleGuard";
import { clampInt } from "./Records";

export const FALLBACK_CLIP_SECONDS_PER_LINE = 6;
/**
 * 歌词片段相邻两句之间的最大间奏间隔。
 *
 * 如果相邻两句歌词之间的时间跨度超过此阈值，说明歌曲进入了较长的吉他/管弦等乐器间奏（如《一样的月光》中间 54 秒间奏），
 * 绝不能把分属两段演唱的歌词跨越长间奏拼接为一个出题窗口，否则会导致玩家在数十秒死寂中等待。
 */
export const MAX_LYRIC_INTERLUDE_GAP_MS = 6_000;
/**
 * 歌词窗口收缩下限。
 *
 * 单行歌词不足以出题（相邻两句的上下文才算一个可猜片段），因此设定行数
 * 高于 2 时，窗口不允许收缩到 2 行以下；设定 1 行时按用户意愿保留 1 行窗口。
 */
export const MIN_LYRIC_WINDOW_LINES = 2;

/**
 * 随机切片。`titleNames` 给出时（歌名与别名），先尽量选不含歌名的区间：
 * 从设定行数起逐行收缩，每个行数都先只看不含歌名的窗口；所有行数下都找不到干净窗口，
 * 才回退到含歌名的窗口，并在其中挑唱出歌名行数最少的。收缩仍受 `MIN_LYRIC_WINDOW_LINES` 约束，
 * 连续性、单行跨度等既有门槛不因回避歌名而放宽。手动自定义区间不经过本函数。
 */
export const createSongLyricClip = (
  lyrics: SongDetails["lyrics"],
  lineCount: number,
  random: RandomSource,
  durationMs?: number,
  titleNames?: readonly string[]
): SongLyricClip => {
  const prepared = prepareTitleNames(titleNames ?? []);
  const safeCount = clampInt(lineCount, 1, 10);
  const isCompactLine = (line: SongDetails["lyrics"][number]) =>
    line.endTime > line.time && line.endTime - line.time <= MAX_LYRIC_LINE_DURATION_MS;

  const isContinuousWindow = (lines: SongDetails["lyrics"]) => {
    if (!lines.every(isCompactLine)) return false;
    for (let i = 1; i < lines.length; i++) {
      const gap = lines[i].time - lines[i - 1].endTime;
      if (gap > MAX_LYRIC_INTERLUDE_GAP_MS) return false;
    }
    return true;
  };

  // 1. 区分主歌词与和声/背景歌词（isBG）。
  // 选词滑动窗口仅以主歌词为候选基准，禁止和声歌词作为出题开头或充抵出题行数，
  // 避免和声小字过早切断主歌词音频。
  const mainLyrics = lyrics.filter((line) => !line.isBG);
  const candidatePool =
    mainLyrics.length >= Math.min(MIN_LYRIC_WINDOW_LINES, safeCount) ? mainLyrics : lyrics;

  const windowsOf = (count: number) =>
    Array.from({ length: Math.max(0, candidatePool.length - count + 1) }, (_, startIndex) =>
      candidatePool.slice(startIndex, startIndex + count)
    ).filter(isContinuousWindow);
  /** 窗口实际展示给玩家的行：含落在区间内的和声行。 */
  const shownLines = (window: SongDetails["lyrics"]) => {
    const start = window[0].time;
    const end = window.at(-1)!.endTime;
    const inside = lyrics.filter((line) => line.time >= start && line.time < end);
    return inside.length > 0 ? inside : window;
  };

  const buildClip = (candidates: SongDetails["lyrics"][]): SongLyricClip => {
    const selectedMainLines = candidates[random.nextInt(candidates.length)];
    const windowStartTime = selectedMainLines[0].time;
    const windowEndTime = selectedMainLines.at(-1)!.endTime;

    // 从完整歌词中提取出落在该出题区间内的所有歌词（包含和声歌词），仅用于播放时演出
    const clipLines = lyrics.filter(
      (line) => line.time >= windowStartTime && line.time < windowEndTime
    );
    const mergedLines = clipLines.length > 0 ? clipLines : selectedMainLines;
    mergedLines.sort((a, b) => a.time - b.time);

    const maxLineEnd = Math.max(windowEndTime, ...mergedLines.map((l) => l.endTime));
    // 前置提前量供音频平滑渐入，但不越过上一句歌词的结尾；终点后延 1 秒供渐出。
    const clipStartTime = Math.max(0, windowStartTime - lyricLeadMs(lyrics, windowStartTime));
    const maxAllowedEnd = durationMs !== undefined ? durationMs : maxLineEnd + LYRIC_CLIP_TAIL_MS;
    const clipEndTime = Math.min(maxAllowedEnd, maxLineEnd + LYRIC_CLIP_TAIL_MS);

    return {
      startTime: clipStartTime,
      endTime: clipEndTime,
      lines: mergedLines,
    };
  };

  /** 某个行数下可选的窗口；`clean` 只要不含歌名的，`any` 取唱出歌名最少的那批。 */
  const chooseWindows = (count: number, pass: "clean" | "any"): SongDetails["lyrics"][] => {
    if (candidatePool.length < count) return [];
    const windows = windowsOf(count);
    // 避开曲首曲尾的窗口先于歌名过滤划定，再在其中筛；筛空才放开到全部窗口。
    const padded = windows.length >= 5 ? windows.slice(2, -2) : windows;
    if (prepared.length === 0) return padded.length > 0 ? padded : windows;
    const hits = new Map(
      windows.map((window) => [window, countTitleLines(shownLines(window), prepared)])
    );
    const select = (group: SongDetails["lyrics"][]) => {
      if (group.length === 0) return group;
      const target = pass === "clean" ? 0 : Math.min(...group.map((window) => hits.get(window)!));
      return group.filter((window) => hits.get(window) === target);
    };
    const preferred = select(padded);
    return preferred.length > 0 ? preferred : select(windows);
  };

  // 先按行数收缩找「干净」窗口；整条收缩路径上都没有，再放开含歌名的窗口重走一遍。
  const passes: ("clean" | "any")[] = prepared.length > 0 ? ["clean", "any"] : ["any"];
  const minCount = Math.min(MIN_LYRIC_WINDOW_LINES, safeCount);
  for (const pass of passes) {
    for (let count = safeCount; count >= minCount; count -= 1) {
      const chosen = chooseWindows(count, pass);
      if (chosen.length > 0) return buildClip(chosen);
    }
  }

  const clipDuration = safeCount * FALLBACK_CLIP_SECONDS_PER_LINE * 1_000;
  const songDuration = Math.max(1, durationMs ?? clipDuration);
  const actualClipDuration = Math.min(clipDuration, songDuration);
  const latestStart = Math.max(0, songDuration - actualClipDuration);
  const startTime = random.nextInt(latestStart + 1);

  return {
    startTime,
    endTime: startTime + actualClipDuration,
    lines: [],
  };
};

/**
 * 手动出题的自定义片段。`clip` 缺省时返回 undefined，调用方沿用自动切片。
 *
 * 长度下限 5 秒、终点不越过歌曲时长（时长未知时不做上界校验），上限就是整首。
 * 越界或参数不成立时返回 undefined，由调用方回退到**原来的随机切片**：
 * 手动路径的兜底与「没配片段」完全一致，不把一次手滑变成整首 3 分钟。
 */
export const createManualLyricClip = (
  song: Pick<SongDetails, "lyrics" | "durationMs">,
  clip: SongClipRange | undefined
): SongLyricClip | undefined => {
  if (!clip) return undefined;
  const { startTime, endTime } = clip;
  const length = endTime - startTime;
  const withinSong = song.durationMs === undefined || endTime <= song.durationMs;
  const valid =
    Number.isFinite(startTime) &&
    Number.isFinite(endTime) &&
    startTime >= 0 &&
    endTime > startTime &&
    length >= SONG_CLIP_MIN_MS &&
    withinSong;
  if (!valid) return undefined;
  return {
    startTime,
    endTime,
    lines: song.lyrics.filter((line) => isLyricLineInClip(line, startTime, endTime)),
  };
};
