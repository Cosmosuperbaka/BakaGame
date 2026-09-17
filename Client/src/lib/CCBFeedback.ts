import type { CCBCompareFeedback } from "@/types";

/**
 * 反馈档位 → 视觉档。
 *
 * ⚠️ 逐字对照原版 `GuessesTable.jsx` 的三元表达式，**`++` / `--` 反而没有高亮**：
 * 只有 `=`（correct）、单档 `+` / `-`（partial）、`?`（unknown）三档有底色，
 * `++` / `--` 与其它取值一样是中性。看着像漏写，但那就是原版行为，别"补全"。
 */
export type CCBTone = "correct" | "partial" | "unknown" | "neutral";

export const ccbCompareTone = (feedback: CCBCompareFeedback): CCBTone => {
  if (feedback === "=") return "correct";
  if (feedback === "+" || feedback === "-") return "partial";
  if (feedback === "?") return "unknown";
  return "neutral";
};

/**
 * 箭头方向。**反直觉，务必照抄**：猜得偏高（`+` / `++`）要提示往下猜 `↓`，
 * 偏低（`-` / `--`）提示往上猜 `↑`。判据见 `Agents/CCB.md §6.3`。
 */
export const ccbCompareArrow = (feedback: CCBCompareFeedback): "↑" | "↓" | "" => {
  if (feedback === "+" || feedback === "++") return "↓";
  if (feedback === "-" || feedback === "--") return "↑";
  return "";
};

/** 字号/热度类数值的展示形态：`?` 表示不可比，`-1` 类哨兵由调用方先换成文字。 */
export type CCBScalarDisplay = number | "?" | string;
