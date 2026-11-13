import type { TargetAndTransition, Transition, Variants } from "framer-motion";
import {
  spring,
  ease,
  duration,
  type SpringToken,
  springReachMs,
  springToCss,
} from "@/lib/motion/Transitions";
import { digitRoll, popoverScale, followDelay } from "@/lib/motion/Choreography";

// ==================== 具名小动作 ====================
// 只在一两处出现、但同样必须有名字的动作。组件里只引用，不再内联幅度。

/** 读数替换（音量百分比、白板猜词槽）：新值自下方轻轻顶上来，读作数字被换掉而不是闪一下。 */
export const readoutSwap: Variants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0, transition: spring.swift },
  exit: { opacity: 0, transition: { duration: duration.instant, ease: ease.inOut } },
};

/**
 * 服务状态页的条带显影：数据到达或切换视图时，一层与卡片同色的遮罩自左向右收起，
 * 条带读作沿时间轴从旧到新被铺开。逐行晚 `step`、整页封顶 `span`，末行不久等；只动 transform。
 */
export const uptimeReveal = {
  step: 0.025,
  span: 0.24,
  transition: { duration: duration.slow, ease: ease.out },
} as const;

/**
 * 状态条带的悬停说明与选中框：同一块浮层顺着指针在格子之间滑动，不逐格关了再开。
 * 取 snap：跟得上手，扫过一整条也不拖尾。
 */
export const uptimeGlide = spring.snap;

/** 状态主卡的图标换档：服务端推来新等级时新图标带一次回弹落位，读作「状态被改写了」。 */
export const statusGlyphSwap: Variants = {
  initial: { opacity: 0, scale: 0.7 },
  animate: { opacity: 1, scale: 1, transition: spring.impulse },
  exit: { opacity: 0, scale: popoverScale.exit, transition: { duration: duration.instant } },
};

/**
 * 纯显影：整页、等待提示、占位文字这类「换了一块内容」的出现，不带位移（DesignGuide §8 不拿位移做批量进场）。
 * 进场用 base 让人看得到「换了」，退场 instant 让位给接替它的内容。
 */
export const fadeSwap: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: duration.base, ease: ease.out } },
  exit: { opacity: 0, transition: { duration: duration.instant } },
};

/** 跟手的悬停标记显隐：指针扫过时要跟得上，进退都用 instant，不拖尾。 */
export const hoverMarkFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: duration.instant } },
  exit: { opacity: 0, transition: { duration: duration.instant } },
};

/** 直接撤走、不播退场：占位符被第一次读到的真实值替换时，两者不叠在一起闪一下。 */
export const vanish: TargetAndTransition = { opacity: 0, transition: { duration: duration.none } };

/** 按钮里两枚图标对换（播放与暂停）：在同一位置缩小淡出、放大淡入，按压级的 snap 跟得上连点。 */
export const iconToggle: Variants = {
  initial: { opacity: 0, scale: 0.6 },
  animate: { opacity: 1, scale: 1, transition: spring.snap },
  exit: { opacity: 0, scale: 0.6, transition: spring.snap },
};

/** 比分板的局分圆点换成结果时以 impulse 回弹落定，读作「这一局记上了」。 */
export const pipSettle = {
  initial: { scale: 0.6 },
  animate: { scale: 1 },
  transition: spring.impulse,
} as const;

/**
 * Agent 操作页面的节拍。`moveMs` 是焦点框从上一个控件落到新控件的时间，与 `.agent-focus-box`
 * 的过渡是同一枚弹簧：框到位才动手，人类才来得及看清它要做什么。
 * 其余是等页面响应的上限，不是动效，放在一起便于统一调整。
 */
export const agentPace = {
  moveMs: Math.round(springToCss(spring.settle).duration * 1000),
  reducedMoveMs: 80,
  dwellMs: 160,
  keyMinMs: 16,
  keyMaxMs: 70,
  typeBudgetMs: 2_400,
  quietMs: 180,
  quietLimitMs: 1_800,
  scrollPollMs: 80,
  scrollLimitMs: 1_200,
  scrollSettleMs: 420,
  scrollPageRatio: 0.8,
  barReservePx: 72,
  sliderStepLimit: 200,
} as const;

/**
 * Agent 接管时的几个 CSS 手势幅度（`index.css` 的 `agent-*` 关键帧经 `--motion-agent-*` 读取）：
 * 点击回声自框上扩开并消散；接管条自底边浮起并略放大到位；人类试图操作时接管条轻顶一下。
 */
