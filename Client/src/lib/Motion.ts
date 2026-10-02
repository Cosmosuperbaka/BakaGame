import { useLayoutEffect, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type { TargetAndTransition, Transition, Variants } from "framer-motion";

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
  /** 自输入框飞出的消息：起步有力、收尾轻微过冲，介于 swift 与 impulse 之间 */
  launch: { type: "spring", stiffness: 420, damping: 26, mass: 0.75 },
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

// ==================== CSS 令牌 ====================
// 无法接入 framer-motion 的场景（Radix data-state 浮层、开关滑块、Tailwind 过渡类）
// 读 `:root` 上的 `--motion-*` 变量。变量由下面的函数从上方令牌生成，不在 CSS 里手抄。

type SpringToken = (typeof spring)[keyof typeof spring];

/** 弹性判定静止的阈值：位移与速度都以 0→1 的进度为单位。 */
const SPRING_REST_DELTA = 0.001;
const SPRING_REST_SPEED = 0.02;
/** 采样点数：足够还原 impulse 的回弹，又不至于让样式表过长。 */
const SPRING_SAMPLES = 48;

/**
 * 把弹性过渡解成 CSS 可用的曲线与时长。
 * 以 1ms 步长积分 0→1 的阻尼振动，到位移与速度都低于阈值时视为静止，
 * 再等时采样成 `linear()`：过冲部分保留为大于 1 的取值，观感与 framer-motion 的同名弹性一致。
 */
export function springToCss({ stiffness, damping, mass }: SpringToken): { easing: string; duration: number } {
  const step = 0.001;
  const trace = [0];
  let position = 0;
  let velocity = 0;
  // 上限 5 秒，防止参数失误时死循环；现有档位都在 1 秒内静止。
  while (trace.length < 5_000) {
    velocity += ((stiffness * (1 - position) - damping * velocity) / mass) * step;
    position += velocity * step;
    trace.push(position);
    if (Math.abs(1 - position) < SPRING_REST_DELTA && Math.abs(velocity) < SPRING_REST_SPEED) break;
  }
  const last = trace.length - 1;
  const points = Array.from({ length: SPRING_SAMPLES + 1 }, (_, index) =>
    index === SPRING_SAMPLES ? 1 : Number(trace[Math.round((index / SPRING_SAMPLES) * last)].toFixed(3)),
  );
  return { easing: `linear(${points.join(", ")})`, duration: last / 1000 };
}

const cubicBezier = (curve: readonly number[]) => `cubic-bezier(${curve.join(", ")})`;
const seconds = (value: number) => `${Number(value.toFixed(3))}s`;
const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** 就近弹出层的起止尺度，`popover` 变体与 CSS 关键帧共用。 */
export const popoverScale = { enter: 0.94, exit: 0.96 } as const;

/**
 * 跨页过渡的前后两层尺度：后方一层略小，前方一层略大。
 * 前进时新页自后方推入、旧页向前退出，返回时两者对调；
 * 整页面积远大于游戏区，幅度比 `phaseSwap` 收一半，免得边缘位移过大。
 */
export const pageScale = { behind: 0.985, ahead: 1.015 } as const;

/**
 * 进房编排：顶栏、玩家栏、游戏区、聊天栏按 `parts` 的顺序依次晚一步就位，读作「房间被搭起来」。
 * 玩家栏与聊天栏自外侧边缘等比展开（`scale` 起点），顶栏与游戏区只显影（游戏区内容另有 `phaseSwap` 自后推入）。
 * 顺序在这里定义一次：CSS 的各栏延迟与 `roomEntranceMs` 都由它生成。
 */
export const roomEntrance = { step: 0.05, scale: 0.97, parts: ["header", "player", "game", "chat"] } as const;

/** 全部 CSS 动效变量。键名即 `--motion-` 之后的部分。 */
export function motionCssVariables(): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [name, curve] of Object.entries(ease)) variables[`ease-${kebab(name)}`] = cubicBezier(curve);
  for (const [name, value] of Object.entries(duration)) {
    if (name !== "none" && name !== "hold") variables[`duration-${name}`] = seconds(value);
  }
  for (const [name, token] of Object.entries(spring)) {
    const { easing, duration: settle } = springToCss(token);
    variables[`spring-${name}`] = easing;
    variables[`spring-${name}-duration`] = seconds(settle);
  }
  variables["popover-enter-scale"] = String(popoverScale.enter);
  variables["popover-exit-scale"] = String(popoverScale.exit);
  variables["page-behind-scale"] = String(pageScale.behind);
  variables["page-ahead-scale"] = String(pageScale.ahead);
  variables["room-entrance-scale"] = String(roomEntrance.scale);
  roomEntrance.parts.forEach((part, index) => {
    variables[`room-entrance-delay-${part}`] = seconds(index * roomEntrance.step);
  });
  return variables;
}

