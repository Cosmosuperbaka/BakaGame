import { describe, expect, it } from "vitest";
import { duration, ease, installMotionTokens, listItem, motionCssVariables, motionTokenCss, popover, popoverScale, spring, springToCss } from "./Motion";

/** 解析 `linear(a, b, ...)` 的取值序列。 */
function linearPoints(easing: string): number[] {
  const match = /^linear\((.*)\)$/.exec(easing);
  if (!match) throw new Error(`不是 linear(): ${easing}`);
  return match[1].split(",").map((value) => Number(value.trim()));
}

describe("Motion tokens", () => {
  it("listItem variants contract includes pointerEvents none on exit", () => {
    expect(listItem).toBeDefined();
    expect(listItem.initial).toMatchObject({ opacity: 0, scale: 0.94 });
    expect(listItem.animate).toMatchObject({ opacity: 1, scale: 1 });
    expect(listItem.exit).toMatchObject({
      opacity: 0,
      scale: 0.965,
      pointerEvents: "none",
    });
  });

  it("popover 变体与 CSS 关键帧共用同一组起止尺度", () => {
    expect(popover.initial).toMatchObject({ scale: popoverScale.enter });
    expect(popover.exit).toMatchObject({ scale: popoverScale.exit });
    const variables = motionCssVariables();
    expect(variables["popover-enter-scale"]).toBe(String(popoverScale.enter));
    expect(variables["popover-exit-scale"]).toBe(String(popoverScale.exit));
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
    const peak = (name: keyof typeof spring) => Math.max(...linearPoints(springToCss(spring[name]).easing));
    expect(peak("impulse")).toBeGreaterThan(1.1);
    expect(peak("snap")).toBeLessThan(1.05);
  });

  it("与解析解一致：临界阻尼的弹性单调上升、不越过 1", () => {
    // stiffness 100、mass 1 时临界阻尼为 2√(km) = 20。
    const points = linearPoints(springToCss({ type: "spring", stiffness: 100, damping: 20, mass: 1 }).easing);
    for (let index = 1; index < points.length; index += 1) {
      expect(points[index]).toBeGreaterThanOrEqual(points[index - 1]);
    }
    expect(Math.max(...points)).toBeLessThanOrEqual(1);
  });
});

describe("motionTokenCss", () => {
  it("曲线与时长直接取自 ease / duration 令牌", () => {
    const variables = motionCssVariables();
    expect(variables["ease-out"]).toBe(`cubic-bezier(${ease.out.join(", ")})`);
    expect(variables["ease-in-out"]).toBe(`cubic-bezier(${ease.inOut.join(", ")})`);
    expect(variables["ease-emphasized"]).toBe(`cubic-bezier(${ease.emphasized.join(", ")})`);
    expect(variables["duration-quick"]).toBe(`${duration.quick}s`);
    expect(variables["duration-base"]).toBe(`${duration.base}s`);
    expect(variables).not.toHaveProperty("duration-none");
    expect(variables).not.toHaveProperty("duration-hold");
  });

  it("每档弹性都有曲线与时长两个变量，减弱动效时只把弹性时长归零", () => {
    const css = motionTokenCss();
    for (const name of Object.keys(spring)) {
      expect(css).toContain(`--motion-spring-${name}: linear(`);
      expect(css).toMatch(new RegExp(`--motion-spring-${name}-duration: \\d`));
    }
    const reduced = css.slice(css.indexOf("prefers-reduced-motion"));
    expect(reduced).toContain("--motion-spring-snap-duration: 0s;");
    expect(reduced).not.toContain("--motion-duration-quick");
  });

  it("重复安装只更新同一个样式节点", () => {
    installMotionTokens();
    installMotionTokens();
    const nodes = document.head.querySelectorAll("style#motion-tokens");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].textContent).toBe(motionTokenCss());
  });
});
