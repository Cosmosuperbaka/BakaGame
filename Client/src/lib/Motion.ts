import { useLayoutEffect, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type { Transition, Variants } from "framer-motion";

// ==================== 过渡基线 ====================
// 所有动效必须从本文件取值，不在业务组件内写死时长或曲线。

/**
 * 弹性过渡。按“被移动物体的质量感”分级：
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
  /** 确认类反馈：阻尼更低，落位时有一次可感知的回弹，替代触觉提示 */
  impulse: { type: "spring", stiffness: 420, damping: 18, mass: 0.8 },
} satisfies Record<string, Transition>;

/** 缓动曲线。仅在需要可预期时长（擦除、折叠、退出）时替代弹性过渡。 */
export const ease = {
  /** 起步快、收尾长，用于进场与展开 */
  out: [0.22, 1, 0.36, 1] as [number, number, number, number],
  /** 两端对称，用于折叠与退出 */
  inOut: [0.65, 0, 0.35, 1] as [number, number, number, number],
  /** 前段克制、中段加速，用于跨区域强调位移 */
  emphasized: [0.2, 0, 0, 1] as [number, number, number, number],
};

/** 时长档位。用于退出、擦除等需要确定收束时间的动效。 */
export const duration = {
  /** 无过渡：状态仅作落位同步，不播放动画 */
  none: 0,
  instant: 0.12,
  quick: 0.18,
  base: 0.26,
  slow: 0.42,
  /** 需要玩家读完内容的停留时长（词语揭示） */
  hold: 2.2,
} as const;

/**
 * 持续旋转的加载指示。匀速且无限循环，
 * 表达“正在进行”而非一次状态迁移，因此不使用弹性过渡。
 */
export const spinner = {
  animate: { rotate: 360 },
  transition: { duration: 0.85, ease: "linear", repeat: Infinity },
} as const;

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

/**
 * 选项卡片类按压：按下时同时收缩与轻微下压，
 * 让“选中”读作把卡片按进面板，而不是整块缩放。
 */
export const selectable = {
  whileHover: { scale: 1.01 },
  whileTap: { scale: 0.965, y: 1 },
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
 * 列表项。以自身左缘为原点做等比缩放，读作“推到前面来”。
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
 * 收尾锁定整数缩放并交回 CSS 渲染，避免子像素残留造成文本抖动。
 */
export const phaseSwap: Variants = {
  initial: { opacity: 0, scale: 0.97 },
  animate: {
    opacity: 1,
    scale: 1,
    transition: { ...spring.swift, restDelta: 0.0005, restSpeed: 0.0005 },
  },
  exit: { opacity: 0, scale: 1.03, transition: { duration: duration.quick, ease: ease.inOut } },
};

/** 覆盖层背板 */
export const backdrop: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: duration.quick } },
  exit: { opacity: 0, transition: { duration: duration.quick } },
};

/** 自左缘擦入的覆盖面板。宽度方向的裁切让面板读作“拉开”。 */
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

/**
 * 折叠区域。高度与不透明度分离：展开时先撑开高度再显影，
 * 收起时先褪去内容再收拢高度，避免内容随高度一起被压扁。
 */
export const collapsible: Variants = {
  initial: { height: 0, opacity: 0 },
  animate: {
    height: "auto",
    opacity: 1,
    transition: {
      height: { duration: duration.base, ease: ease.out },
      opacity: { duration: duration.quick, ease: ease.out, delay: 0.06 },
    },
  },
  exit: {
    height: 0,
    opacity: 0,
    transition: {
      height: { duration: duration.quick, ease: ease.inOut, delay: 0.04 },
      opacity: { duration: duration.instant, ease: ease.inOut },
    },
  },
};

// ==================== 浮层来源锚定 ====================

/** 触发元素在视口中的中心点，用于把浮层的缩放原点对准来源。 */
export interface OriginPoint {
  x: number;
  y: number;
}