/**
 * 生成写入 `:root` 的样式表。减弱动效时弹性时长归零：
 * 弹性只用于位移与缩放，与 `MotionConfig reducedMotion="user"` 关掉变换动画同口径；颜色过渡保留。
 */
export function motionTokenCss(): string {
  const variables = motionCssVariables();
  const declarations = Object.entries(variables).map(([name, value]) => `--motion-${name}: ${value};`);
  const reduced = Object.keys(variables)
    .filter((name) => name.startsWith("spring-") && name.endsWith("-duration"))
    .map((name) => `--motion-${name}: 0s;`);
  return `:root { ${declarations.join(" ")} }\n@media (prefers-reduced-motion: reduce) { :root { ${reduced.join(" ")} } }`;
}

/** 把动效变量装进文档。应用入口与 Storybook 预览在首次渲染前各调用一次，重复调用只更新同一个样式节点。 */
export function installMotionTokens(doc: Document = document): void {
  const id = "motion-tokens";
  let node = doc.getElementById(id);
  if (!node) {
    node = doc.createElement("style");
    node.id = id;
    doc.head.appendChild(node);
  }
  node.textContent = motionTokenCss();
}

/**
 * 倒计时刷新步长（毫秒）。进度条在两次刷新之间匀速补间，
 * 时长与刷新步长相同，读作连续流逝的时间；这是除加载旋转外唯一允许的匀速过渡。
 */
export const countdownTickMs = 100;

/** 倒计时进入最后阶段的脉动：表达真实的持续状态「快到时间了」，不做纯装饰。 */
export const urgentPulse: { animate: TargetAndTransition; transition: Transition } = {
  animate: { scale: [1, 1.2, 1] },
  transition: { duration: 0.8, ease: ease.inOut, repeat: Infinity },
};

/** 歌词播放与总览：同一批文字同时移动和缩小，原生布局负责两端位置。 */
export const lyricOverview = {
  scale: 0.92,
  timing: {
    duration: duration.slow * 1000,
    easing: `cubic-bezier(${ease.emphasized.join(",")})`,
  },
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
  exit: { opacity: 0, scale: 0.965, pointerEvents: "none", transition: { duration: duration.instant } },
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
  initial: { opacity: 0, scale: popoverScale.enter },
  animate: { opacity: 1, scale: 1, transition: spring.swift },
  exit: { opacity: 0, scale: popoverScale.exit, transition: { duration: duration.instant } },
};

/** 从属元素跟随主体的延迟：回执卡内的对勾、折叠区的显影都晚主体这一拍。 */
export const followDelay = 0.06;

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
      opacity: { duration: duration.quick, ease: ease.out, delay: followDelay },
    },
  },
  exit: {
    height: 0,
    opacity: 0,
    transition: {
      height: { duration: duration.quick, ease: ease.inOut, delay: followDelay * 0.66 },
      opacity: { duration: duration.instant, ease: ease.inOut },
    },
  },
};

// ==================== 具名小动作 ====================
// 只在一两处出现、但同样必须有名字的动作。组件里只引用，不再内联幅度。

/** 读数替换（音量百分比、白板猜词槽）：新值自下方轻轻顶上来，读作数字被换掉而不是闪一下。 */
export const readoutSwap: Variants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0, transition: spring.swift },
  exit: { opacity: 0, transition: { duration: duration.instant, ease: ease.inOut } },
};

/** 拖动中连续变化的读数：起点更贴近终值，快速连续刷新时不闪烁。 */
export const readoutTick = {
  initial: { opacity: 0.5, y: 2, scale: 0.92 },
  animate: { opacity: 1, y: 0, scale: 1 },
  transition: spring.snap,
} as const;

