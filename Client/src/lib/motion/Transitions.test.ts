import { describe, expect, it } from "vitest";
import { spring, springReachMs, springToCss, springTrace } from "./Transitions";

/** 解析 `linear(a, b, ...)` 的取值序列。 */
function linearPoints(easing: string): number[] {
  const match = /^linear\((.*)\)$/.exec(easing);
  if (!match) throw new Error(`不是 linear(): ${easing}`);
  return match[1].split(",").map((value) => Number(value.trim()));
}

describe("Motion tokens", () => {
  it("负的初速度先朝反方向走，正的初速度更早到达", () => {
    expect(Math.min(...springTrace(spring.recall, -8))).toBeLessThan(0);
    expect(Math.min(...springTrace(spring.recall))).toBe(0);
    expect(springReachMs(spring.thrust, 0.9, 2)).toBeLessThan(springReachMs(spring.thrust, 0.9));
  });

  it("副轴的 wobble 比主轴的 thrust 过冲更大、落定更晚", () => {
    const peak = (name: keyof typeof spring) => Math.max(...springTrace(spring[name]));
    expect(peak("wobble")).toBeGreaterThan(peak("thrust"));
    expect(peak("thrust")).toBeGreaterThan(1.03);
    expect(springTrace(spring.wobble).length).toBeGreaterThan(springTrace(spring.thrust).length);
  });
});

describe("springToCss", () => {
  it("曲线从 0 出发、落在 1，每档都在 1 秒内静止", () => {
    for (const token of Object.values(spring)) {
      const { easing, duration: settle } = springToCss(token);
      const points = linearPoints(easing);
      expect(points[0]).toBe(0);
      expect(points.at(-1)).toBe(1);
      expect(settle).toBeGreaterThan(0.1);
      expect(settle).toBeLessThan(1);
    }
  });

  it("越重的档位静止得越晚", () => {
    const settle = (name: keyof typeof spring) => springToCss(spring[name]).duration;
    expect(settle("snap")).toBeLessThan(settle("swift"));
    expect(settle("swift")).toBeLessThan(settle("settle"));
    expect(settle("settle")).toBeLessThan(settle("drift"));
  });

  it("低阻尼的 impulse 保留过冲，snap 的过冲克制", () => {
    const peak = (name: keyof typeof spring) =>
      Math.max(...linearPoints(springToCss(spring[name]).easing));
    expect(peak("impulse")).toBeGreaterThan(1.1);
    expect(peak("snap")).toBeLessThan(1.05);
  });

  it("与解析解一致：临界阻尼的弹性单调上升、不越过 1", () => {
    // stiffness 100、mass 1 时临界阻尼为 2√(km) = 20。
    const points = linearPoints(
      springToCss({ type: "spring", stiffness: 100, damping: 20, mass: 1 }).easing
    );
    for (let index = 1; index < points.length; index += 1) {
      expect(points[index]).toBeGreaterThanOrEqual(points[index - 1]);
    }
    expect(Math.max(...points)).toBeLessThanOrEqual(1);
  });
});
