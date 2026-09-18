import type { SongLyricLine } from "@/types";

export function calculateLyricContainerHeight(lines: SongLyricLine[]): number {
  if (!lines || lines.length === 0) {
    return 96;
  }

  const hasAnyTranslation = lines.some((l) => Boolean(l.translatedLyric?.trim()));

  // 严格依据 AMLL 真实渲染 DOM 盒模型进行物理高度核算：
  // 1. 主歌词行：字号 1.125rem (18px)，line-height 1.8 (32.4px)，wrapper 上下 padding 0.4em (14.4px)
  //    - 单行（<= 15 字）：48px
  //    - 2 行折行（16 ~ 26 字）：80px
  //    - 3 行折行（> 26 字）：112px
  // 2. 翻译副行：字号 0.85rem (13.6px)，line-height 1.4 (19px)，margin-top 3.2px，wrapper gap 5.4px
  //    - 单行（<= 15 字）：28px
  //    - 2 行折行（16 ~ 28 字）：48px
  //    - 3 行折行（> 28 字）：68px
  // 3. 和声伴唱小字（isBG: true，字号 0.7em）：
  //    - 单行主词：30px（长词 48px）
  //    - 单行翻译：22px（长词 38px）
  // 4. 真实物理间距与容器内边距：
  //    - 行间自然间距：8px
  //    - 容器上下内边距：p-3 (24px) ~ sm:p-4 (32px) + 上下自然呼吸留白 (20px) = 52px
  //    - 每行单字度量冗余容差：每行额外提供 4px 安全缓冲，彻底杜绝字体字族差异导致的总览截断溢出
  let totalContentHeight = 0;
  for (const line of lines) {
    const mainLength = line.text ? line.text.trim().length : 0;
    const transLength = line.translatedLyric ? line.translatedLyric.trim().length : 0;
    const hasTranslation = transLength > 0;
    const isBackground = Boolean(line.isBG);

    if (isBackground) {
      let bgHeight = 30;
      if (mainLength > 24) {
        bgHeight = 48;
      }
      let bgTransHeight = 0;
      if (hasTranslation) {
        bgTransHeight = transLength > 24 ? 38 : 22;
      }
      const bgSpacing = hasTranslation ? 10 : 8;
      totalContentHeight += bgHeight + bgTransHeight + bgSpacing;
    } else {
      let mainHeight = 48;
      if (mainLength > 26) {
        mainHeight = 112;
      } else if (mainLength > 15) {
        mainHeight = 80;
      }

      let translationHeight = 0;
      if (hasTranslation) {
        if (transLength > 28) {
          translationHeight = 68;
        } else if (transLength > 15) {
          translationHeight = 48;
        } else {
          translationHeight = 28;
        }
      }

      const spacing = hasTranslation ? 12 : 8;
      totalContentHeight += mainHeight + translationHeight + spacing;
    }
  }

  // 容器上下内边距 (p-3/sm:p-4 约 24~32px) + 上下呼吸留白与每行 4px 安全冗余
  const basePadding = 52;
  const lineHeadroom = lines.length * 4;
  const calculatedHeight = Math.ceil(totalContentHeight + basePadding + lineHeadroom);

  // 兜底最小高度
  const minHeight = hasAnyTranslation ? 160 : 120;
  return Math.max(minHeight, calculatedHeight);
}

