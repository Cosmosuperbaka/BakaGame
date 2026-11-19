import type { Transition } from "framer-motion";

// ==================== 过渡基线 ====================
// 所有动效必须从 `lib/motion/` 取值，不在业务组件内写死时长或曲线。

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
  /** 被抛出的主轴位移：带着动量冲过落点约 4.7% 再拉回 */
  thrust: { type: "spring", stiffness: 380, damping: 27, mass: 1 },
  /** 与主轴垂直的形变：比 thrust 软、慢半拍，落位时横向铺开约 5.4% 再回弹 */
  wobble: { type: "spring", stiffness: 240, damping: 21, mass: 1 },
  /** 收回来源：起步快、几乎不回弹，配反向初速度做蓄力 */
  recall: { type: "spring", stiffness: 520, damping: 34, mass: 0.9 },
  /** 整幅推移（标签内容）：过冲约 1.7%，读作一条被推了一下的胶片 */
  push: { type: "spring", stiffness: 340, damping: 29, mass: 1 },
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
  /** 持续状态的一次呼吸（`animate-breathe`：断线提示、骨架屏、在线点） */
  breath: 2,
  /** 需要玩家读完内容的停留时长（词语揭示） */
  hold: 2.2,
} as const;

export type SpringToken = (typeof spring)[keyof typeof spring];

/** 弹性判定静止的阈值：位移与速度都以 0→1 的进度为单位。 */
const SPRING_REST_DELTA = 0.001;
const SPRING_REST_SPEED = 0.02;
/** 采样点数：足够还原 impulse 的回弹，又不至于让样式表过长。 */
const SPRING_SAMPLES = 48;

/**
 * 以 1ms 步长积分 0→1 的阻尼振动 `m·x'' = k·(1 − x) − c·x'`，到位移与速度都低于阈值时视为静止。
 * `velocity` 是初速度，以「每秒走完的全程」为单位：负值先朝反方向蓄力。返回每毫秒的进度。
 */
export function springTrace({ stiffness, damping, mass }: SpringToken, velocity = 0): number[] {
  const step = 0.001;
  const trace = [0];
  let position = 0;
  let speed = velocity;
  // 上限 5 秒，防止参数失误时死循环；现有档位都在 1 秒内静止。
  while (trace.length < 5_000) {
    speed += ((stiffness * (1 - position) - damping * speed) / mass) * step;
    position += speed * step;
    trace.push(position);
    if (Math.abs(1 - position) < SPRING_REST_DELTA && Math.abs(speed) < SPRING_REST_SPEED) break;
  }
  return trace;
}

/** 弹性第一次走到 `progress`（0–1）所需的毫秒数：动作「到了」的时刻，早于完全静止。 */
export function springReachMs(token: SpringToken, progress: number, velocity = 0): number {
  const trace = springTrace(token, velocity);
  const index = trace.findIndex((value) => value >= progress);
  return index < 0 ? trace.length - 1 : index;
}

/**
 * 把弹性过渡解成 CSS 可用的曲线与时长：`springTrace` 等时采样成 `linear()`，
 * 过冲部分保留为大于 1 的取值，观感与 framer-motion 的同名弹性一致。
 */
export function springToCss(token: SpringToken): { easing: string; duration: number } {
  const trace = springTrace(token);
  const last = trace.length - 1;
  const points = Array.from({ length: SPRING_SAMPLES + 1 }, (_, index) =>
    index === SPRING_SAMPLES
      ? 1
      : Number(trace[Math.round((index / SPRING_SAMPLES) * last)].toFixed(3))
  );
  return { easing: `linear(${points.join(", ")})`, duration: last / 1000 };
}
