import { describe, expect, it } from "vitest";
import {
  listItem,
  scoreReveal,
  scoreRevealDelay,
  scoreRollDelay,
  sheetSlide,
} from "./Choreography";

describe("Motion tokens", () => {
  it("侧边抽屉自所在边缘滑入、沿原路滑出，面板不动透明度", () => {
    const initial = sheetSlide.initial as (side: "left" | "right") => Record<string, unknown>;
    const exit = sheetSlide.exit as (side: "left" | "right") => Record<string, unknown>;
    expect(initial("right")).toEqual({ x: "100%" });
    expect(initial("left")).toEqual({ x: "-100%" });
    expect(exit("right")).toMatchObject({ x: "100%" });
    expect(exit("left")).toMatchObject({ x: "-100%" });
    expect(initial("right")).not.toHaveProperty("opacity");
    expect(exit("right")).not.toHaveProperty("opacity");
  });

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

  it("结算表按名次自末行往上揭示、按座次自上而下，总跨度封顶", () => {
    const ranked = [0, 1, 2, 3].map((index) => scoreRevealDelay(index, 4, true));
    // 第一名在首行、最后落定，末行最先出现。
    expect(ranked[0]).toBeGreaterThan(ranked[1]);
    expect(ranked[3]).toBe(0);
    const seated = [0, 1, 2, 3].map((index) => scoreRevealDelay(index, 4, false));
    expect(seated).toEqual([...ranked].reverse());
    expect(seated[1] - seated[0]).toBeCloseTo(scoreReveal.step);
    // 人多时步长收窄，最晚一行的等待不超过总跨度。
    expect(scoreRevealDelay(0, 16, true)).toBeCloseTo(scoreReveal.span);
    expect(scoreRevealDelay(0, 1, true)).toBe(0);
  });

  it("数字在行落定后才滚，与揭示方向无关", () => {
    for (const count of [1, 3, 6, 16]) {
      for (const ranked of [true, false]) {
        const rolls = Array.from({ length: count }, (_, index) =>
          scoreRollDelay(index, count, ranked)
        );
        rolls.forEach((roll, index) =>
          expect(roll).toBeGreaterThan(scoreRevealDelay(index, count, ranked))
        );
      }
    }
  });
});