export const agentGesture = {
  echoOpacity: 0.55,
  echoScale: 1.045,
  barRise: "0.5rem",
  barScale: 0.96,
  nudgeScale: 1.04,
} as const;

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
  /** 撤销或换回输入栏时原路收回起点，时长取确定收束的一档，不再回弹。 */
  exit: { opacity: 0, scale: 0.94, transition: { duration: duration.quick, ease: ease.inOut } },
  transition: spring.impulse,
} as const;

/**
 * 匹配成功「成局」的一拍：从排队切进系列赛时，比分板先以回执的回弹落定（对阵锁定了），
 * 对局区等比分板第一次落到原大（回弹之前）再自后方推入（同 `phaseSwap`），两拍分得开：先锁定对阵，再开局。刷新或重连直接落在系列赛里时整块是首屏，两者都不播。
 */
export const seriesStart = {
  board: {
    initial: receiptCard.initial,
    animate: receiptCard.animate,
    transition: receiptCard.transition,
  },
  stage: {
    initial: { opacity: 0, scale: 0.97 },
    animate: { opacity: 1, scale: 1 },
    transition: { ...spring.swift, delay: springReachMs(receiptCard.transition, 1) / 1000 },
  },
} as const;

/** 谁是卧底分到的词语揭示后停靠到顶栏时的缩放：停靠位按这个比例预留宽高。 */
export const wordDock = { scale: 0.34 } as const;

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

/**
 * 结算答案卡的抬起：卡片先轻轻下沉，再被抬起来亮给所有人看（略放大、投影拉远），最后放回原位。
 * 揭晓是一轮的高潮，比回执多一个「翻牌」的动作；落定后不留重阴影，流内内容保持轻阴影。
 * 卡片以原大显出（显影比沉段短，沉的时候已经看得见），再被压下去约 4% 并下坠几像素，读作「接住了」；
 * 沉段用两端缓的曲线，前半段几乎不动，留给显影。沉得太浅或与显影重叠，整段会读成「淡入后放大一下」。
 * 三段关键帧（沉、抬、放）弹簧给不了，用确定时长的分段缓动；投影由 `.reveal-lift` 的伪元素按同一组 `times` 淡入淡出，
 * 时长经 `--motion-reveal-lift-duration` 传给 CSS。`settle` 是卡片放稳的时刻（秒），卡外的分数从这时开始滚。
 */
const revealLiftDuration = duration.slow + duration.base;
export const revealCard = {
  initial: { opacity: 0, scale: 1, y: 0 },
  animate: { opacity: 1, scale: [1, 0.96, 1.025, 1], y: [0, 6, -2, 0] },
  transition: {
    duration: revealLiftDuration,
    times: [0, 0.3, 0.68, 1],
    ease: [ease.inOut, ease.emphasized, ease.inOut],
    opacity: { duration: duration.instant, ease: ease.out },
  },
  settle: revealLiftDuration,
} satisfies {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  transition: Transition;
  settle: number;
};

/**
 * 排位结算的分数变化徽章（「+15」）：分数从卡片放稳时开始逐位滚动，徽章等数字滚到位才盖上去，
 * 不先于数字把结果说出来。时刻取 `digitRoll` 的弹簧走到 95%（读作「到了」，早于完全静止）。
 */
export const ratingReveal = {
  ...receiptMark,
  transition: {
    ...receiptMark.transition,
    delay: revealCard.settle + springReachMs(digitRoll.transition, 0.95) / 1000,
  },
} as const;

/**
 * 阶段标题自基线下方的遮罩里升起：外层裁切，内层整行上移到位，读作「翻到了新的一页」。
 * 晚阶段内容 `followDelay` 起步，标题是从属于这次切换的那一拍；减弱动效下直接显示终态。
 */
export const phaseTitleRise = {
  initial: { y: "110%" },
  animate: { y: "0%" },
  transition: { ...spring.settle, delay: followDelay },
} as const;

/**
 * 线索表新行逐格翻开：角色名先滑入，数值块依次绕 X 轴翻开，视线被从左带到右，像开奖。
 * 旧行按 `push` 下推，新行等它基本推到位（`rowDelay`）再翻，两行不重叠；猜中那一行所有格子同时翻开（不错峰），与普通猜测拉开反差。
 * 翻牌走 `spring.impulse`，落位带一次轻微过冲；透明度只用来遮住转到背面的那几帧。
 */
export const clueFlip = {
  push: { layout: spring.swift } satisfies Transition,
  rowDelay: springReachMs(spring.swift, 0.95) / 1000,
  step: 0.05,
  perspective: 500,
  from: -100,
  slide: -12,
} as const;

