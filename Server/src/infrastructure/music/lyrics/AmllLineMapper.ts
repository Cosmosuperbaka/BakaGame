import type { SongLyricLine } from "../../../shared/Index";

/** AMLL 解析器（TTML、YRC、QRC）产出的行：只列出映射用到的字段。 */
interface AmllLine {
  startTime: number;
  endTime: number;
  words?: ReadonlyArray<{
    startTime: number;
    endTime: number;
    word: string;
    romanWord?: string;
  }>;
  translatedLyric?: string;
  romanLyric?: string;
  isBG?: boolean;
  isDuet?: boolean;
}

/**
 * AMLL 逐字行 → 站内歌词行。
 *
 * 规范铁律：行带翻译时彻底清空注音（行级与逐字级），只呈现翻译；没有文字的行丢弃。
 */
export const fromAmllLines = (amllLines: readonly AmllLine[]): SongLyricLine[] =>
  amllLines
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