/**
 * 记录最近一次点击的触发元素位置。
 * 浮层据此把 transform-origin 落在按钮上，读作从按钮里被拉出来，
 * 而不是从屏幕正中凭空出现。
 */
export function useOriginTracker() {
  const [origin, setOrigin] = useState<OriginPoint | null>(null);

  const capture = (event: { currentTarget: EventTarget | null }) => {
    const node = event.currentTarget;
    if (!(node instanceof Element)) return;
    const rect = node.getBoundingClientRect();
    setOrigin({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  };

  return { origin, capture };
}

/**
 * 把来源点换算成浮层自身的 transform-origin。
 *
 * 测量要点：`getBoundingClientRect` 返回的是**已缩放**的盒子，
 * 直接用它的 left/width 会让原点算偏。因此这里用两个与变换无关的量还原真实盒子：
 * 尺寸取 `offsetWidth/offsetHeight`（布局值，不受 transform 影响），
 * 中心取 rect 中心 —— 挂载瞬间 transformOrigin 仍是默认的 50% 50%，
 * 此时缩放不会移动中心点，所以中心是准确的。
 * 浮层关闭即卸载，每次打开都从这一初始状态重新测量。
 */
export function useOriginStyle(
  ref: RefObject<HTMLElement | null>,
  origin: OriginPoint | null,
): CSSProperties {
  const [transformOrigin, setTransformOrigin] = useState("50% 50%");

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !origin) {
      setTransformOrigin("50% 50%");
      return;
    }
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    if (width === 0 || height === 0) return;

    const rect = node.getBoundingClientRect();
    const left = rect.left + rect.width / 2 - width / 2;
    const top = rect.top + rect.height / 2 - height / 2;

    // 限制在浮层附近，避免来源远离时原点被推到极端位置。
    const clamp = (value: number) => Math.max(-60, Math.min(160, value));
    const x = clamp(((origin.x - left) / width) * 100);
    const y = clamp(((origin.y - top) / height) * 100);
    setTransformOrigin(`${x.toFixed(2)}% ${y.toFixed(2)}%`);
  }, [ref, origin]);

  return { transformOrigin };
}

/**
 * 从来源点被吸出的浮层。缩放与轻微位移同时发生，
 * 配合 transform-origin 形成窗口自按钮展开的观感；
 * 退出时反向收回同一位置，保证开合互为逆过程。
 */
export const emergeFromOrigin: Variants = {
  initial: { opacity: 0, scale: 0.9 },
  animate: {
    opacity: 1,
    scale: 1,
    transition: {
      ...spring.swift,
      opacity: { duration: duration.quick, ease: ease.out },
    },
  },
  exit: {
    opacity: 0,
    scale: 0.93,
    transition: {
      duration: duration.quick,
      ease: ease.inOut,
      opacity: { duration: duration.instant, ease: ease.inOut },
    },
  },
};

/**
 * 未提交发言的占位省略号。三点依次浮起再落回，
 * 表达“正在等待”而不是静止的空值。
 */
export const ellipsisDot: Variants = {
  animate: (index: number) => ({
    opacity: [0.25, 1, 0.25],
    y: [0, -2.5, 0],
    transition: {
      duration: 1.15,
      ease: ease.inOut,
      repeat: Infinity,
      delay: index * 0.16,
    },
  }),
};

/**
 * 聊天消息发送：从输入框以弹性形变飞入展开（类似 macOS 窗口打开的弹性加速与神灯展开）。
 */
export const chatMessageLaunch: Variants = {
  initial: { opacity: 0, scale: 0.35, y: 32, scaleX: 0.75, scaleY: 1.15 },
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    transition: {
      type: "spring",
      stiffness: 420,
      damping: 26,
      mass: 0.75,
    },
  },
  exit: { opacity: 0, scale: 0.95, transition: { duration: duration.instant } },
};
