import type { SongLyricLine, SongSearchResult } from "../../../shared/Index";
import { isCreditLyricLine, isCreditTailLine } from "./LyricCreditClassifier";
import {
  isAffiliationCreditLine,
  isBopomofoOnlyLyricLine,
  isBracketedStageDirectionLine,
  isCopyrightNoticeLine,
  isDuetRoleLine,
  isInstrumentalLyricLine,
  isNumericOnlyLyricLine,
  isPlaceholderMaskLyricLine,
  isPlatformCreditLine,
  isSymbolOnlyLyricLine,
  isTechnicalInfoLine,
  isTooShortLyricLine,
} from "./LyricNoiseClassifier";
import { normalizeLyricComparable } from "./LyricText";

/**
 * 单行是否属于「不可用于出题」的无效歌词。
 *
 * 与 `sanitizeLyrics` 使用同一套单行判定。
 */
export const isUnusableLyricLine = (text: string): boolean =>
  isCreditLyricLine(text) ||
  isCopyrightNoticeLine(text) ||
  isTechnicalInfoLine(text) ||
  isAffiliationCreditLine(text) ||
  isPlatformCreditLine(text) ||
  isDuetRoleLine(text) ||
  isInstrumentalLyricLine(text) ||
  isSymbolOnlyLyricLine(text) ||
  isNumericOnlyLyricLine(text) ||
  isBopomofoOnlyLyricLine(text) ||
  isPlaceholderMaskLyricLine(text) ||
  isBracketedStageDirectionLine(text) ||
  isTooShortLyricLine(text);

/** 相邻署名行的合并窗口：制作名单通常连续排布，间隔往往在 3 秒内。 */
const CREDIT_BLOCK_GAP_MS = 3_000;

/**
 * 去掉作词、作曲、编曲等署名，以及歌手、专辑这类纯元数据标题行。
 * 过滤后重新计算每句结束时间，避免被删除的元数据行造成音频切片错位。
 *
 * 过滤分三步：单行无效判定（署名 / 间奏 / 符号 / 数字 / 过短）→
 * 连排署名块整体剔除 → 元数据标题行剔除。不做重复行去重：副歌的每一次演唱都要保留。
 *
 * 唱到歌名的整行歌词**不剔除**：那是真实演唱内容，删掉会让歌词少一句、
 * 时间轴出现空洞，还会把相邻两段唱词拼到同一个出题窗口里（曾经因此把副歌切坏）。
 * 「歌名+歌手」的连写仍在剔除范围内 —— 那种形态只出现在上传谱的表头，不会是唱词。
 */
export const sanitizeLyrics = (
  lyrics: SongLyricLine[],
  song: Pick<SongSearchResult, "title" | "artist" | "album">
): SongLyricLine[] => {
  const title = normalizeLyricComparable(song.title);
  const album = song.album ? normalizeLyricComparable(song.album) : "";
  const artistTokens = song.artist
    .split(/[/,、&与和]/)
    .map(normalizeLyricComparable)
    .filter((token) => token.length >= 2);
  const wholeArtist = normalizeLyricComparable(song.artist);

  const forbidden = new Set(
    [
      wholeArtist,
      ...artistTokens,
      album,
      `${title}${wholeArtist}`,
      `${wholeArtist}${title}`,
    ].filter(Boolean)
  );

  // 第一步：单行无效判定，得到「署名行位置」用于后续连排合并。
  const invalid = lyrics.map((line) => isUnusableLyricLine(line.text));
  const creditLine = lyrics.map((line) => isCreditLyricLine(line.text));

  // 第二步：制作名单常连续排布（截图里连排 5 行），相邻署名行整块剔除，
  // 避免「翻唱」后面的纯人名续行因为不含标签而被漏掉。
  for (let index = 1; index < lyrics.length; index += 1) {
    if (!creditLine[index] && !creditLine[index - 1]) continue;
    if (lyrics[index].time - lyrics[index - 1].time > CREDIT_BLOCK_GAP_MS) continue;
    if (!isCreditTailLine(lyrics[index].text)) continue;
    invalid[index] = true;
  }

  const filtered = lyrics.filter((line, index) => {
    if (invalid[index]) return false;

    const normalizedLine = normalizeLyricComparable(line.text);
    if (forbidden.has(normalizedLine)) return false;
    return true;
  });

  return filtered.map((line, index) => {
    if (line.words && line.words.length > 0 && line.endTime > line.time) return line;
    // 行级歌词的结束时刻取下一个起点严格更晚的行：原文与译文同起点时共享结束时刻，
    // 否则前一行的时长为零，会被出题切片判成不可用而丢掉整首歌的歌词窗口。
    const next = filtered.slice(index + 1).find((candidate) => candidate.time > line.time);
    return { ...line, endTime: next?.time ?? Math.max(line.endTime, line.time + 5_000) };
  });
};
