import type { SongLyricLine } from "@/types";

export function calculateLyricContainerHeight(lines: SongLyricLine[]): number {
  if (!lines || lines.length === 0) {
    return 180;
  }

  // 计算每行歌词的真实渲染高度（包含主歌词、双语翻译行、折行预算与 AMLL 物理间距）
  let totalContentHeight = 0;
  for (const line of lines) {
    const mainLength = line.text ? line.text.trim().length : 0;
    const transLength = line.translatedLyric ? line.translatedLyric.trim().length : 0;
    const hasTranslation = transLength > 0;

    // 主歌词高度估算（字号 1.125rem，行高 1.8，单行约 34px）
    let mainHeight = 36;
    if (mainLength > 24) {
      mainHeight = 64;
    } else if (mainLength > 16) {
      mainHeight = 48;
    }

    // 翻译歌词高度估算（字号 0.85rem，行高 1.4，单行约 20px）
    let translationHeight = 0;
    if (hasTranslation) {
      if (transLength > 30) {
        translationHeight = 48;
      } else if (transLength > 18) {
        translationHeight = 36;
      } else {
        translationHeight = 24;
      }
    }

    // AMLL 行间内边距 (padding 0.4em * 2) 与主副行间距 (gap 0.3em) 约为 16~24px
    const spacing = hasTranslation ? 24 : 16;
    totalContentHeight += mainHeight + translationHeight + spacing;
  }

  // 容器上下内边距 (p-3/sm:p-4 约 32px) + AMLL 顶部对齐起始偏移与底部呼吸留白 (约 40px)
  const basePadding = 72;
  const calculatedHeight = Math.ceil(totalContentHeight + basePadding);

  return Math.max(220, calculatedHeight);
}
