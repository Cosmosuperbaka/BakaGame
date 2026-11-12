import { useEffect, useState } from "react";
import { SerialSaveQueue } from "./SerialSaveQueue";

interface AutoSaveOptions {
  delayMs?: number;
  enabled?: boolean;
  onError?: (error: unknown) => void;
}

/**
 * 文本输入防抖、显式串行保存队列：队列本身见 `SerialSaveQueue`，这里只负责接上 React 生命周期。
 * 纯 Effect 驱动，严禁在渲染阶段读写 ref。
 */
export function useAutoSave<T>(
  value: T,
  save: (value: T) => Promise<unknown>,
  options: AutoSaveOptions = {}
) {
  const { delayMs = 400, enabled = true, onError } = options;
  const [queue] = useState(
    () => new SerialSaveQueue<T>(value, { save, onError, delayMs, enabled })
  );

  // 在提交阶段同步最新的配置与回调，杜绝在 render 阶段读写。
  useEffect(() => {
    queue.configure({ save, onError, delayMs, enabled });
  });

  // 监听值变化与启用状态
  useEffect(() => {
    if (!enabled) {
      queue.disable();
      return;
    }
    queue.setValue(value);
    return () => queue.cancelTimer();
  }, [queue, delayMs, enabled, value]);

  // 组件卸载阶段刷新最新草稿
  useEffect(() => {
    queue.mount();
    return () => queue.unmount();
  }, [queue]);
}
