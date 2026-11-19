// ==================== 排位赛季登记纯函数测试 ====================
// 边界口径：startsAt 含、endsAt 不含（开区间），开始前一毫秒与结束时刻都在窗外。
import { describe, expect, test } from "bun:test";
import {
  CEE_RANKED_SEASONS,
  currentCEERankedSeason,
  nextCEERankedSeason,
  type CEERankedSeason,
} from "../src/shared/CEERankedSeasons";

const seasonOf = (id: string): CEERankedSeason => {
  const found = CEE_RANKED_SEASONS.find((season) => season.id === id);
  if (!found) throw new Error(`登记里没有赛季 ${id}`);
  return found;
};

describe("S1 登记", () => {
  const s1 = seasonOf("S1");
  const start = Date.parse(s1.startsAt);
  const end = Date.parse(s1.endsAt);

  test("开始前一毫秒：没有当前赛季，下一个是 S1", () => {
    expect(currentCEERankedSeason(start - 1)).toBeNull();
    expect(nextCEERankedSeason(start - 1)).toBe(s1);
  });

  test("开始时刻：S1 进行中，没有下一个", () => {
    expect(currentCEERankedSeason(start)).toBe(s1);
    expect(nextCEERankedSeason(start)).toBeNull();
  });

  test("结束前一毫秒：S1 仍在进行", () => {
    expect(currentCEERankedSeason(end - 1)).toBe(s1);
    expect(nextCEERankedSeason(end - 1)).toBeNull();
  });

  test("结束时刻：S1 已过，也没有下一个", () => {
    expect(currentCEERankedSeason(end)).toBeNull();
    expect(nextCEERankedSeason(end)).toBeNull();
  });

  test("起止时刻都带北京时区偏移", () => {
    expect(s1.startsAt.endsWith("+08:00")).toBe(true);
    expect(s1.endsAt.endsWith("+08:00")).toBe(true);
  });
});

describe("多赛季列表", () => {
  const seasons: CEERankedSeason[] = [
    { id: "S1", startsAt: "2026-11-19T00:00:00+08:00", endsAt: "2026-12-01T00:00:00+08:00" },
    { id: "S2", startsAt: "2027-01-01T00:00:00+08:00", endsAt: "2027-02-01T00:00:00+08:00" },
  ];
  const at = (iso: string) => Date.parse(iso);

  test("赛季间隙：没有当前赛季，下一个是尚未开始的那个", () => {
    const gap = at("2026-12-15T12:00:00+08:00");
    expect(currentCEERankedSeason(gap, seasons)).toBeNull();
    expect(nextCEERankedSeason(gap, seasons)).toBe(seasons[1]);
  });

  test("S1 进行中就能看到 S2", () => {
    const during = at("2026-11-20T12:00:00+08:00");
    expect(currentCEERankedSeason(during, seasons)).toBe(seasons[0]);
    expect(nextCEERankedSeason(during, seasons)).toBe(seasons[1]);
  });

  test("最后一个赛季结束后两者都为 null", () => {
    const after = at("2027-02-01T00:00:00+08:00");
    expect(currentCEERankedSeason(after, seasons)).toBeNull();
    expect(nextCEERankedSeason(after, seasons)).toBeNull();
  });

  test("列表乱序时下一个仍取开始最早的", () => {
    const shuffled = [seasons[1], seasons[0]];
    expect(nextCEERankedSeason(at("2026-11-01T00:00:00+08:00"), shuffled)).toBe(seasons[0]);
  });

  test("空列表两者都为 null", () => {
    expect(currentCEERankedSeason(at("2026-12-01T00:00:00+08:00"), [])).toBeNull();
    expect(nextCEERankedSeason(at("2026-12-01T00:00:00+08:00"), [])).toBeNull();
  });
});
