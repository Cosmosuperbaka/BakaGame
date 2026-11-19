import { describe, expect, it } from "vitest";
import { beijingDayStart, formatRatio } from "./StatusFormat";

describe("formatRatio", () => {
  it("没有结论读作破折号，满分读作 100.0%", () => {
    expect(formatRatio(null)).toBe("—");
    expect(formatRatio(1)).toBe("100.0%");
  });

  it("失败过一次也不会四舍五入成满分", () => {
    // 一天约 5700 个样本里只挂一次：可用率 99.98%，日格是红的，行尾读数不能写 100.0%。
    expect(formatRatio(5728 / 5729)).toBe("99.98%");
    expect(formatRatio(0.99999)).toBe("99.99%");
  });

  it("不满分向下截到两位小数，不受浮点误差影响", () => {
    expect(formatRatio(0.9554939)).toBe("95.54%");
    expect(formatRatio(0.29)).toBe("29.00%");
    expect(formatRatio(0.5)).toBe("50.00%");
    expect(formatRatio(0)).toBe("0.00%");
  });
});

describe("beijingDayStart", () => {
  it("北京自然日零点，换算到 UTC 是前一天 16 点", () => {
    expect(beijingDayStart("2026-10-21")).toBe(Date.UTC(2026, 9, 20, 16, 0, 0));
    expect(beijingDayStart("2026-01-01")).toBe(Date.UTC(2025, 11, 31, 16, 0, 0));
  });
});
