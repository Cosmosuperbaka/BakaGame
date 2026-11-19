import { beforeEach, describe, expect, it, vi } from "vitest";

const publicProfile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/Api", () => ({ api: { account: { publicProfile } } }));

import {
  clearProfileCacheForTest,
  invalidatePublicProfile,
  loadPublicProfile,
} from "./ProfileCache";

const profile = (userId: string) => ({ userId, nickname: `玩家${userId}` });

describe("资料卡缓存", () => {
  beforeEach(() => {
    clearProfileCacheForTest();
    publicProfile.mockReset();
  });

  it("同一用户只取一次，不同用户各自取", async () => {
    publicProfile.mockImplementation(async ({ userId }: { userId: string }) => profile(userId));

    const first = loadPublicProfile("1");
    expect(loadPublicProfile("1")).toBe(first);
    expect(loadPublicProfile("2")).not.toBe(first);
    await expect(first).resolves.toEqual(profile("1"));
    expect(publicProfile).toHaveBeenCalledTimes(2);
    expect(publicProfile).toHaveBeenCalledWith({ userId: "1" });
  });

  it("失败不缓存，下次打开重试", async () => {
    publicProfile.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(profile("1"));

    await expect(loadPublicProfile("1")).rejects.toThrow("offline");
    await expect(loadPublicProfile("1")).resolves.toEqual(profile("1"));
    expect(publicProfile).toHaveBeenCalledTimes(2);
  });

  it("本人改过资料后作废该用户，别人不受影响", async () => {
    publicProfile.mockImplementation(async ({ userId }: { userId: string }) => profile(userId));
    const mine = loadPublicProfile("1");
    const other = loadPublicProfile("2");
    await Promise.all([mine, other]);

    invalidatePublicProfile("1");
    expect(loadPublicProfile("1")).not.toBe(mine);
    expect(loadPublicProfile("2")).toBe(other);
  });
});
