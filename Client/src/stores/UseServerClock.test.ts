import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  estimateClockSample,
  getClockOffsetMs,
  preferClockSample,
  expireClockSample,
  recordClockSample,
  resetClockSample,
  serverNow,
} from "./UseServerClock";

describe("estimateClockSample", () => {
  it("本机时钟比服务端快：偏差为负，往返中点对齐服务端时刻", () => {
    // 本机在 10_000 发出、10_200 收到（往返 200），服务端时刻 4_100 对应本机中点 10_100。
    expect(estimateClockSample(4_100, 10_000, 10_200)).toEqual({
      offsetMs: -6_000,
      roundTripMs: 200,
    });
  });

  it("本机时钟比服务端慢：偏差为正", () => {
    expect(estimateClockSample(70_100, 10_000, 10_200)).toEqual({
      offsetMs: 60_000,
      roundTripMs: 200,
    });
  });

  it("本机时钟在往返期间被回拨：往返耗时取零而不是负数", () => {
    expect(estimateClockSample(5_000, 10_000, 9_000)).toEqual({ offsetMs: -5_000, roundTripMs: 0 });
  });
});

describe("preferClockSample", () => {
  it("没有旧样本时采信新样本", () => {
    const next = { offsetMs: 5, roundTripMs: 90 };
    expect(preferClockSample(null, next)).toBe(next);
  });

  it("往返长的样本不覆盖往返短的", () => {
    const good = { offsetMs: 1_000, roundTripMs: 40 };
    const noisy = { offsetMs: 1_400, roundTripMs: 800 };
    expect(preferClockSample(good, noisy)).toBe(good);
  });

  it("往返更短或相同的新样本取代旧样本", () => {
    const old = { offsetMs: 1_000, roundTripMs: 100 };
    const shorter = { offsetMs: 1_010, roundTripMs: 30 };
    expect(preferClockSample(old, shorter)).toBe(shorter);
    const same = { offsetMs: 1_020, roundTripMs: 30 };
    expect(preferClockSample(shorter, same)).toBe(same);
  });
});

describe("校正后的当前时刻", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    resetClockSample();
  });

  afterEach(() => {
    resetClockSample();
    vi.useRealTimers();
  });

  it("没有样本时偏差为零，退回本机时钟", () => {
    expect(getClockOffsetMs()).toBe(0);
    expect(serverNow()).toBe(10_000);
  });

  it("本机时钟快 6 秒：校正后的时刻回到服务端时间轴", () => {
    recordClockSample(4_100, 10_000, 10_200);
    expect(serverNow()).toBe(4_000);
  });

  it("本机时钟慢 60 秒：校正后的时刻向前补齐", () => {
    recordClockSample(70_100, 10_000, 10_200);
    expect(serverNow()).toBe(70_000);
  });

  it("往返长的样本不覆盖往返短的", () => {
    recordClockSample(4_100, 10_000, 10_200);
    recordClockSample(4_500, 10_000, 10_900);
    expect(getClockOffsetMs()).toBe(-6_000);
  });

  it("断线后旧偏差继续使用，读秒不因重连间隙跳一下", () => {
    recordClockSample(4_100, 10_000, 10_200);
    expireClockSample();
    expect(getClockOffsetMs()).toBe(-6_000);
    expect(serverNow()).toBe(4_000);
  });

  it("重连后的第一个新样本无条件取代过期样本，即使往返更长", () => {
    recordClockSample(4_100, 10_000, 10_200);
    expireClockSample();
    // 往返 900 毫秒，远长于旧样本的 200，但旧样本已过期，必须被取代
    recordClockSample(4_650, 10_000, 10_900);
    expect(getClockOffsetMs()).toBe(-5_800);
  });

  it("过期样本被取代之后恢复往返最短优先", () => {
    recordClockSample(4_100, 10_000, 10_200);
    expireClockSample();
    recordClockSample(4_650, 10_000, 10_900);
    // 往返更长的样本不再覆盖
    recordClockSample(4_800, 10_000, 11_500);
    expect(getClockOffsetMs()).toBe(-5_800);
    // 往返更短的样本取代
    recordClockSample(4_050, 10_000, 10_100);
    expect(getClockOffsetMs()).toBe(-6_000);
  });

  it("没有样本时标过期没有影响，之后第一个样本照常采信", () => {
    expireClockSample();
    expect(getClockOffsetMs()).toBe(0);
    recordClockSample(4_100, 10_000, 10_200);
    recordClockSample(4_500, 10_000, 10_900);
    expect(getClockOffsetMs()).toBe(-6_000);
  });

  it("完全清除样本后偏差回到零", () => {
    recordClockSample(4_100, 10_000, 10_200);
    resetClockSample();
    expect(getClockOffsetMs()).toBe(0);
  });
});
