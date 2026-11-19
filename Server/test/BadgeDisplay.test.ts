import { describe, expect, test } from "bun:test";

import {
  BADGE_DESCRIPTIONS,
  BADGE_LABELS,
  PIONEER_BADGE_LIMIT,
  badgeDescriptionOf,
  badgeLabelOf,
} from "../src/shared/Badges";

describe("先行者徽章展示文案", () => {
  test("序号在名额内：写进名字与悬停描述", () => {
    const badge = { kind: "pioneer", serial: 42 } as const;
    expect(badgeLabelOf(badge)).toBe("先行者·№42");
    expect(badgeDescriptionOf(badge)).toBe("BakaGame的第42位注册用户");
  });

  test("名额边界：最后一个名额还显示序号，再往后退回不带序号的文案", () => {
    const last = { kind: "pioneer", serial: PIONEER_BADGE_LIMIT } as const;
    expect(badgeLabelOf(last)).toBe(`先行者·№${PIONEER_BADGE_LIMIT}`);
    const over = { kind: "pioneer", serial: PIONEER_BADGE_LIMIT + 1 } as const;
    expect(badgeLabelOf(over)).toBe(BADGE_LABELS.pioneer);
    expect(badgeDescriptionOf(over)).toBe(BADGE_DESCRIPTIONS.pioneer);
  });

  test("跳号写出来的几万序号不展示给玩家", () => {
    const badge = { kind: "pioneer", serial: 30_001 } as const;
    expect(badgeLabelOf(badge)).toBe("先行者");
    expect(badgeDescriptionOf(badge)).not.toContain("30001");
  });

  test("没有序号、序号非法或非先行者徽章都用固定文案", () => {
    expect(badgeLabelOf({ kind: "pioneer", serial: null })).toBe("先行者");
    expect(badgeLabelOf({ kind: "pioneer", serial: 0 })).toBe("先行者");
    expect(badgeLabelOf({ kind: "pioneer", serial: -3 })).toBe("先行者");
    expect(badgeLabelOf({ kind: "owner", serial: 5 })).toBe("主理人");
    expect(badgeDescriptionOf({ kind: "contributor", serial: null })).toBe(
      BADGE_DESCRIPTIONS.contributor
    );
  });
});
