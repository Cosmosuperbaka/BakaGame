import { describe, expect, test } from "bun:test";
import { prioritizeCandidatesByRoomAccounts } from "../../src/application/songuessr/MusicAccounts";

const fakeService = { now: () => 1_000 } as never;
const roomWith = (...platforms: Array<"qq" | "netease">) =>
  ({
    musicPool: platforms.map((platform) => ({
      platform,
      enabled: true,
      cooldownUntil: undefined,
      account: { vipStatus: "nonVip" },
    })),
  }) as never;

describe("候选音源按房内账号排序", () => {
  const ids = ["netease:1", "qq:abc", "netease:2"];

  test("只有 QQ 账号的房间先走 QQ 候选，匿名网易云只做兜底，避免先撞匿名限流线", () => {
    expect(prioritizeCandidatesByRoomAccounts(fakeService, roomWith("qq"), ids)).toEqual([
      "qq:abc",
      "netease:1",
      "netease:2",
    ]);
  });

  test("只有网易云账号或两边都有账号时保持原顺序", () => {
    expect(prioritizeCandidatesByRoomAccounts(fakeService, roomWith("netease"), ids)).toEqual([
      "netease:1",
      "netease:2",
      "qq:abc",
    ]);
    expect(prioritizeCandidatesByRoomAccounts(fakeService, roomWith("qq", "netease"), ids)).toEqual(
      ids
    );
  });

  test("没有任何账号时不重排，冷却中的账号不算可用", () => {
    expect(prioritizeCandidatesByRoomAccounts(fakeService, roomWith(), ids)).toEqual(ids);
    const room = roomWith("qq") as unknown as { musicPool: Array<{ cooldownUntil?: number }> };
    room.musicPool[0]!.cooldownUntil = 99_999;
    expect(prioritizeCandidatesByRoomAccounts(fakeService, room as never, ids)).toEqual(ids);
  });
});
