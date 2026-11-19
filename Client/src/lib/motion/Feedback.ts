import { spring } from "@/lib/motion/Transitions";

// ==================== 交互反馈 ====================
// 桌面端没有触觉反馈，用尺度与亮度的瞬时变化替代按压手感。
// 反馈必须落在按下那一刻，松手后由弹性过渡收回，形成“推—回弹”的因果。

/** 常规可点击元素 */
export const pressable = {
  whileHover: { scale: 1.012 },
  whileTap: { scale: 0.974 },
  transition: spring.snap,
} as const;

/** 主要操作：按压幅度更大，确认感更强 */
export const pressableStrong = {
  whileHover: { scale: 1.02 },
  whileTap: { scale: 0.955 },
  transition: spring.snap,
} as const;

/** 行内小控件：仅按压，不做悬停缩放，避免密集列表抖动 */
export const tappable = {
  whileTap: { scale: 0.92 },
  transition: spring.snap,
} as const;

/** 图标按钮：按压时连同图标一起下沉，配合 hover 底色变化 */
export const iconTappable = {
  whileHover: { scale: 1.06 },
  whileTap: { scale: 0.9 },
  transition: spring.snap,
} as const;

/** 整行折叠标题：按压幅度极小，避免大面积文本区随按压晃动 */
export const headerTappable = {
  whileTap: { scale: 0.995 },
  transition: spring.snap,
} as const;

/** 浮层列表里的整行候选（搜索结果）：行宽接近浮层宽度，幅度比 tappable 小得多，只读出「按下了」 */
export const optionTappable = {
  whileTap: { scale: 0.985 },
  transition: spring.snap,
} as const;

/**
 * 选项卡片类按压：按下时同时收缩与轻微下压，
 * 让“选中”读作把卡片按进面板，而不是整块缩放。
 */
export const selectable = {
  whileHover: { scale: 1.01 },
  whileTap: { scale: 0.965, y: 1 },
  transition: spring.snap,
} as const;
