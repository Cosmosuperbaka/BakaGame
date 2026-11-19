import { useCallback, useEffect, useRef, useState } from "react";

/** 「已复制」反馈的默认停留时长：给玩家读完提示的时间，不参与任何业务时序。 */
const DEFAULT_RESET_MS = 2_000;

/**
 * 复制到剪贴板并给出短暂的「已复制」反馈。
 * `copy` 只返回是否写入成功：失败怎么提示（吞掉还是上报）是调用点的策略。
 * 同一处有多个复制按钮时用 `key` 区分，`copied` 是当前处于「已复制」的那个键。
 */
export function useCopyFeedback(resetMs = DEFAULT_RESET_MS) {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string, key = "default"): Promise<boolean> => {
      if (!navigator.clipboard?.writeText) return false;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return false;
      }
      setCopied(key);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), resetMs);
      return true;
    },
    [resetMs]
  );

  return { copied, copy };
}
