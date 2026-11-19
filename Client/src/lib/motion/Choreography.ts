import type { TargetAndTransition, Transition, Variants } from "framer-motion";
import { spring, ease, duration } from "@/lib/motion/Transitions";

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

/** 列表项进场的起点：`listItem` 与 `scoreRow` 共用，结算表的行与普通列表读作同一种「推到前面来」。 */
const listItemEnter = { opacity: 0, scale: 0.94 };

/**
 * 列表项的退场。单独具名，供需要继承父级 `listContainer` 错峰的列表项直接以对象传给 `exit`：
 * 写成标签 `exit="exit"` 会让该项自成一级变体节点，不再从父级继承 initial/animate 与错峰（大厅房间卡片）。
 */
export const listItemExit: TargetAndTransition = {
  opacity: 0,
  scale: 0.965,
  pointerEvents: "none",
  transition: { duration: duration.instant },
};

/**
 * 列表项。以自身左缘为原点做等比缩放，读作“推到前面来”。
 * 不使用纵向位移，避免多行同时平移产生的批量飘入观感。
 */
export const listItem: Variants = {
  initial: listItemEnter,
  animate: { opacity: 1, scale: 1, transition: spring.swift },
  exit: listItemExit,
};

/**
 * 结算表逐行揭示。结算是一局的落点，行距比普通列表宽，名次才读得出先后；
 * 总跨度封顶，人多时步长自动收窄，末行不至于久等。`land` 是一行起播到大致落定的时长，行内的数字从这时开始滚。
 */
export const scoreReveal = { step: 0.07, span: 0.42, land: duration.base } as const;

/** 相邻两行的延迟差：不超过 `step`，且整表不超过 `span`。 */
const scoreRevealStep = (count: number) =>
  count > 1 ? Math.min(scoreReveal.step, scoreReveal.span / (count - 1)) : 0;

/**
 * 结算表第 `index` 行的入场延迟（秒）。按名次排列的表（第一名在最上）自末行往上揭示，第一名最后落定；
 * 按座次排列的表（谁是卧底的身份开牌）自上而下。行内的数字滚动从这里取时刻。
 */
export function scoreRevealDelay(index: number, count: number, ranked: boolean): number {
  return (ranked ? count - 1 - index : index) * scoreRevealStep(count);
}

/** 结算表第 `index` 行的数字滚动起点（秒）：这一行落定之后。 */
export function scoreRollDelay(index: number, count: number, ranked: boolean): number {
  return scoreRevealDelay(index, count, ranked) + scoreReveal.land;
}

/**
 * 数字逐位滚动（`AnimatedNumber`）：每一位是一条竖排的数字带，沿增减方向滚到新值，增加向上、减少向下，
 * 跨过 9/0 时接着滚而不倒转；个位先动、每高一位晚 `stagger`，读作里程表进位。减弱动效下直接落到新值。
 */
export const digitRoll = {
  transition: spring.settle,
  stagger: 0.04,
  /**
   * 连续跟手的读数（音量百分比）：每一位由一条弹簧位置驱动，目标变了就带着当前速度续上，
   * 快速拖动时不会像逐次滚动那样被下一次变化打断重来。取 snap：跟得上手、几乎不过冲。
   */
  follow: spring.snap,
  /** 符号随滚动出现（0 滚到 +4、0 滚到 -1） */
  sign: { duration: duration.quick, ease: ease.out },
} as const;

/**
 * 加分浮标（「+N」）：自分数旁弹起、停一拍后淡出，读作这次加分落进了总分；只在分数增加时出现。
 * 纵向上升本身就是「增加」的语义（§2.2 允许的单元素位移），减弱动效下只淡入淡出。
 */
export const gainFloat: {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  transition: Transition;
} = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: [0, 1, 1, 0], y: [4, -3, -5, -6] },
  transition: { duration: 1.1, times: [0, 0.18, 0.6, 1], ease: ease.out },
};

/** 结算表的行：与 `listItem` 同一个入场，延迟经 `custom` 逐行传入（取 `scoreRevealDelay`），不靠外层 stagger。 */
export const scoreRow: Variants = {
  initial: listItemEnter,
  animate: (delay: number) => ({ opacity: 1, scale: 1, transition: { ...spring.swift, delay } }),
};

