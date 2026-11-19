import { describe, expect, it } from "vitest";
import { byAxes, jitterFrames, stepJitter, stepJitterAnimation, tabPushSwap } from "./Throw";

describe("Motion tokens", () => {
  it("抛掷取位移较大的一轴为主轴，形变只落在 scale 上", () => {
    expect(byAxes({ dx: 400, dy: 10 }, "along", "across")).toEqual({
      scaleX: "along",
      scaleY: "across",
    });
    expect(byAxes({ dx: 10, dy: 300 }, "along", "across")).toEqual({
      scaleX: "across",
      scaleY: "along",
    });
  });

  it("标签推移整幅进出、方向相反，没有方向时直接换掉", () => {
    const initial = tabPushSwap.initial as (direction: number) => Record<string, unknown>;
    const exit = tabPushSwap.exit as (direction: number) => Record<string, unknown>;
    expect(initial(1).x).toBe("104%");
    expect(exit(1).x).toBe("-104%");
    expect(initial(1)).not.toHaveProperty("opacity");
    expect(initial(0)).toEqual({ x: "0%" });
    expect(exit(0)).toMatchObject({ visibility: "hidden" });
  });

  it("阶梯抖动正负交替衰减、末格归零，每格之间硬切", () => {
    const frames = jitterFrames();
    expect(Math.max(...frames.map(Math.abs))).toBe(1);
    expect(frames.at(-1)).toBe(0);
    expect(frames.length).toBeLessThan(stepJitter.fps);
    expect(frames.some((value) => value > 0) && frames.some((value) => value < 0)).toBe(true);
    const { keyframes, transition } = stepJitterAnimation({ y: 2 });
    expect(keyframes.y?.[0]).toBe(0);
    expect(keyframes.y).toHaveLength(frames.length + 1);
    const ease = (transition as { ease: Array<(progress: number) => number> }).ease;
    expect(ease).toHaveLength(frames.length);
    expect([ease[0](0), ease[0](0.01), ease[0](0.99)]).toEqual([0, 1, 1]);
  });
});
