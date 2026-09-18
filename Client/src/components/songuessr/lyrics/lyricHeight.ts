import type { SongLyricLine } from "@/types";

export function calculateLyricContainerHeight(lines: SongLyricLine[]): number {
  if (!lines || lines.length === 0) {
    return 96;
  }

  const hasAnyTranslation = lines.some((l) => Boolean(l.translatedLyric?.trim()));

  // 精确区分主歌词、和声伴唱小字（isBG）、双语翻译行及潜在折行的真实高度预算
  let totalContentHeight = 0;
  for (const line of lines) {
    const mainLength = line.text ? line.text.trim().length : 0;
    const transLength = line.translatedLyric ? line.translatedLyric.trim().length : 0;
    const hasTranslation = transLength > 0;
    const isBackground = Boolean(line.isBG);

    if (isBackground) {
      // 和声伴唱小字在 AMLL 中字号为 0.7em（约 12~14px），行高紧凑
      let bgHeight = 22;
      if (mainLength > 24) {
        bgHeight = 38;
      }
      let bgTransHeight = 0;
      if (hasTranslation) {
        bgTransHeight = transLength > 24 ? 30 : 18;
      }
      const bgSpacing = hasTranslation ? 12 : 8;
      totalContentHeight += bgHeight + bgTransHeight + bgSpacing;
    } else {
      // 主歌词行（字号 1.125rem，单行高度约 32px）
      let mainHeight = 32;
      if (mainLength > 24) {
        mainHeight = 54;
      } else if (mainLength > 16) {
        mainHeight = 42;
      }

      // 翻译副文本行（字号 0.85rem，单行高度约 20px）
      let translationHeight = 0;
      if (hasTranslation) {
        if (transLength > 30) {
          translationHeight = 44;
        } else if (transLength > 18) {
          translationHeight = 32;
        } else {
          translationHeight = 22;
        }
      }

      // 仅在存在翻译时留出副行间距，无翻译时采用紧凑主行间距
      const spacing = hasTranslation ? 14 : 10;
      totalContentHeight += mainHeight + translationHeight + spacing;
    }
  }

  // 容器上下内边距 (p-3/sm:p-4 约 24~32px) + 顶部对齐起始偏移与呼吸留白
  const basePadding = hasAnyTranslation ? 44 : 32;
  const calculatedHeight = Math.ceil(totalContentHeight + basePadding);

  // 无翻译时最小高度紧凑（110px 即可容纳 1~2 句），有翻译时保证适度呼吸感（140px）
  const minHeight = hasAnyTranslation ? 140 : 110;
  return Math.max(minHeight, calculatedHeight);
}
