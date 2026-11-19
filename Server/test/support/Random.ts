/** mulberry32：同种子给出同序列，测试才可复现。 */
export const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** 按顺序吐出给定值，用完继续循环，便于固定 Box–Muller 的两个抽样。 */
export const scripted = (values: readonly number[]): (() => number) => {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
};

// cos(2π·0.25) = 0 ⇒ z ≈ 0 ⇒ 对数正态取值即中位数；末位 0.999 保证不发呆。
export const FLAT_Z = [0.5, 0.25, 0.999];
