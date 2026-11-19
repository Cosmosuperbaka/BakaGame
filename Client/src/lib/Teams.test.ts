import { describe, expect, it } from "vitest";
import { SONG_TEAM_BOUNDS } from "@bakagame/shared/values";
import { TEAM_OPTIONS, teamKey, teamLabel } from "./Teams";

describe("TEAM_OPTIONS", () => {
  it("格数比队伍上限多一：个人游玩占首格", () => {
    expect(TEAM_OPTIONS).toHaveLength(SONG_TEAM_BOUNDS.max + 1);
  });

  it("个人游玩排在首格，队伍号 1–8 升序，顺序与取值不变", () => {
    expect(TEAM_OPTIONS).toEqual([null, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("个人游玩与各队的键和文案不变", () => {
    expect(teamKey(null)).toBe("solo");
    expect(teamLabel(null)).toBe("个人");
    expect(teamKey(1)).toBe("1");
    expect(teamLabel(1)).toBe("1 队");
    expect(teamKey(8)).toBe("8");
    expect(teamLabel(8)).toBe("8 队");
  });
});
