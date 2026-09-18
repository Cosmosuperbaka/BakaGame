import type { LyricPlayerBase } from "@applemusic-like-lyrics/core";
import type { SongLyricLine } from "@/types";

/**
 * 歌词组件高度核算。
 *
 * 官方文档（改动歌词组件前必读）：https://amll.dev/
 *
 * AMLL 内核（`@applemusic-like-lyrics/core`）暴露了原生实测接口：
 * - `player.currentLyricGroups`：当前全部歌词组（主行 + 可能的和声副行）实例；
 * - `player.lyricGroupSize`：`WeakMap<歌词组, [宽, 高]>`，由内核 `ResizeObserver`
 *   对每组的 `.lyricLineWrapper` 实测 `clientWidth/clientHeight` 写入。
 *
 * 内核 `calcLayout()` 的排布算法为「自顶向下按已测行高累加」（`alignAnchor=top`
 * 且 `alignPosition=0` 时首行贴顶、组间无额外间距），因此
 *
 *     Σ lyricGroupSize.get(group)[1]
 *
 * 就是总览所需的精确内容高度，且与容器高度无关（已实测验证：容器 200 / 400 /
 * 800 / 3000px 下累加值完全一致）。真实浏览器中一旦测量齐全即以该值为准；
 * 解析式估算仅用于测量到位前的首帧与无布局环境（jsdom / 预渲染）兜底。
 */

/** 总览模式缩放系数，必须与 Client/src/index.css 中 `.baka-overview-mode` 的 transform 一致 */
export const LYRIC_OVERVIEW_SCALE = 0.92;

/** AMLL 盒模型：所有常量都由「播放器实测字号」推导，随根字号/缩放自动等比，禁止写死像素 */
export interface LyricBoxMetrics {
  /** 主歌词行字号（内核 `--amll-lp-font-size: 1.125rem` 的实测像素值） */
  fontSize: number;
  /** 主行行高：内核 `.amll-lyric-player.dom { line-height: 1.2 }` */
  lineHeight: number;
  /** 翻译副行字号：`0.85rem / 1.125rem × fontSize` */
  subFontSize: number;
  /** 副行行高：`[class*="lyricSubLine"] { line-height: 1.4 }` */
  subLineHeight: number;
  /** 副行上间距：`margin-top: .2rem` 折算到主行字号 */
  subMarginTop: number;
  /** 和声伴唱字号：`--amll-lp-bg-line-scale: .7`，下限 10px */
  bgFontSize: number;
  bgLineHeight: number;
  /** 歌词组上下 padding 合计：总览/播放统一 `.25em × 2` */
  wrapperPaddingY: number;
  /** 歌词组左右 padding：`--lyric-line-padding-x: 1em` */
  wrapperPaddingX: number;
  /** 主行与和声副行之间的 `gap: .2em` */
  groupGap: number;
}

/** 无法实测字号（jsdom、首帧）时的兜底字号：1.125rem @ 16px 根字号 */
export const FALLBACK_BASE_FONT_SIZE = 18;

/** 无法读取容器宽度（jsdom、首帧）时的兜底文本宽度 */
export const FALLBACK_CONTENT_WIDTH = 560;

/** 由主行字号推导整套装箱常量（比例全部来自 AMLL 内核与 Client/src/index.css） */
export function resolveLyricBoxMetrics(baseFontSize: number): LyricBoxMetrics {
  const fontSize = baseFontSize > 0 ? baseFontSize : FALLBACK_BASE_FONT_SIZE;
  return {
    fontSize,
    lineHeight: fontSize * 1.2,
    subFontSize: (fontSize * 0.85) / 1.125,
    subLineHeight: (fontSize * 0.85) / 1.125 * 1.4,
    subMarginTop: (fontSize * 0.2) / 1.125,
    bgFontSize: Math.max(fontSize * 0.7, 10),
    bgLineHeight: Math.max(fontSize * 0.7, 10) * 1.2,
    wrapperPaddingY: fontSize * 0.5,
    wrapperPaddingX: fontSize,
    groupGap: fontSize * 0.2,
  };
}

/** 每组折行估算的安全冗余，宁可略高也不低估 */
const GROUP_SAFETY_MARGIN = 2;

/** 单行歌词最小可用文本宽度，避免除零与极端窄屏 */
const MIN_TEXT_WIDTH = 96;

export interface LyricContainerHeightOptions {
  lines: SongLyricLine[];
  /** 歌词行实际可用的文本宽度（px），≤0 时按 {@link FALLBACK_CONTENT_WIDTH} 处理 */
  contentWidth: number;
  /** 外壳上下 padding + border 之和（px） */
  containerPadding: number;
  /** 主歌词行实测字号（px）；缺省用 {@link FALLBACK_BASE_FONT_SIZE} */
  baseFontSize?: number;
  /** AMLL 原生实测的未缩放总览高度；为空时退回解析式估算 */
  measuredContentHeight?: number | null;
}

/** 读取内核原生实测的全部歌词组高度；任一未测量齐全则返回 `null` */
export function readMeasuredGroupHeights(player?: LyricPlayerBase | null): number[] | null {
  if (!player) return null;

  // `currentLyricGroups` / `lyricGroupSize` 是内核公开字段，但未收敛进 React 绑定的
  // `LyricPlayerRef` 类型，这里做一次受控的结构化读取。
  const source = player as unknown as {
    currentLyricGroups?: readonly unknown[];
    lyricGroupSize?: WeakMap<object, [number, number]>;
  };
  const groups = source.currentLyricGroups;
  const sizeMap = source.lyricGroupSize;
  if (!groups || groups.length === 0 || !sizeMap) return null;

  const heights: number[] = [];
  for (const group of groups) {
    const size = sizeMap.get(group as object);
    if (!size || !(size[1] > 0)) return null;
    heights.push(size[1]);
  }
  return heights;
}

