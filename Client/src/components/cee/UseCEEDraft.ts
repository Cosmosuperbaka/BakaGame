import { useState } from "react";
import equal from "fast-deep-equal";

/**
 * 房主可编辑的设置草稿，与服务端当前值保持同步。
 *
 * 草稿只在挂载时取一次服务端值会出问题：房主移交后，同一个面板从只读翻成可编辑，
 * 草稿还是进房时的旧值，用户改任何一项都会把整份旧草稿写回服务端。因此草稿要在两种时机重置为服务端当前值：
 * - 我刚获得编辑权（`editable` 由假变真）：只读期间草稿从未被编辑，直接重置；
 * - 服务端值变化且草稿没有未保存的修改（与上次同步的服务端值深相等）：跟随服务端。
 * 有未保存修改时不重置，以免冲掉用户正在输入的内容。
 *
 * 返回的 `epoch` 每次重置加一，依赖「草稿起点」的派生状态（例如目录是否已同步）可以据此作废。
 * 在渲染中基于上一轮 props 调整 state 是 React 认可的派生写法，不需要 Effect。
 */
export function useCEEDraft<T>(serverValue: T, editable: boolean) {
  const [draft, setDraft] = useState<T>(() => structuredClone(serverValue));
  const [synced, setSynced] = useState({ value: serverValue, editable, epoch: 0 });
  if (synced.editable !== editable || !equal(synced.value, serverValue)) {
    const gainedEdit = editable && !synced.editable;
    const reset = gainedEdit || (editable && equal(draft, synced.value));
    setSynced({ value: serverValue, editable, epoch: synced.epoch + (reset ? 1 : 0) });
    if (reset) setDraft(structuredClone(serverValue));
  }
  return { draft, setDraft, epoch: synced.epoch };
}
