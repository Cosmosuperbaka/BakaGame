import type { Transition, Variants } from "framer-motion";
import { spring, ease, duration, type SpringToken } from "@/lib/motion/Transitions";

// ==================== 抛掷物理 ====================
// 标签推移与聊天发送各自成套、互不引用对方的参数，只共用同一套物理：位移与形变都由二阶弹簧阻尼驱动，不做淡入淡出。
// 沿位移方向（主轴）与垂直方向（副轴）用两档不同的弹簧，主轴快、副轴软而慢半拍：
// 飞行途中沿运动方向拉长，落位时副轴冲过头、横向铺开再回弹，读作有质量的东西被抛到位。

/** 二维位移向量：元素自落点指向来源（按钮、上一个位置）的偏移，单位像素。 */
export interface AxesVector {
  dx: number;
  dy: number;
}

/**
 * 把「主轴、副轴」上的两个值落到 scaleX / scaleY：取位移较大的那一轴为主轴，没有位移时按纵向处理。
 * 主轴是运动方向，副轴与它垂直。
 */
export function byAxes<T>({ dx, dy }: AxesVector, along: T, across: T): { scaleX: T; scaleY: T } {
  return Math.abs(dx) > Math.abs(dy)
    ? { scaleX: along, scaleY: across }
    : { scaleX: across, scaleY: along };
}

/**
 * 带初速度的弹簧。`launch` 以「每秒走完的全程数」为单位，换算成 framer-motion 的值域初速度：
 * 正值顺着行程抛出（动量），负值先朝反方向蓄力。
 */
export function springWithVelocity(
  token: SpringToken,
  launch: number,
  from: number,
  to: number
): Transition {
  return { ...token, velocity: launch * (to - from) };
}

/** 标签内容推移：一整幅面板加一道缝的行程（百分比）、途中纵向的压扁程度、点击带来的初速度。 */
const tabPush = { travel: 104, squash: 0.96, launch: 1.5 } as const;

/**
 * 标签内容切换。`custom` 是切换方向（1 往后、-1 往前、0 未知）：
 * 新旧两幅面板像一条胶片被整幅推过去，旧的从一侧推出、新的从另一侧推入，与底块同向；
 * 位移走 `spring.push`，带着点击的初速度冲过落点一点再拉回，纵向在途中被压扁、按 `spring.wobble` 弹回。
 * 两幅面板之间留一道缝，根节点横向裁切，不靠淡化遮住交叠。方向未知（外部改值）时直接换掉。
 */
export const tabPushSwap: Variants = {
  initial: (direction: number) =>
    direction ? { x: `${direction * tabPush.travel}%`, scaleY: tabPush.squash } : { x: "0%" },
  animate: (direction: number) => ({
    x: "0%",
    scaleY: 1,
    transition: {
      x: springWithVelocity(spring.push, tabPush.launch, direction * tabPush.travel, 0),
      scaleY: spring.wobble,
    },
  }),
  exit: (direction: number) =>
    direction
      ? {
          x: `${-direction * tabPush.travel}%`,
          scaleY: tabPush.squash,
          pointerEvents: "none",
          transition: {
            x: springWithVelocity(spring.push, tabPush.launch, 0, -direction * tabPush.travel),
            scaleY: spring.wobble,
          },
        }
      : { visibility: "hidden", transition: { duration: duration.none } },
};

/**
 * 聊天发送：输入框里的文字凝成一枚胶囊，被掷到输入区右上方等回显（`lift` 为输入框高度的倍数）。
 * 纵向与横向用不同的弹簧，轨迹是弧；掷出的冲量 `impulse`（每秒尺度变化量）让主轴鼓起、副轴收窄，再弹回原形。
 * 回显到达时，自己那条气泡从胶囊当前的位置与尺寸接手，继承胶囊的速度飞进落点；胶囊同一帧撤掉。
 * `waitMs` 只管视觉：悬停到点仍没有交接就把胶囊收回，内容算不算发出去由调用方按服务端回执判定，
 * 没发出去的那条才随收回动画回到输入框。
 */
