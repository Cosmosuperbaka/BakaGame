import type { TargetAndTransition, Transition } from "framer-motion";
import { spring, ease, duration, springToCss } from "@/lib/motion/Transitions";
import { popoverScale } from "@/lib/motion/Choreography";
import { agentGesture, revealCard, roomEntrance } from "@/lib/motion/NamedMoves";

// ==================== CSS 令牌 ====================
// 无法接入 framer-motion 的场景（Radix data-state 浮层、开关滑块、Tailwind 过渡类）
// 读 `:root` 上的 `--motion-*` 变量。变量由下面的函数从上方令牌生成，不在 CSS 里手抄。

const cubicBezier = (curve: readonly number[]) => `cubic-bezier(${curve.join(", ")})`;
const seconds = (value: number) => `${Number(value.toFixed(3))}s`;
const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/**
 * 跨页过渡的前后两层尺度：后方一层略小，前方一层略大。
 * 前进时新页自后方推入、旧页向前退出，返回时两者对调；
 * 整页面积远大于游戏区，幅度比 `phaseSwap` 收一半，免得边缘位移过大。
 */
export const pageScale = { behind: 0.985, ahead: 1.015 } as const;

/**
 * 关于项目页（`/abouts`）的专属开合行程：整页自视口底缘升起，关闭时沿原路落回页脚。
 * 它读作「从页脚的版本号拉出一整页」，与其它页面的前后推入不同：
 * 旧页留在原地当底衬，新页盖上来（关闭时反向揭示）。前后关系与方向写在 `index.css`。
 */
export const creditsPage = { travel: 100 } as const;

/** 全部 CSS 动效变量。键名即 `--motion-` 之后的部分。 */
export function motionCssVariables(): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [name, curve] of Object.entries(ease))
    variables[`ease-${kebab(name)}`] = cubicBezier(curve);
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
  variables["page-credits-travel"] = `${creditsPage.travel}%`;
  variables["reveal-lift-duration"] = seconds(revealCard.settle);
  variables["room-entrance-scale"] = String(roomEntrance.scale);
  roomEntrance.parts.forEach((part, index) => {
    variables[`room-entrance-delay-${part}`] = seconds(index * roomEntrance.step);
  });
  for (const [name, value] of Object.entries(agentGesture))
    variables[`agent-${kebab(name)}`] = String(value);
  return variables;
}

const percent = (fraction: number) => `${Number((fraction * 100).toFixed(2))}%`;

/**
 * 答案卡抬起的投影关键帧：百分比不能读变量，所以整段由 `revealCard` 的 `times` 生成——
 * 沉之前与放回之后没有投影，抬到最高处投影最远。改揭晓的分段时，投影跟着一起变。
 */
function revealLiftShadowKeyframes(): string {
  const [start, sink, lift, end] = revealCard.transition.times;
  const hidden = [start, sink, end].map(percent).join(", ");
  return `@keyframes reveal-lift-shadow { ${hidden} { opacity: 0; } ${percent(lift)} { opacity: 1; } }`;
}

/**
 * 生成写入 `:root` 的样式表。减弱动效时弹性时长归零：
 * 弹性只用于位移与缩放，与 `MotionConfig reducedMotion="user"` 关掉变换动画同口径；颜色过渡保留。
 */
export function motionTokenCss(): string {
  const variables = motionCssVariables();
  const declarations = Object.entries(variables).map(
    ([name, value]) => `--motion-${name}: ${value};`
  );
  const reduced = Object.keys(variables)
    .filter((name) => name.startsWith("spring-") && name.endsWith("-duration"))
    .map((name) => `--motion-${name}: 0s;`);
  return [
    `:root { ${declarations.join(" ")} }`,
    `@media (prefers-reduced-motion: reduce) { :root { ${reduced.join(" ")} } }`,
    revealLiftShadowKeyframes(),
  ].join("\n");
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

/**
 * 倒计时进入最后阶段的脉动：表达真实的持续状态「快到时间了」，不做纯装饰。
 * 一拍正好一秒、从进入末段那一刻（读秒换数的时刻）起拍，每次读秒换数都跟着跳一下，像秒针在敲；
 * 起跳快、回落慢。幅度按 12–16px 的小图标定：再大就从「跳」变成「胀」。
 */
export const urgentPulse: { animate: TargetAndTransition; transition: Transition } = {
  animate: { scale: [1, 1.12, 1] },
  transition: { duration: 1, times: [0, 0.25, 1], ease: [ease.out, ease.inOut], repeat: Infinity },
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
