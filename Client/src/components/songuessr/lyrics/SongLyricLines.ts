import type { LyricLine } from "@applemusic-like-lyrics/core";
import type { SongLyricLine } from "@/types";

/** 与服务端一致：有翻译时仅显示翻译，否则保留行级及逐字注音。 */
export function toAMLLLines(lines: SongLyricLine[]): LyricLine[] {
  return lines.map((line) => {
    const translatedLyric = line.translatedLyric?.trim() ?? "";
    return {
      startTime: line.time,
      endTime: line.endTime,
      translatedLyric,
      romanLyric: translatedLyric ? "" : (line.romanLyric ?? ""),
      isBG: Boolean(line.isBG),
      isDuet: Boolean(line.isDuet),
      words: line.words?.length ? line.words.map((word) => ({
        ...word,
        romanWord: translatedLyric ? "" : (word.romanWord ?? ""),
      })) : [{ startTime: line.time, endTime: line.endTime, word: line.text, romanWord: "" }],
    };
  });
}
