import { describe, expect, test } from "bun:test";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import type { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import type { SonGuessrPrivateState, SonGuessrRoomSnapshot } from "../../src/shared/Index";
import { connection, createRoom, execute, joinRoom, lastEvent, provider } from "./Fixtures";

/** 两位号主各自的第三方账号资料：userId、会员到期时刻、会员类型都是能关联到真实账号的字段。 */
const HOST_ACCOUNT = {
  platform: "netease" as const,
  userId: "73001122",
  nickname: "房主的网易云",
  avatarUrl: "https://img.example.net/host.jpg",
  vipStatus: "vip" as const,
  vipType: 11,
  vipExpireTime: 1_893_456_000_123,
  vipTier: "svip" as const,
  vipLevel: 5,
};
const GUEST_ACCOUNT = {
  platform: "qq" as const,
  userId: "88002233",
  nickname: "听众的QQ音乐",
  avatarUrl: "https://img.example.net/guest.jpg",
  vipStatus: "vip" as const,
  vipType: 7,
  vipExpireTime: 1_900_000_000_456,
  vipTier: "vip" as const,
  vipLevel: 3,
  vipYear: true,
};
/** 只能是这些字段：展示一个号的身份与档位所需，不含能查到真实账号的东西。 */
const PROJECTION_KEYS = [
  "avatarUrl",
  "nickname",
  "platform",
  "vipLevel",
  "vipStatus",
  "vipTier",
  "vipYear",
];

const setup = async () => {
  const musicProvider: MusicProvider = {
    ...provider,
    getLoginStatus: async (cookie) => {
      const text = JSON.stringify(cookie);
      return { cookie, account: text.includes("qq") ? GUEST_ACCOUNT : HOST_ACCOUNT };
    },
  };
  const service = new SonGuessrService({ musicProvider });
  const host = connection(service, "acct-host");
  const guest = connection(service, "acct-guest");
  const watcher = connection(service, "acct-watcher");
  await createRoom(service, host);
  await joinRoom(service, guest, "听众");
  await joinRoom(service, watcher, "路人");
  await execute(service, guest, {
    id: "guest-account",
    type: "song.auth.useCookie",
    roomId: "1234",
    payload: { cookie: "qq-cookie", platform: "qq" },
  });
  await execute(service, host, {
    id: "sync",
    type: "song.room.requestSync",
    roomId: "1234",
    payload: {},
  });
  await execute(service, watcher, {
    id: "sync-watcher",
    type: "song.room.requestSync",
    roomId: "1234",
    payload: {},
  });
  return { service, host, guest, watcher };
};

const privateOf = (client: ReturnType<typeof connection>) =>
  lastEvent<SonGuessrPrivateState>(client, "song.game.privateState");
const snapshotOf = (client: ReturnType<typeof connection>) =>
  lastEvent<SonGuessrRoomSnapshot>(client, "song.room.snapshot");

describe("猜歌音乐账号资料：本人完整、公开只留展示投影", () => {
  test("别的玩家收到的任何帧里都搜不到号主的第三方账号标识", async () => {
    const { watcher } = await setup();
    const wire = JSON.stringify(watcher.sent);
    // 路人能看到有哪些号、昵称与档位（账号池面板要展示），但不能拿到能关联到真实账号的字段。
    expect(wire).toContain("房主的网易云");
    expect(wire).toContain("听众的QQ音乐");
    for (const secret of [
      "73001122",
      "88002233",
      "1893456000123",
      "1900000000456",
      "vipExpireTime",
    ])
      expect(wire).not.toContain(secret);
  });

  test("公开快照的号池只留展示投影，且不再有房间级账号列表", async () => {
    const { watcher } = await setup();
    const snapshot = snapshotOf(watcher);
    expect(snapshot).not.toHaveProperty("musicAccounts");
    expect(snapshot.musicPool).toHaveLength(2);
    for (const entry of snapshot.musicPool ?? []) {
      expect(
        Object.keys(entry.account)
          .sort()
          .every((key) => PROJECTION_KEYS.includes(key))
      ).toBe(true);
    }
    const hostEntry = snapshot.musicPool?.find((entry) => entry.platform === "netease");
    expect(hostEntry?.account).toEqual({
      platform: "netease",
      nickname: "房主的网易云",
      avatarUrl: "https://img.example.net/host.jpg",
      vipStatus: "vip",
      vipTier: "svip",
      vipLevel: 5,
    });
  });

  test("本人资料只在本人的私有态里，别人的私有态里没有", async () => {
    const { host, guest, watcher } = await setup();
    expect(privateOf(host).musicAccounts).toEqual({ netease: HOST_ACCOUNT });
    expect(privateOf(guest).musicAccounts).toEqual({ qq: GUEST_ACCOUNT });
    expect(privateOf(watcher).musicAccounts ?? {}).toEqual({});
    expect(JSON.stringify(guest.sent)).not.toContain("73001122");
    expect(JSON.stringify(host.sent)).not.toContain("88002233");
  });

  test("清除登录后本人私有态里的资料同步消失", async () => {
    const { service, host } = await setup();
    await execute(service, host, {
      id: "clear",
      type: "song.auth.clear",
      roomId: "1234",
      payload: { platform: "netease" },
    });
    expect(privateOf(host).musicAccounts?.netease).toBeUndefined();
  });
});