/** 翻开前的数值块与滑入前的角色名、标签列：只在新到的那一行上挂这组变体。 */
export const clueFlipChip: Variants = {
  initial: { rotateX: clueFlip.from, opacity: 0, transformPerspective: clueFlip.perspective },
  animate: {
    rotateX: 0,
    opacity: 1,
    transformPerspective: clueFlip.perspective,
    transition: {
      rotateX: spring.impulse,
      opacity: { duration: duration.instant, ease: ease.out },
    },
  },
};

/**
 * 线索开奖的落锤：猜中那一行的格子同时翻到位后，「猜中」标记像回执一样盖上去，给这一轮一个收尾的重音。
 * 时刻取翻格弹簧第一次翻到位（不等回弹结束），读作「翻完——咚」。只用于新到的猜中行。
 */
export const clueHammer = {
  ...receiptMark,
  transition: {
    ...receiptMark.transition,
    delay: clueFlip.rowDelay + springReachMs(spring.impulse, 1) / 1000,
  },
} as const;

/**
 * 与落锤同一拍：猜中行左侧的成功竖条自上而下落满整行高度。
 * 竖条贴着行的上下边，用几乎不过冲的 snap：impulse 的回弹会让它戳进下一行。
 */
export const clueHammerBar = {
  initial: { scaleY: 0 },
  animate: { scaleY: 1 },
  transition: { ...spring.snap, delay: clueHammer.transition.delay },
} as const;

export const clueFlipName: Variants = {
  initial: { x: clueFlip.slide, opacity: 0 },
  animate: { x: 0, opacity: 1, transition: spring.swift },
};

export const clueFlipFade: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: duration.base, ease: ease.out } },
};

/** 新行本身：不做缩放，只负责等待与把子项按格错峰（猜中时 `custom` 传 true，所有格同时翻）。 */
export const clueFlipRow: Variants = {
  initial: {},
  animate: (correct: boolean) => ({
    transition: { delayChildren: clueFlip.rowDelay, staggerChildren: correct ? 0 : clueFlip.step },
  }),
};

/**
 * 复读链叠成台阶：聊天末尾连续几条相同文本，从第二条起逐条向内错开 `shift` 像素、放大 `grow`，
 * 叠成一道向前的台阶；最前面那条带 ×N 角标。有人说了别的，链就断了，台阶按同一条弹簧收回成普通气泡。
 * 级数封顶 `maxSteps`，放大不超过 `1 + grow × maxSteps`，不至于压到相邻消息；只改视觉，消息与读屏不变。
 */
export const repeatStair = {
  shift: 6,
  grow: 0.025,
  maxSteps: 4,
  transition: spring.settle,
} as const;

/** 自右侧滑入的提示（Toast）：从屏幕边缘被推进来，退出沿原路回去。堆叠重排由组件的 `layout` 配 `spring.settle` 负责。 */
export const toastItem: Variants = {
  initial: { opacity: 0, x: 24, scale: 0.96 },
  animate: { opacity: 1, x: 0, scale: 1, transition: spring.swift },
  exit: {
    opacity: 0,
    x: 24,
    scale: 0.97,
    transition: { duration: duration.quick, ease: ease.inOut },
  },
};

/** 自底部升起的横幅（新版本提醒）。 */
export const bannerRise: Variants = {
  initial: { opacity: 0, y: 20, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1, transition: spring.swift },
  exit: {
    opacity: 0,
    y: 16,
    scale: 0.96,
    transition: { duration: duration.quick, ease: ease.inOut },
  },
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
 * 进房编排：顶栏、玩家栏、游戏区、聊天栏按 `parts` 的顺序依次晚一步就位，读作「房间被搭起来」。
 * 玩家栏与聊天栏自外侧边缘等比展开（`scale` 起点），顶栏与游戏区只显影（游戏区内容另有 `phaseSwap` 自后推入）。
 * 顺序在这里定义一次：CSS 的各栏延迟与 `roomEntranceMs` 都由它生成。
 */
export const roomEntrance = {
  step: 0.05,
  scale: 0.97,
  parts: ["header", "player", "game", "chat"],
} as const;

/**
 * 进房编排的窗口（毫秒）：最后一栏晚 `parts.length - 1` 步起播，按 `spring.swift` 落定为止。
 * 窗口内挂载的栏参与编排，窗口外才出现的栏（断线重连后补上、CEE 加入成功后才有的栏）直接出现，不重播。
 */
export const roomEntranceMs =
  Math.round((roomEntrance.parts.length - 1) * roomEntrance.step * 1000) +
  springSettleMs(spring.swift);
