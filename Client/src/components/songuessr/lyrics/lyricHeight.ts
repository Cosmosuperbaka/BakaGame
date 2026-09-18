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

/** AMLL 盒模型常量（与 Client/src/index.css、内核 style.css 对齐，单位 px） */
const FONT_SIZE = 18; // --amll-lp-font-size: 1.125rem
const LINE_HEIGHT = FONT_SIZE * 1.2; // 内核 .amll-lyric-player.dom { line-height: 1.2 }
const SUB_FONT_SIZE = 0.85 * 16; // [class*="lyricSubLine"] { font-size: .85rem }
const SUB_LINE_HEIGHT = SUB_FONT_SIZE * 1.4; // [class*="lyricSubLine"] { line-height: 1.4 }
const SUB_MARGIN_TOP = 0.2 * 16; // [class*="lyricSubLine"] { margin-top: .2rem }
const BG_FONT_SIZE = Math.max(FONT_SIZE * 0.7, 10); // --amll-lp-bg-line-scale: .7，下限 10px
const BG_LINE_HEIGHT = BG_FONT_SIZE * 1.2;
const WRAPPER_PADDING_Y = 0.25 * FONT_SIZE * 2; // 总览模式 .lyricLineWrapper 上下 padding .25em
const WRAPPER_PADDING_X = FONT_SIZE; // --lyric-line-padding-x: 1em
const WRAPPER_GAP = 0.2 * FONT_SIZE; // 总览模式 .lyricLineWrapper { gap: .2em }
/** 每行折行估算的字族容差，宁可略高也不低估 */
const GROUP_SAFETY_MARGIN = 2;

/** 无法读取容器宽度（jsdom、首帧）时的兜底文本宽度 */
export const FALLBACK_CONTENT_WIDTH = 560;

/** 单行歌词最小可用文本宽度，避免除零与极端窄屏 */
const MIN_TEXT_WIDTH = 96;

export interface LyricContainerHeightOptions {
  lines: SongLyricLine[];
  /** 歌词行实际可用的文本宽度（px），≤0 时按 {@link FALLBACK_CONTENT_WIDTH} 处理 */
  contentWidth: number;
  /** 外壳上下 padding + border 之和（px） */
  containerPadding: number;
  /** AMLL 原生实测的未缩放总览高度；为空时退回解析式估算 */
  measuredContentHeight?: number | null;
  /** 是否处于总览模式：总览存在 `scale(0.92)` 缩小动效，需做反向补偿 */
  overview?: boolean;
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
 * 除「已测量」外还要求测量值与元素当前 `clientHeight` 一致：切入总览时内核
 * `.lyricLineWrapper` 的上下 padding 会由 `.4em` 变为 `.25em`，旧值会短暂残留，
 * 该一致性校验确保读到的永远是切到总览后的新鲜值。任一歌词组尚未进入视野
 * （内核按 `overscanPx` 挂载 DOM）时返回 `null`，由调用方下一帧重试。
 */
export function measureLyricOverviewHeight(player?: LyricPlayerBase | null): number | null {
  const heights = readMeasuredGroupHeights(player);
  if (!heights) return null;

  const source = player as unknown as { currentLyricGroups?: readonly unknown[] };
  const groups = source.currentLyricGroups ?? [];
  for (let i = 0; i < groups.length; i += 1) {
    const element = (groups[i] as { element?: HTMLElement }).element;
    if (!element || !element.isConnected || element.clientHeight !== heights[i]) return null;
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

/** 依据 AMLL 真实盒模型估算单个歌词组的高度（总览模式，未缩放） */
function estimateGroupHeight(
  line: SongLyricLine,
  backgroundLines: SongLyricLine[],
  availableWidth: number,
): number {
  let height = WRAPPER_PADDING_Y;
  height += estimateLineCount(line.text, availableWidth, FONT_SIZE) * LINE_HEIGHT;

  const translation = line.translatedLyric?.trim();
  if (translation) {
    height +=
      SUB_MARGIN_TOP + estimateLineCount(translation, availableWidth, SUB_FONT_SIZE) * SUB_LINE_HEIGHT;
  }

  for (const background of backgroundLines) {
    height += WRAPPER_GAP;
    height += estimateLineCount(background.text, availableWidth, BG_FONT_SIZE) * BG_LINE_HEIGHT;
    const backgroundTranslation = background.translatedLyric?.trim();
    if (backgroundTranslation) {
      height +=
        SUB_MARGIN_TOP +
        estimateLineCount(backgroundTranslation, availableWidth, SUB_FONT_SIZE) * SUB_LINE_HEIGHT;
    }
  }

  return height + GROUP_SAFETY_MARGIN;
}

/**
 * 解析式估算总览内容高度（未缩放）。
 *
 * 仅作兜底：真实浏览器中测量到位后由 {@link measureLyricOverviewHeight} 的原生实测值取代。
 */
export function estimateLyricOverviewHeight(lines: SongLyricLine[], contentWidth: number): number {
  if (!lines || lines.length === 0) return 0;

  const width = contentWidth > 0 ? contentWidth : FALLBACK_CONTENT_WIDTH;
  const availableWidth = Math.max(width - WRAPPER_PADDING_X * 2, MIN_TEXT_WIDTH);

  let total = 0;
  let pendingBackground: SongLyricLine[] = [];
  for (const line of lines) {
    if (line.isBG) {
      pendingBackground.push(line);
      continue;
    }
    total += estimateGroupHeight(line, pendingBackground, availableWidth);
    pendingBackground = [];
  }
  // 首行即和声（无主行可挂靠）时内核会自建一组，这里同样按独立组核算
  for (const background of pendingBackground) {
    total += estimateGroupHeight(background, [], availableWidth);
  }

  return total;
}

/**
 * 计算注入给 AMLL 播放器本体的高度（未缩放）。
 *
 * 总览模式外壳按 {@link LYRIC_OVERVIEW_SCALE} 反向补偿，播放器本体必须保持未缩放的
 * 歌词自然高度，才能既不被外壳裁切、又不留多余留白。
 */
export function resolveLyricContentHeight(options: LyricContainerHeightOptions): number {
  if (options.lines.length === 0) return 0;
  if (options.measuredContentHeight && options.measuredContentHeight > 0) {
    return options.measuredContentHeight;
  }
  return estimateLyricOverviewHeight(options.lines, options.contentWidth);
}

/** 计算歌词组件的最终外壳高度 */
export function calculateLyricContainerHeight(options: LyricContainerHeightOptions): number {
  const contentHeight = resolveLyricContentHeight(options);
  const scale = options.overview ? LYRIC_OVERVIEW_SCALE : 1;
  return Math.ceil(contentHeight * scale + options.containerPadding);
}
