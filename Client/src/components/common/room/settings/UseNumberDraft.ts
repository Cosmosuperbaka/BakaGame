import { useState } from "react";

const show = (value: number | undefined) => (value === undefined ? "" : String(value));

/**
 * 数值文本框的草稿：输入过程中只改草稿字符串，失焦或回车才提交，并夹到范围内、取整。
 * 输入 2026 这类多位数时不会在第一位就被夹成下限。
 * `optional` 时留空表示「不限」，提交 `undefined`；否则留空或写了非数字就退回当前值。
 * 外部的 `value` 变了（别处改了、服务端回写）草稿跟着重置。
 */
export function useNumberDraft({
  value,
  minimum,
  maximum,
  optional = false,
  onCommit,
}: {
  value: number | undefined;
  minimum: number;
  maximum: number;
  optional?: boolean;
  onCommit: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(show(value));
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setDraft(show(value));
  }

  /** 直接提交一个数：按钮与方向键走这里，夹取、取整、没变就不重复提交。 */
  const commit = (next: number) => {
    const clamped = Math.max(minimum, Math.min(maximum, Math.round(next)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  /** 提交草稿里的文字：失焦与回车走这里。 */
  const commitDraft = () => {
    const blank = draft.trim() === "";
    if (blank && optional) {
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const parsed = Number(draft);
    if (blank || !Number.isFinite(parsed)) setDraft(show(value));
    else commit(parsed);
  };

  return { draft, setDraft, commit, commitDraft };
}
