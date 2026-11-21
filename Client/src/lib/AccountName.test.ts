import { describe, expect, it } from "vitest";
import { ACCOUNT_NAME_CHANGE_COOLDOWN_MS } from "@bakagame/shared/values";
import {
  ACCOUNT_NAME_COOLDOWN_DAYS,
  formatNameChangeTime,
  formatNameCooldownLeft,
  nameChangeAvailableAt,
} from "./AccountName";

describe("账号昵称改名冷却", () => {
  it("从未改过名返回空（随时可改），否则为上次改名加冷却时长", () => {
    expect(nameChangeAvailableAt(null)).toBeNull();
    expect(nameChangeAvailableAt("不是时间")).toBeNull();
    const changed = "2026-11-20T06:30:00.000Z";
    expect(nameChangeAvailableAt(changed)).toBe(
      Date.parse(changed) + ACCOUNT_NAME_CHANGE_COOLDOWN_MS
    );
    expect(ACCOUNT_NAME_COOLDOWN_DAYS).toBe(7);
  });

  it("可改时刻写到分钟，剩余时间够一天按天、不够按小时", () => {
    expect(formatNameChangeTime(new Date(2026, 10, 29, 0, 5).getTime())).toBe("11月29日 00:05");
    expect(formatNameCooldownLeft(6.2 * 86_400_000)).toBe("7 天");
    expect(formatNameCooldownLeft(86_400_000)).toBe("1 天");
    expect(formatNameCooldownLeft(5.5 * 3_600_000)).toBe("6 小时");
    expect(formatNameCooldownLeft(59 * 60_000)).toBe("不到 1 小时");
  });
});