/**
 * AMLL 原生实测的总览内容高度（未缩放）。
 *
 * 只要每组都已实测且仍挂载在 DOM 上即采信：歌词组上下 padding 已在 CSS 层统一为
 * 模式无关（见 `index.css` 的 `.baka-lyric-player [class*="lyricLineWrapper"]`），
 * 实测值因此跨模式稳定，无需再做一致性校验；且内核 `.lyricLine` 带
 * `content-visibility: auto`，远离视口时会用占位尺寸重排，逐帧比对 clientHeight
 * 反而会让测量永远无法收敛。调用方必须配合调大 `overscanPx` 全量挂载，
 * 否则会陷入「外壳太矮 → 末尾行不挂载 → 测不到 → 高度算不准」的死循环。
 */
export function measureLyricOverviewHeight(player?: LyricPlayerBase | null): number | null {
  const heights = readMeasuredGroupHeights(player);
  if (!heights) return null;

  const source = player as unknown as { currentLyricGroups?: readonly unknown[] };
  const groups = source.currentLyricGroups ?? [];
  for (let i = 0; i < groups.length; i += 1) {
    const element = (groups[i] as { element?: HTMLElement }).element;
    if (!element || !element.isConnected) return null;
  }
  return heights.reduce((total, height) => total + height, 0);
}

/** 统计文本在当前字号下的显示宽度（全角字符按 1em，拉丁字符按 0.5em 估算） */
function estimateTextWidth(text: string, charWidth: number): number {
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    width += codePoint <= 0xff ? charWidth * 0.5 : charWidth;
  }
  return width;
}

function estimateLineCount(text: string, availableWidth: number, charWidth: number): number {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(estimateTextWidth(trimmed, charWidth) / availableWidth));
}

/** 依据 AMLL 真实盒模型估算单个歌词组的高度（未缩放） */
function estimateGroupHeight(
  line: SongLyricLine,
  backgroundLines: SongLyricLine[],
  availableWidth: number,
  box: LyricBoxMetrics,
): number {
  let height = box.wrapperPaddingY;
  height += estimateLineCount(line.text, availableWidth, box.fontSize) * box.lineHeight;

  const translation = line.translatedLyric?.trim();
  if (translation) {
    height +=
      box.subMarginTop +
      estimateLineCount(translation, availableWidth, box.subFontSize) * box.subLineHeight;
  }

  for (const background of backgroundLines) {
    height += box.groupGap;
    height += estimateLineCount(background.text, availableWidth, box.bgFontSize) * box.bgLineHeight;
    const backgroundTranslation = background.translatedLyric?.trim();
    if (backgroundTranslation) {
      height +=
        box.subMarginTop +
        estimateLineCount(backgroundTranslation, availableWidth, box.subFontSize) * box.subLineHeight;
    }
  }

  return height + GROUP_SAFETY_MARGIN;
}

/**
 * 解析式估算总览内容高度（未缩放）。
 *
 * 仅作兜底：真实浏览器中测量到位后由 {@link measureLyricOverviewHeight} 的原生实测值取代。
 */
export function estimateLyricOverviewHeight(
  lines: SongLyricLine[],
  contentWidth: number,
  baseFontSize: number = FALLBACK_BASE_FONT_SIZE,
): number {
  if (!lines || lines.length === 0) return 0;

  const box = resolveLyricBoxMetrics(baseFontSize);
  const width = contentWidth > 0 ? contentWidth : FALLBACK_CONTENT_WIDTH;
  const availableWidth = Math.max(width - box.wrapperPaddingX * 2, MIN_TEXT_WIDTH);

  let total = 0;
  let pendingBackground: SongLyricLine[] = [];
  for (const line of lines) {
    if (line.isBG) {
      pendingBackground.push(line);
      continue;
    }
    total += estimateGroupHeight(line, pendingBackground, availableWidth, box);
    pendingBackground = [];
  }
  // 首行即和声（无主行可挂靠）时内核会自建一组，这里同样按独立组核算
  for (const background of pendingBackground) {
    total += estimateGroupHeight(background, [], availableWidth, box);
  }

  return total;
}

/**
 * 计算注入给 AMLL 播放器本体的高度（未缩放）。
 *
 * 外壳高度恒定按 {@link LYRIC_OVERVIEW_SCALE} 反向补偿（播放/总览同一高度，切换零跳变），
 * 因此总览态播放器本体必须保持未缩放的歌词自然高度，才能既不被外壳裁切、又不留多余留白；
 * 播放态本体与外壳同高，保证居中锚点落在可视区正中。
 */
export function resolveLyricPlayerHeight(contentHeight: number, overview: boolean): number {
  return overview ? contentHeight : contentHeight * LYRIC_OVERVIEW_SCALE;
}

export function resolveLyricContentHeight(options: LyricContainerHeightOptions): number {
  if (options.lines.length === 0) return 0;
  if (options.measuredContentHeight && options.measuredContentHeight > 0) {
    return options.measuredContentHeight;
  }
  return estimateLyricOverviewHeight(options.lines, options.contentWidth, options.baseFontSize);
}

/**
 * 计算歌词组件的外壳高度。
 *
 * 播放与总览共用同一高度（`SCALE × 内容自然高度 + 外壳上下内边距`）：
 * 切换总览时外壳高度零变化，动画只剩缩放本身，杜绝两次过渡叠加造成的不连贯。
 */
export function calculateLyricContainerHeight(options: LyricContainerHeightOptions): number {
  const contentHeight = resolveLyricContentHeight(options);
  return Math.ceil(contentHeight * LYRIC_OVERVIEW_SCALE + options.containerPadding);
}
