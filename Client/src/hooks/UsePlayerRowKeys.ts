import { useState } from "react";

interface RowKeyState {
  signature: string;
  /** 每名玩家上一次所在的分组；离开房间的人记作 `ABSENT`，回来时同样算一次换组 */
  groups: Map<string, string>;
  /** 每名玩家换过几次组，拼进行的 key */
  epochs: Map<string, number>;
}

const ABSENT = "\u0000absent";

function advance(state: RowKeyState, entries: ReadonlyArray<{ id: string; group: string }>, signature: string): RowKeyState {
  const groups = new Map(state.groups);
  const epochs = new Map(state.epochs);
  const present = new Set<string>();
  for (const { id, group } of entries) {
    present.add(id);
    const previous = groups.get(id);
    if (previous !== undefined && previous !== group) epochs.set(id, (epochs.get(id) ?? 0) + 1);
    groups.set(id, group);
  }
  for (const id of groups.keys()) if (!present.has(id)) groups.set(id, ABSENT);
  return { signature, groups, epochs };
}

/**
 * 玩家行的 key：玩家编号加上「换组次数」。
 *
 * 行在玩家 / 旁观（CCB 还有队伍）之间换组时，旧分组里的那一行要播退场。若退场还没播完人又换回来，
 * 同 key 的子项会被 `AnimatePresence` 原地「复活」，而 framer-motion 复活退场元素时会回落到 `initial`
 * 的取值（透明、缩小）且不再补播入场，这一行就一直看不见。每换一次组 key 就变一次，
 * 换回来的总是一行新挂载的元素，旧的那行照常退场卸载；跨分组的滑动仍由 `layoutId`（玩家编号）负责。
 */
export function usePlayerRowKeys(entries: ReadonlyArray<{ id: string; group: string }>): (id: string) => string {
  const signature = entries.map(({ id, group }) => `${id}=${group}`).join("\n");
  const [state, setState] = useState<RowKeyState>(() => advance({ signature: "", groups: new Map(), epochs: new Map() }, entries, signature));
  let current = state;
  // 「随渲染派生上一轮信息」的写法：分组变了就在本次渲染里算出新状态并提交，不等 effect 晚一帧。
  if (state.signature !== signature) {
    current = advance(state, entries, signature);
    setState(current);
  }
  return (id) => `${id}:${current.epochs.get(id) ?? 0}`;
}
