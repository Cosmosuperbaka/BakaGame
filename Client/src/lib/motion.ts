import type { Transition, Variants } from "framer-motion";

// ==================== 过渡基线 ====================
// 所有动效必须从本文件取值，不在业务组件内写死时长或曲线。

/**
 * 弹性过渡。按"被移动物体的质量感"分级：
 * 越靠前的越轻、越快，用于小尺寸即时反馈；越靠后的越重，用于大尺度位移。
 */
export const spring = {
  /** 按压、开关、标记切换等即时反馈 */
  snap: { type: "spring", stiffness: 520, damping: 34, mass: 0.7 },
  /** 浮层、抽屉、弹窗、列表项进出 */
  swift: { type: "spring", stiffness: 360, damping: 30, mass: 0.85 },
  /** 布局重排与面板宽高变化 */
  settle: { type: "spring", stiffness: 220, damping: 26, mass: 1 },
  /** 跨区域共享元素的长距离移动 */
  drift: { type: "spring", stiffness: 150, damping: 24, mass: 1.15 },
} satisfies Record<string, Transition>;

/** 缓动曲线。仅在需要可预期时长（如擦除、进度）时替代弹性过渡。 */
export const ease = {
  out: [0.22, 1, 0.36, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const;

/** 时长档位。用于退出、擦除等需要确定收束时间的动效。 */
export const duration = {
  instant: 0.12,
  quick: 0.18,
  base: 0.26,
  slow: 0.42,
} as const;

// ==================== 交互反馈 ====================
// 桌面端没有触觉反馈，用轻微的尺度变化替代按压手感。

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

// ==================== 编舞 ====================

/**
 * 列表容器。子项按序进入，形成一次扫过的节奏而非整块出现。
 * 步长随数量收敛，避免长列表尾部等待过久。
 */
export function listContainer(count: number): Variants {
  const step = count > 12 ? 0.012 : count > 6 ? 0.022 : 0.036;
  return {
    animate: { transition: { staggerChildren: step } },
    exit: { transition: { staggerChildren: step / 2, staggerDirection: -1 } },
  };
}

/**
 * 列表项。以自身左缘为原点做等比缩放，读作"推到前面来"。
 * 不使用纵向位移，避免多行同时平移产生的批量飘入观感。
 */
export const listItem: Variants = {
  initial: { opacity: 0, scale: 0.94 },
  animate: { opacity: 1, scale: 1, transition: spring.swift },
  exit: { opacity: 0, scale: 0.965, transition: { duration: duration.instant } },
};

/**
 * 阶段切换。新内容自后方推入、旧内容继续向前退出，
 * 两者尺度方向相反，形成前后层次而不是对称淡入淡出。
 */
export const phaseSwap: Variants = {
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1, transition: spring.swift },
  exit: { opacity: 0, scale: 1.03, transition: { duration: duration.quick, ease: ease.inOut } },
};

/** 覆盖层背板 */
export const backdrop: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: duration.quick } },
  exit: { opacity: 0, transition: { duration: duration.quick } },
};

/** 自左缘擦入的覆盖面板。宽度方向的裁切让面板读作"拉开"。 */
export const wipeFromLeft: Variants = {
  initial: { clipPath: "inset(0 100% 0 0)" },
  animate: {
    clipPath: "inset(0 0% 0 0)",
    transition: { duration: duration.base, ease: ease.out },
  },
  exit: {
    clipPath: "inset(0 100% 0 0)",
    transition: { duration: duration.quick, ease: ease.inOut },
  },
};

/** 弹出层。自触发点方向展开，保持点击位置与浮层的视觉因果。 */
export const popover: Variants = {
  initial: { opacity: 0, scale: 0.94 },
  animate: { opacity: 1, scale: 1, transition: spring.swift },
  exit: { opacity: 0, scale: 0.96, transition: { duration: duration.instant } },
};

/** 共享元素跨区域位移（词语从游戏区移入顶栏） */
export const sharedTransfer: Transition = spring.drift;