/**
 * 贡献者行的浅底：这一局真正做出贡献的玩家（CEE 猜中者、猜歌首位答对者），
 * 行落定后底色浮起并留作常驻档，读作「这几分是他挣的」而不是随后消失的提示。
 * 取 `primary` 的浅底档（DesignGuide §3 的 `/10`）：与行悬停的 `accent/40` 不同层，
 * 且是流内区块，只铺底色不加描边，避免整表读成一堆按钮。
 */
export const contributorWash = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: duration.base, ease: ease.out },
} as const;

/** 贡献者浅底起浮的时刻（秒）：这一行落定之后，与行内数字同时开始。 */
export function contributorWashDelay(index: number, count: number, ranked: boolean): number {
  return scoreRevealDelay(index, count, ranked) + scoreReveal.land;
}

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

/**
 * 骨架屏退场：数据到达时骨架原地淡出，真实内容在同一格里以各自的入场推上来，两者交叉而不是先清空再出现。
 * 骨架与真实内容共用布局，只淡出、不缩放；骨架只在首屏出现，入场不播放，只定义退场。
 */
export const skeletonFade = {
  exit: { opacity: 0, transition: { duration: duration.quick, ease: ease.inOut } },
} as const;

/** 覆盖层背板 */
export const backdrop: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: duration.quick } },
  exit: { opacity: 0, transition: { duration: duration.quick } },
};

/** 侧边抽屉的滑入方向。 */
export type SheetSide = "left" | "right";

/**
 * 侧边抽屉的面板：自所在边缘整块滑入。`custom` 传 `SheetSide`（右侧抽屉从右缘滑入、左侧从左缘滑入），
 * 关闭沿原路滑出，与来源锚定同一条物理——从哪里拉出来就送回哪里去。
 * 面板只动位移，不做淡入；遮罩层单独走 `backdrop`（先出现、后消失）。
 */
export const sheetSlide: Variants = {
  initial: (side: SheetSide) => ({ x: side === "right" ? "100%" : "-100%" }),
  animate: { x: 0, transition: spring.swift },
  exit: (side: SheetSide) => ({
    x: side === "right" ? "100%" : "-100%",
    transition: { duration: duration.quick, ease: ease.inOut },
  }),
};

/** 就近弹出层的起止尺度，`popover` 变体与 CSS 关键帧共用。 */
export const popoverScale = { enter: 0.94, exit: 0.96 } as const;

/** 弹出层。自触发点方向展开，保持点击位置与浮层的视觉因果。 */
export const popover: Variants = {
  initial: { opacity: 0, scale: popoverScale.enter },
  animate: { opacity: 1, scale: 1, transition: spring.swift },
  exit: { opacity: 0, scale: popoverScale.exit, transition: { duration: duration.instant } },
};

/** 从属元素跟随主体的延迟：回执卡内的对勾、折叠区的显影都晚主体这一拍。 */
export const followDelay = 0.06;

/**
 * 折叠区域。高度与不透明度分离：展开时先撑开高度再显影，
 * 收起时先褪去内容再收拢高度，避免内容随高度一起被压扁。
 * 裁切只在补间期间生效：展开落定后 `overflow` 放回 `visible`，区内输入框的聚焦晕光、
 * 悬停描边不再被区域边缘切掉；收起一开始就重新裁切，内容不会溢出正在收拢的高度。
 */
export const collapsible: Variants = {
  initial: { height: 0, opacity: 0, overflow: "hidden" },
  animate: {
    height: "auto",
    opacity: 1,
    transitionEnd: { overflow: "visible" },
    transition: {
      height: { duration: duration.base, ease: ease.out },
      opacity: { duration: duration.quick, ease: ease.out, delay: followDelay },
    },
  },
  exit: {
    height: 0,
    opacity: 0,
    overflow: "hidden",
    transition: {
      height: { duration: duration.quick, ease: ease.inOut, delay: followDelay * 0.66 },
      opacity: { duration: duration.instant, ease: ease.inOut },
    },
  },
};

/**
 * 玩家栏重排：换组的行（共享 `layoutId`）、让位的其余行、分组标题与旁观入口用同一条弹簧，
 * 一起起步、一起落定，读作整列在挪，而不是一行跳过去、其余慢慢跟上。
 */
export const playerRelayout: Transition = { layout: spring.settle };

/** 选中指示器（标签页、分段控件的底块）在选项之间滑动 */
export const indicatorSlide: Transition = spring.swift;
