import { describe, expect, it } from "vitest";
import { duration, spring, springToCss } from "./Transitions";
import { followDelay } from "./Choreography";
import {
  clueFlip,
  clueFlipRow,
  receiptMark,
  receiptMarkFollow,
  repeatStair,
  revealCard,
  springSettleMs,
  wordRevealTiming,
} from "./NamedMoves";

describe("Motion tokens", () => {
  it("答案卡的「沉」要看得见：起点就是第一帧的尺寸，卡片在沉到底之前已完全显出", () => {
    const { initial, animate, transition } = revealCard;
    expect(initial.scale).toBe(animate.scale[0]);
    expect(Math.min(...animate.scale)).toBeLessThan(animate.scale[0]);
    const sinkEnd = transition.times[1] * transition.duration;
    expect(transition.opacity.duration).toBeLessThan(sinkEnd);
  });

  it("复读台阶封顶：最高一级放大不超过 1.15，猜中行的翻牌不错峰", () => {
    expect(1 + repeatStair.grow * repeatStair.maxSteps).toBeLessThanOrEqual(1.15);
    const animate = clueFlipRow.animate as (correct: boolean) => {
      transition: { staggerChildren: number };
    };
    expect(animate(true).transition.staggerChildren).toBe(0);
    expect(animate(false).transition.staggerChildren).toBe(clueFlip.step);
  });
});

describe("计时令牌", () => {
  it("springSettleMs 与 CSS 变量里的静止时长一致", () => {
    for (const token of Object.values(spring)) {
      expect(springSettleMs(token)).toBe(Math.round(springToCss(token).duration * 1000));
    }
    // 玩家栏收起要等宽度动画静止，至少覆盖 settle 的主体过程。
    expect(springSettleMs(spring.settle)).toBeGreaterThan(400);
  });

  it("揭词在停留时长之后才停靠", () => {
    expect(wordRevealTiming.showAfterMs).toBeLessThan(wordRevealTiming.dockAfterMs);
    expect(wordRevealTiming.dockAfterMs).toBeGreaterThan(duration.hold * 1000);
  });

  it("回执对勾晚卡片一拍出现", () => {
    expect(receiptMarkFollow.initial).toEqual(receiptMark.initial);
    expect(receiptMarkFollow.transition.delay).toBe(followDelay);
  });
});
