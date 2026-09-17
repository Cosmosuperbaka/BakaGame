import { describe, expect, test } from "vitest";

import { ccbCompareArrow, ccbCompareTone } from "@/lib/CCBFeedback";
import type { CCBCompareFeedback } from "@/types";

describe("CCB 反馈档位映射", () => {
  test("只有 = / 单档 +/- / ? 三档有高亮，++ 与 -- 反而是中性", () => {
    // 这条看着像 bug，但原版 `GuessesTable.jsx` 的三元表达式就是这样写的：
    // `=== '=' ? 'correct' : ('+' || '-') ? 'partial' : '?' ? 'unknown' : ''`
    // 两个档位的双符号落在最后的空串分支。**不要"顺手补全"。**
    const table: Array<[CCBCompareFeedback, string]> = [
      ["=", "correct"],
      ["+", "partial"],
      ["-", "partial"],
      ["?", "unknown"],
      ["++", "neutral"],
      ["--", "neutral"],
    ];
    for (const [feedback, tone] of table) {
      expect(ccbCompareTone(feedback)).toBe(tone);
    }
  });

  test("箭头方向与数值高低相反：偏高提示 ↓、偏低提示 ↑", () => {
    const table: Array<[CCBCompareFeedback, string]> = [
      ["+", "↓"],
      ["++", "↓"],
      ["-", "↑"],
      ["--", "↑"],
      ["=", ""],
      ["?", ""],
    ];
    for (const [feedback, arrow] of table) {
      expect(ccbCompareArrow(feedback)).toBe(arrow);
    }
  });

  test("箭头的双符号档也照样给方向（与高亮规则不同）", () => {
    expect(ccbCompareArrow("++")).toBe("↓");
    expect(ccbCompareArrow("--")).toBe("↑");
  });
});
