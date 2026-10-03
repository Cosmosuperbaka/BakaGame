import { useState } from "react";

/** 最近一次变化：从哪个值变到哪个值，`serial` 每变一次加一，供动画按次去重。 */
export interface ValueChange {
  from: number;
  to: number;
  serial: number;
}

/**
 * 记下数值的最近一次变化。在渲染中比对而不是放进 effect：变化的那一帧就能开始播放，不会先闪一帧新值。
 * 挂载时的初始值不算变化，重新挂载（换布局、开抽屉）也不会重播。
 */
export function useValueChange(value: number): ValueChange | null {
  const [state, setState] = useState<{ value: number; change: ValueChange | null }>({ value, change: null });
  if (!Object.is(state.value, value)) {
    const change = { from: state.value, to: value, serial: (state.change?.serial ?? 0) + 1 };
    setState({ value, change });
    return change;
  }
  return state.change;
}
