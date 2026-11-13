/**
 * TTML 歌词解析：AMLL 的解析器要求全局 DOMParser，补齐环境放在本模块顶层，
 * 所有解析入口都经过这里，所以谁引入解析谁就拿到环境。
 */
import { parseTTML as amllParseTTML } from "@applemusic-like-lyrics/ttml";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { SongLyricLine } from "../../../shared/Index";

// AMLL 的 TTML 解析器要求 globalThis.DOMParser；谁提供解析就谁负责补齐它需要的运行环境。
if (typeof globalThis.DOMParser === "undefined") {
  globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;
}
if (typeof globalThis.XMLSerializer === "undefined") {
  globalThis.XMLSerializer = XMLSerializer as unknown as typeof globalThis.XMLSerializer;
}

export const parseTTML = (raw: string): SongLyricLine[] => {
  let normalizedRaw = raw;
  if (!normalizedRaw.includes("xmlns:itunes=")) {
    normalizedRaw = normalizedRaw.replace(
      /<tt(\s|>)/i,
      '<tt xmlns:itunes="http://music.apple.com/lyric-ttml-internal"$1'
    );
  }
  if (!normalizedRaw.includes("itunes:key=")) {
    let lineIndex = 1;
    normalizedRaw = normalizedRaw.replace(/<p(\s+)/gi, () => `<p itunes:key="L${lineIndex++}" `);
  }
  const parsed = amllParseTTML(normalizedRaw);
  return parsed.lines
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
