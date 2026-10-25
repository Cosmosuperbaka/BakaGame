/** 出题歌词切片：窗口选择、提前量与手动片段。 */
import { type RandomSource } from "../../domain/Rules";
import {
  type SongDetails,
  type SongLyricClip,
  type SongClipRange,
  SONG_CLIP_MIN_MS,
} from "../../shared/Index";
import { clampInt } from "./Records";

export const LYRIC_CLIP_LEAD_MS = 1_000;
/**
 * 上一句没有真实结束时间戳时使用的提前量。
 *
 * 行级兜底歌词的 `endTime` 是清洗时按「下一句起始时间」补算出来的，拿它当边界等于把提前量
 * 压成 0，首句会在静音渐入中唱完；因此这种情况下仍给固定提前量，只是比有逐字时间时短。
 */
export const LYRIC_CLIP_LEAD_WITHOUT_END_MS = 700;
/** 与 `sanitizeLyrics` 同一口径：只有带逐字且原始终点晚于起点的行，才算有真实结束时间戳。 */
export const hasRealLyricEnd = (line: SongDetails["lyrics"][number]) =>
  Boolean(line.words && line.words.length > 0) && line.endTime > line.time;

/**
 * 出题窗口可用的提前量：最多退到窗口前最后一句（含和声）的结束时刻。
 *
 * 退得比上一句唱完更早，玩家会在题目开始前先听半句无关唱词，歌词也跟着亮出窗口外的行。
 */
export const lyricLeadMs = (lyrics: SongDetails["lyrics"], windowStartTime: number): number => {
  let previous: SongDetails["lyrics"][number] | undefined;
  for (const line of lyrics) {
    if (line.time >= windowStartTime) continue;
    if (!previous || line.time > previous.time) previous = line;
  }
  if (!previous) return LYRIC_CLIP_LEAD_MS;
  if (!hasRealLyricEnd(previous)) return LYRIC_CLIP_LEAD_WITHOUT_END_MS;
  return Math.min(LYRIC_CLIP_LEAD_MS, Math.max(0, windowStartTime - previous.endTime));
};

export const FALLBACK_CLIP_SECONDS_PER_LINE = 6;
export const MAX_LYRIC_LINE_DURATION_MS = 12_000;
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

export const createSongLyricClip = (
  lyrics: SongDetails["lyrics"],
  lineCount: number,
  random: RandomSource,
  durationMs?: number
): SongLyricClip => {
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

  for (let count = safeCount; count >= Math.min(MIN_LYRIC_WINDOW_LINES, safeCount); count -= 1) {
    if (candidatePool.length < count) continue;
    const windows = Array.from({ length: candidatePool.length - count + 1 }, (_, startIndex) =>
      candidatePool.slice(startIndex, startIndex + count)
    ).filter(isContinuousWindow);
    if (windows.length === 0) continue;

    const padded = windows.length >= 5 ? windows.slice(2, -2) : windows;
    const candidates = padded.length > 0 ? padded : windows;
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
    const maxAllowedEnd = durationMs !== undefined ? durationMs : maxLineEnd + 1_000;
    const clipEndTime = Math.min(maxAllowedEnd, maxLineEnd + 1_000);

    return {
      startTime: clipStartTime,
      endTime: clipEndTime,
      lines: mergedLines,
    };
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
    // 取与区间有交集的歌词行：起点落在某句中间时，那一句仍然算在本片段里。
    lines: song.lyrics.filter((line) => line.time < endTime && line.endTime > startTime),
  };
};
