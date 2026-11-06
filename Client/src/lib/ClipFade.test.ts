import { describe, expect, it } from "vitest";
import { clipFadeFactor, clipVolume } from "./ClipFade";

describe("片段音量包络", () => {
  it("起点淡入、终点淡出，中段保持满幅", () => {
    expect(clipFadeFactor(10, 10, 20)).toBe(0);
    expect(clipFadeFactor(10.5, 10, 20)).toBeCloseTo(0.5, 5);
    expect(clipFadeFactor(15, 10, 20)).toBe(1);
    expect(clipFadeFactor(19.5, 10, 20)).toBeCloseTo(0.5, 5);
    expect(clipFadeFactor(20, 10, 20)).toBe(0);
  });

  it("短片段的渐变不超过一半时长；没有终点时不做包络", () => {
    expect(clipFadeFactor(10.5, 10, 11)).toBe(1);
    expect(clipFadeFactor(10, 10)).toBe(1);
  });

  it("实际音量是音量设置乘包络，并收在 0 到 1 之间", () => {
    expect(clipVolume(0.4, 15, 10, 20)).toBeCloseTo(0.4, 5);
    expect(clipVolume(0.4, 10.5, 10, 20)).toBeCloseTo(0.2, 5);
    expect(clipVolume(2, 15, 10, 20)).toBe(1);
  });
});
