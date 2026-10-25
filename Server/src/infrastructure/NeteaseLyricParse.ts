import { parseYrc as amllParseYrc } from "@applemusic-like-lyrics/lyric";
import { isCreditLyricLine, sanitizeLyrics } from "./LyricLines";
import { asRecord, readString } from "./JsonReaders";
import type { SongLyricLine, SongSearchResult } from "../shared/Index";

/**
 * 网易云歌词侧的纯解析函数：LRC / YRC 解析、翻译与音译合并，以及四级歌词优先链
 * 共享的输入读取与逐字歌词采纳判定。平台专有（QQ 音乐另有自己的解析），
 * 不与其它平台的同名能力混放。
 */
export const parseLrc = (raw: string): SongLyricLine[] => {
  const lines: Array<Omit<SongLyricLine, "endTime">> = [];
  const timePattern = /\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g;

  for (const sourceLine of raw.split(/\r?\n/)) {
    const timestamps = [...sourceLine.matchAll(timePattern)];
    const text = sourceLine.replace(timePattern, "").trim();
    if (!text || timestamps.length === 0) continue;

    for (const timestamp of timestamps) {
      const minutes = Number(timestamp[1]);
      const seconds = Number(timestamp[2]);
      const milliseconds = Number((timestamp[3] ?? "0").padEnd(3, "0"));
      lines.push({
        time: minutes * 60_000 + seconds * 1_000 + milliseconds,
        text,
      });
    }
  }

  lines.sort((left, right) => left.time - right.time);
  return lines.map((line, index) => ({
    ...line,
    endTime: lines[index + 1]?.time ?? line.time + 5_000,
  }));
};

export const parseYrc = (raw: string): SongLyricLine[] => {
  const amllLines = amllParseYrc(raw);
  return amllLines
    .map((line) => {
      const text =
        line.words && line.words.length > 0
          ? line.words
              .map((w) => w.word)
              .join("")
              .trim()
          : "";
      const hasTranslation = Boolean(line.translatedLyric);
      return {
        time: line.startTime,
        endTime: line.endTime,
        text,
        words:
          line.words && line.words.length > 0
            ? line.words.map((w) => ({
                startTime: w.startTime,
                endTime: w.endTime,
                word: w.word,
                romanWord: hasTranslation ? undefined : w.romanWord || undefined,
              }))
            : undefined,
        translatedLyric: line.translatedLyric || undefined,
        romanLyric: hasTranslation ? undefined : line.romanLyric || undefined,
        isBG: line.isBG || undefined,
        isDuet: line.isDuet || undefined,
      };
    })
    .filter((line) => line.text.length > 0);
};

const pickNearestLyric = (candidates: SongLyricLine[], time: number): string | undefined => {
  let best: SongLyricLine | undefined;
  let minDiff = 1500;
  for (const candidate of candidates) {
    const diff = Math.abs(candidate.time - time);
    if (diff >= minDiff) continue;
    minDiff = diff;
    best = candidate;
  }
  return best?.text.trim() || undefined;
};

/**
 * 将外文歌曲的翻译与音译歌词合并到主歌词行中。
 * 支持依据时间戳误差 <= 1500ms 智能就近匹配。
 * 规范铁律：当歌词具备翻译时，彻底清空注音（romanLyric 与 words.romanWord），仅呈现翻译。
 */
export const mergeTranslations = (
  lines: SongLyricLine[],
  translationRaw?: string,
  romanRaw?: string
): SongLyricLine[] => {
  if (!translationRaw && !romanRaw) return lines;

  const transLines = translationRaw
    ? parseLrc(translationRaw).filter((l) => !isCreditLyricLine(l.text))
    : [];
  const romanLines = romanRaw ? parseLrc(romanRaw).filter((l) => !isCreditLyricLine(l.text)) : [];

  if (transLines.length === 0 && romanLines.length === 0) return lines;

  return lines.map((line) => {
    let translatedLyric = line.translatedLyric;
    let romanLyric = line.romanLyric;

    if (!translatedLyric && transLines.length > 0) {
      translatedLyric = pickNearestLyric(transLines, line.time);
    }

    if (!romanLyric && romanLines.length > 0) {
      romanLyric = pickNearestLyric(romanLines, line.time);
    }

    // 核心规范：当行存在翻译时，屏蔽注音（仅显示翻译）
    if (translatedLyric) {
      romanLyric = undefined;
    }

    const words = line.words?.map((w) => ({
      ...w,
      romanWord: translatedLyric ? undefined : w.romanWord,
    }));

    return {
      ...line,
      words: words || line.words,
      translatedLyric: translatedLyric || undefined,
      romanLyric: romanLyric || undefined,
    };
  });
};

/** 四级歌词优先链共享的输入：本曲元数据、各级原文与其译文、音译。 */
export type LyricChainInput = {
  id: string;
  song: SongSearchResult;
  yrc?: string;
  lrc?: string;
  yrcTrans?: string;
  yrcRoma?: string;
  lrcTrans?: string;
  lrcRoma?: string;
};

/**
 * 读出歌词响应里的原文字段。
 *
 * 译文与音译各有两个来源（ytlrc 与 tlyric、yromalrc 与 romalrc）：逐字歌词优先 y 开头的
 * 那份，行级歌词优先普通那份，两边互为备选。
 */
export const readLyricSources = (
  id: string,
  song: SongSearchResult,
  lyricBody: Record<string, unknown>
): LyricChainInput => {
  const ytlrcRaw = readString(asRecord(lyricBody.ytlrc).lyric);
  const tlyricRaw = readString(asRecord(lyricBody.tlyric).lyric);
  const yromalrcRaw = readString(asRecord(lyricBody.yromalrc).lyric);
  const romalrcRaw = readString(asRecord(lyricBody.romalrc).lyric);

  return {
    id,
    song,
    yrc: readString(asRecord(lyricBody.yrc).lyric),
    lrc: readString(asRecord(lyricBody.lrc).lyric),
    yrcTrans: ytlrcRaw || tlyricRaw,
    yrcRoma: yromalrcRaw || romalrcRaw,
    lrcTrans: tlyricRaw || ytlrcRaw,
    lrcRoma: romalrcRaw || yromalrcRaw,
  };
};

/** 逐字歌词只有真的带 `words` 时间轴才算命中，否则继续降级到下一优先级。 */
export const adoptVerbatimLyrics = (
  parsed: SongLyricLine[],
  input: LyricChainInput
): SongLyricLine[] | undefined =>
  parsed.length > 0 && parsed.some((line) => line.words && line.words.length > 0)
    ? sanitizeLyrics(mergeTranslations(parsed, input.yrcTrans, input.yrcRoma), input.song)
    : undefined;