export const chatThrow = {
  lift: 1.4,
  launch: 3,
  impulse: { along: 3, across: -2.2 },
  into: { along: 0.08, across: 0.04 },
  /** 胶囊悬停等交接的最长时间，纯视觉窗口，不是发送超时 */
  waitMs: 1200,
  /** 气泡接手时相对胶囊的尺寸比限制在这个范围里：长消息换行后不至于从一条细线炸开 */
  scale: { min: 0.4, max: 1.6 },
} as const;

/**
 * 定格阶梯抖动：把一次欠阻尼冲击响应按 `fps` 采样成离散的几格，每格保持、格间硬切，
 * 读作逐帧拍出来的震颤，而不是平滑的摆动。振幅逐格衰减，最后一格回到 0。
 */
export const stepJitter = {
  fps: 24,
  stiffness: 1800,
  damping: 15,
  mass: 0.5,
  floor: 0.05,
} as const;

/** 抖动的归一化格序列：正负交替衰减，满幅为 ±1，低于 `floor` 的尾巴截掉，末格为 0。 */
export function jitterFrames(): number[] {
  const { fps, stiffness, damping, mass, floor } = stepJitter;
  const step = 0.001;
  const frameMs = 1000 / fps;
  let position = 0;
  let velocity = 1;
  const samples: number[] = [];
  for (let ms = 0, frame = 1; frame < fps; ms += 1) {
    velocity += ((-stiffness * position - damping * velocity) / mass) * step;
    position += velocity * step;
    if (ms >= frame * frameMs) {
      samples.push(position);
      frame += 1;
    }
  }
  const peak = Math.max(...samples.map(Math.abs));
  const frames = samples.map((value) => Number((value / peak).toFixed(3)));
  const last = frames.findLastIndex((value) => Math.abs(value) >= floor);
  return [...frames.slice(0, last + 1), 0];
}

/** 每段一进入就跳到目标值并保持到段尾：阶梯抖动的格间硬切。 */
const holdStep = (progress: number) => (progress > 0 ? 1 : 0);

/** 各处阶梯抖动的振幅：位移单位像素，旋转单位度。 */
export const jitterShape = {
  /** 发送按钮的图标被射出的胶囊反冲 */
  sendRecoil: { y: 2, rotate: -12 },
} as const;

/** 把振幅展开成可以直接交给 `animate` 的阶梯关键帧与过渡。 */
export function stepJitterAnimation(shape: Partial<Record<"x" | "y" | "rotate", number>>) {
  const frames = jitterFrames();
  const keyframes = Object.fromEntries(
    Object.entries(shape).map(([key, amplitude]) => [
      key,
      [0, ...frames.map((value) => value * (amplitude ?? 0))],
    ])
  ) as Partial<Record<"x" | "y" | "rotate", number[]>>;
  const segments = frames.length;
  const transition: Transition = {
    duration: segments / stepJitter.fps,
    times: Array.from({ length: segments + 1 }, (_, index) => index / segments),
    ease: Array.from({ length: segments }, () => holdStep),
  };
  return { keyframes, transition };
}

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
 * 别人发来的消息：自气泡尾巴所在的下角弹出，不做淡入。
 * 纵向沿上升方向按 `spring.thrust` 先到，横向按 `spring.wobble` 慢半拍、落位时铺开再回弹；
 * 退场（消息被裁掉）按 `spring.recall` 缩回下角。
 */
export const chatMessageLaunch: Variants = {
  initial: { y: 18, scaleX: 0.4, scaleY: 0.4 },
  animate: {
    y: 0,
    scaleX: 1,
    scaleY: 1,
    transition: { y: spring.thrust, scaleY: spring.thrust, scaleX: spring.wobble },
  },
  exit: { scaleX: 0, scaleY: 0, transition: spring.recall },
};
