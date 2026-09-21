/**
 * 词语停靠态的尺寸策略。
 * 单独成文件是因为 AssignedWord 只导出组件才能保住 Fast Refresh，
 * 常量与纯函数必须放在组件文件之外。
 */

/** 停靠状态的基础缩放比。词语始终以放大尺寸渲染，停靠时缩小。 */
export const DOCK_SCALE = 0.34;

/**
 * 停靠态词语与两侧留白之和不得超出的视口比例。
 * 顶栏中段还要容纳身份标签，留 0.92 给其它元素与内边距。
 */
export const DOCK_VIEWPORT_RATIO = 0.92;

/**
 * 按可用宽度反推停靠缩放比。词语以 `whitespace-nowrap` 单行渲染，
 * 若仍用固定 DOCK_SCALE，长词语会横向溢出到顶栏之外被视口裁掉，
 * 看起来就是「被截断」。这里在超宽时等比缩小到刚好放得下，
 * 短词语维持原比例，避免一律缩得过小。
 */
export function dockScaleFor(naturalWidth: number, availableWidth: number): number {
  if (naturalWidth <= 0 || availableWidth <= 0) return DOCK_SCALE;
  const fitScale = availableWidth / naturalWidth;
  return Math.min(DOCK_SCALE, fitScale);
}

/** 顶栏中段可占用的宽度：视口扣掉两侧边距与身份标签。 */
export function availableDockWidth(): number {
  if (typeof window === "undefined") return 0;
  return window.innerWidth * DOCK_VIEWPORT_RATIO;
}