/**
 * 确认回执：投票、夜晚行动提交后出现的结果卡片。卡片以 impulse 回弹落位，
 * 卡内对勾用 `receiptMarkFollow` 晚 `followDelay` 再弹出，读作「先接住、再盖章」。
 */
export const receiptCard = {
  initial: { opacity: 0, scale: 0.94 },
  animate: { opacity: 1, scale: 1 },
  transition: spring.impulse,
} as const;

/** 单独落位的对勾（已提交发言）。 */
export const receiptMark = {
  initial: { opacity: 0, scale: 0.4 },
  animate: { opacity: 1, scale: 1 },
  transition: spring.impulse,
} as const;

/** 回执卡内跟随卡片弹出的对勾。 */
export const receiptMarkFollow = {
  ...receiptMark,
  transition: { ...spring.impulse, delay: followDelay },
} as const;

/** 自右侧滑入的提示（Toast）：从屏幕边缘被推进来，退出沿原路回去。堆叠重排由组件的 `layout` 配 `spring.settle` 负责。 */
export const toastItem: Variants = {
  initial: { opacity: 0, x: 24, scale: 0.96 },
  animate: { opacity: 1, x: 0, scale: 1, transition: spring.swift },
  exit: { opacity: 0, x: 24, scale: 0.97, transition: { duration: duration.quick, ease: ease.inOut } },
};

/** 自底部升起的横幅（新版本提醒）。 */
export const bannerRise: Variants = {
  initial: { opacity: 0, y: 20, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1, transition: spring.swift },
  exit: { opacity: 0, y: 16, scale: 0.96, transition: { duration: duration.quick, ease: ease.inOut } },
};

/** 自上方落下的状态条（倒计时）：与顶部阶段标题同侧进入。 */
export const dropIn: Variants = {
  initial: { opacity: 0, y: -8, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1, transition: spring.swift },
  exit: { opacity: 0, y: -6, scale: 0.98, transition: { duration: duration.instant } },
};

/** 日出图标自下升起，纵向位移本身就是「天亮」的语义（§2.2 允许的单元素位移）。 */
export const sunrise = {
  initial: { y: 18, scale: 0.85 },
  animate: { y: 0, scale: 1 },
  transition: spring.swift,
} as const;

/** 聊天系统提示：从中线纵向展开。 */
export const systemNotice: Variants = {
  initial: { opacity: 0, scaleY: 0.6 },
  animate: { opacity: 1, scaleY: 1, transition: { duration: duration.base, ease: ease.out } },
  exit: { opacity: 0, transition: { duration: duration.instant } },
};

/** 发言内容揭示：沿文字基线浮现并从轻微失焦变清晰，读作「翻开」而不是批量飘入。 */
export const speechReveal: Variants = {
  initial: { opacity: 0, y: 6, filter: "blur(2px)" },
  animate: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { ...spring.swift, filter: { duration: duration.base, ease: ease.out } },
  },
  exit: { opacity: 0, transition: { duration: duration.instant } },
};

/**
 * 首日揭词的计时（毫秒）：入场晚一拍以免与阶段切换叠在一起；
 * 居中停留 `duration.hold` 供玩家读完，再加上放大入场本身的时长后停靠回顶栏。
 */
export const wordRevealTiming = {
  showAfterMs: followDelay * 1000,
  dockAfterMs: duration.hold * 1000 + 400,
} as const;

/** 弹性过渡大致静止所需的毫秒数，供必须等动画结束才能改结构的计时器使用。 */
export function springSettleMs(token: SpringToken): number {
  return Math.round(springToCss(token).duration * 1000);
}

/**
 * 进房编排的窗口（毫秒）：最后一栏晚 `parts.length - 1` 步起播，按 `spring.swift` 落定为止。
 * 窗口内挂载的栏参与编排，窗口外才出现的栏（断线重连后补上、CCB 加入成功后才有的栏）直接出现，不重播。
 */
export const roomEntranceMs = Math.round((roomEntrance.parts.length - 1) * roomEntrance.step * 1000) + springSettleMs(spring.swift);

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
    transition: spring.launch,
  },
  exit: { opacity: 0, scale: 0.95, transition: { duration: duration.instant } },
};
