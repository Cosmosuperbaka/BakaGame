import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatAbsoluteTime, formatRelativeTime } from "./Time";

/** 固定「现在」，否则跨秒的用例会在测试机慢时抖成上一档。 */
const NOW = new Date("2026-10-06T09:00:00Z");

function ago(milliseconds: number) {
  return new Date(NOW.getTime() - milliseconds).toISOString();
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRelativeTime", () => {
  it("clamps future timestamps and clock skew to 刚刚", () => {
    expect(formatRelativeTime(ago(-5 * SECOND))).toBe("刚刚");
    expect(formatRelativeTime(NOW.toISOString())).toBe("刚刚");
  });

  it("counts seconds, minutes and hours before falling back to days", () => {
    expect(formatRelativeTime(ago(30 * SECOND))).toBe("30秒钟前");
    expect(formatRelativeTime(ago(5 * MINUTE))).toBe("5分钟前");
    expect(formatRelativeTime(ago(3 * HOUR))).toBe("3小时前");
    expect(formatRelativeTime(ago(2 * DAY))).toBe("2天前");
  });

  it("rolls days into months and months into years", () => {
    expect(formatRelativeTime(ago(40 * DAY))).toBe("1个月前");
    expect(formatRelativeTime(ago(400 * DAY))).toBe("1年前");
  });

  it("treats a plain date as local midnight instead of utc", () => {
    expect(formatRelativeTime("2026-10-06")).toMatch(/前$/);
  });

  it("returns the input untouched when it is not a date", () => {
    expect(formatRelativeTime("不是时间")).toBe("不是时间");
  });
});

describe("formatAbsoluteTime", () => {
  it("formats to the minute so a stale version can be dated exactly", () => {
    expect(formatAbsoluteTime(ago(3 * DAY))).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  it("accepts the plain-date form used by changelog entries", () => {
    expect(formatAbsoluteTime("2026-10-06")).toMatch(/^2026\/10\/06 \d{2}:\d{2}$/);
  });

  it("returns the input untouched when it is not a date", () => {
    expect(formatAbsoluteTime("不是时间")).toBe("不是时间");
  });
});
