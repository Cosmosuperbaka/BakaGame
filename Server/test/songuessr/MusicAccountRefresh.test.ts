import {
  MUSIC_POOL_COOLDOWN_MS,
  MUSIC_POOL_MAX_COOLDOWN_MS,
  MUSIC_POOL_MAX_IN_FLIGHT,
  MUSIC_POOL_QUEUE_TIMEOUT_MS,
  musicAuthOperationKey,
  roomRuntime,
} from "../../src/application/songuessr/Records";
import { AppError } from "../../src/domain/Errors";
import { MusicCookieInput, MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { describe, expect, test } from "bun:test";
import { TestConnection, connection, createRoom, execute, joinRoom, provider } from "./Fixtures";
import { createAggregatedProvider } from "../support/AggregatedProviders";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  beginMusicAuthentication,
  publishMusicSession,
  refreshMusicSessionAccount,
} from "../../src/application/songuessr/MusicAuth";
import {
  refreshDueMusicSessions,
  refreshMusicPoolEntry,
} from "../../src/application/songuessr/MusicSessionRefresh";
import {
  acquireMusicAccount,
  releaseMusicAccount,
  wakeMusicPoolWaiters,
} from "../../src/application/songuessr/MusicPool";

describe("SonGuessrService", () => {
  test("开局复核把 QQ 续期后的 Cookie 写回账号池并推给号主", async () => {
    let qqStatusCalls = 0;
    const qqSearchedCookies: Array<MusicCookieInput | undefined> = [];
    const neteaseMock: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { platform: "netease", nickname: "网易云用户", vipStatus: "vip" },
      }),
      search: async () => [],
    };
    const qqMock: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => {
        qqStatusCalls += 1;
        return {
          cookie: qqStatusCalls >= 2 ? "qm_keyst=refreshed" : cookie,
          account: {
            platform: "qq",
            userId: "qq-1",
            nickname: "QQ用户",
            vipStatus: "nonVip",
          },
        };
      },
      search: async (_keyword, _limit, cookie) => {
        qqSearchedCookies.push(cookie);
        return [];
      },
    };
    const aggregated = createAggregatedProvider({ netease: neteaseMock, qq: qqMock });
    const service = new SonGuessrService({ musicProvider: aggregated });
    const host = connection(service, "renew-host");
    const guest = connection(service, "renew-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "QQ 号主");
    await execute(service, guest, {
      id: "renew-qq",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "qm_keyst=old", platform: "qq" },
    });
    await execute(service, guest, {
      id: "renew-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "renew-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });

    const sessionEvent = guest.sent
      .filter((item) => item.type === "event" && item.event === "song.auth.session")
      .at(-1);
    expect(sessionEvent?.payload).toMatchObject({
      platform: "qq",
      cookie: "qm_keyst=refreshed",
    });

    await execute(service, host, {
      id: "renew-search",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "续期" },
    });
    expect(qqSearchedCookies).toContain("qm_keyst=refreshed");
    expect(qqSearchedCookies).not.toContain("qm_keyst=old");
  });

  test("后台巡检会主动续期 QQ 凭证并同步号主", async () => {
    let now = 1_000;
    let qqStatusCalls = 0;
    const qqSearchedCookies: Array<MusicCookieInput | undefined> = [];
    const neteaseMock: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { platform: "netease", nickname: "网易云用户", vipStatus: "vip" },
      }),
      search: async () => [],
    };
    const qqMock: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => {
        qqStatusCalls += 1;
        return {
          cookie: qqStatusCalls >= 2 ? "qm_keyst=swept" : cookie,
          account: {
            platform: "qq",
            userId: "qq-1",
            nickname: "QQ用户",
            vipStatus: "nonVip",
          },
        };
      },
      search: async (_keyword, _limit, cookie) => {
        qqSearchedCookies.push(cookie);
        return [];
      },
    };
    const aggregated = createAggregatedProvider({ netease: neteaseMock, qq: qqMock });
    const service = new SonGuessrService({
      musicProvider: aggregated,
      now: () => now,
      musicSessionRefreshIntervalMs: 1_000,
    });
    const host = connection(service, "sweep-host");
    const guest = connection(service, "sweep-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "QQ 号主");
    await execute(service, guest, {
      id: "sweep-qq",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "qm_keyst=old", platform: "qq" },
    });

    now += 2_000;
    await service.runHousekeeping();
    await sessionPushed(guest);

    const sessionEvent = guest.sent
      .filter((item) => item.type === "event" && item.event === "song.auth.session")
      .at(-1);
    expect(sessionEvent?.payload).toMatchObject({
      platform: "qq",
      cookie: "qm_keyst=swept",
    });

    await execute(service, host, {
      id: "sweep-search",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "巡检" },
    });
    expect(qqSearchedCookies).toContain("qm_keyst=swept");
  });

  test("后台续期间隔未到时，巡检不会向 QQ 上游重复发登录状态请求", async () => {
    const minute = 60_000;
    let now = 1_000;
    let qqStatusCalls = 0;
    const qqMock: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => {
        qqStatusCalls += 1;
        return {
          cookie,
          account: { platform: "qq", userId: "qq-1", nickname: "QQ用户", vipStatus: "nonVip" },
        };
      },
    };
    const service = new SonGuessrService({
      musicProvider: createAggregatedProvider({ netease: { search: async () => [] }, qq: qqMock }),
      now: () => now,
      // 续期间隔大于巡检扫描周期：扫描会跑，但没到期的号不该被续。
      musicSessionRefreshIntervalMs: 15 * minute,
    });
    const host = connection(service, "interval-host");
    await createRoom(service, host);
    await execute(service, host, {
      id: "interval-qq",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "qm_keyst=interval", platform: "qq" },
    });
    const sweep = async (advanceMs: number) => {
      now += advanceMs;
      // 房间闲置久了会被巡检回收：每一步先发一条聊天保持活跃。
      await execute(service, host, {
        id: `interval-chat-${now}`,
        type: "song.chat.send",
        roomId: "1234",
        payload: { text: "在线" },
      });
      await service.runHousekeeping();
      await new Promise((resolve) => setTimeout(resolve, 10));
    };
    const loginCalls = qqStatusCalls;

    await sweep(0);
    await sweep(11 * minute);
    expect(qqStatusCalls).toBe(loginCalls);

    // 距上次续期满 22 分钟、超过间隔：这一次才续。
    await sweep(11 * minute);
    expect(qqStatusCalls).toBe(loginCalls + 1);

    // 刚续完又到下一次扫描：间隔没到，不再续。
    await sweep(11 * minute);
    expect(qqStatusCalls).toBe(loginCalls + 1);
  });

  test("号主重传旧 Cookie 时不会被服务端已续期的新 Cookie 反向覆盖", async () => {
    let now = 1_000;
    let qqStatusCalls = 0;
    const neteaseMock: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { platform: "netease", nickname: "网易云用户", vipStatus: "vip" },
      }),
      search: async () => [],
    };
    const qqMock: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => {
        qqStatusCalls += 1;
        return {
          cookie: qqStatusCalls === 2 ? "qm_keyst=swept" : cookie,
          account: {
            platform: "qq",
            userId: "qq-1",
            nickname: "QQ用户",
            vipStatus: "nonVip",
          },
        };
      },
      search: async () => [],
    };
    const aggregated = createAggregatedProvider({ netease: neteaseMock, qq: qqMock });
    const service = new SonGuessrService({
      musicProvider: aggregated,
      now: () => now,
      musicSessionRefreshIntervalMs: 1_000,
    });
    const host = connection(service, "stale-host");
    const guest = connection(service, "stale-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "QQ 号主");
    await execute(service, guest, {
      id: "stale-qq",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "qm_keyst=old", platform: "qq" },
    });

    now += 2_000;
    await service.runHousekeeping();
    await sessionPushed(guest);

    // 客户端仍保存着旧副本，重新上传；上游校验仍可通过，但服务端应保留已续期的新 Cookie。
    const reupload = await execute<{ cookie: string }>(service, guest, {
      id: "stale-reupload",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "qm_keyst=old", platform: "qq" },
    });
    expect(reupload.cookie).toBe("qm_keyst=swept");
  });
});

test("续期凭据只回人类页面：同座位的 Agent 控制器连接收不到号主 Cookie", () => {
  const received: Record<string, unknown[]> = { human: [], agent: [], other: [] };
  const conn = (id: string, playerId: string, isAgent?: boolean) => ({
    id,
    playerId,
    isAgent,
    lobbySubscribed: false,
    send: (payload: unknown) => received[id]!.push(payload),
    close() {},
  });
  const service = {
    connections: {
      getRoomConnections: () => [
        conn("human", "p1"),
        conn("agent", "p1", true),
        conn("other", "p2"),
      ],
    },
  } as unknown as Parameters<typeof publishMusicSession>[0];
  publishMusicSession(
    service,
    { id: "1234" } as Parameters<typeof publishMusicSession>[1],
    {
      playerId: "p1",
      platform: "qq",
      cookie: "qm_keyst=secret",
      account: { platform: "qq", userId: "u", nickname: "号主", vipStatus: "nonVip" },
    } as Parameters<typeof publishMusicSession>[2]
  );
  expect(received.human).toHaveLength(1);
  expect(received.agent).toEqual([]);
  expect(received.other).toEqual([]);
});

describe("账号池凭据与开关的竞态边界", () => {
  const ownerService = () =>
    new SonGuessrService({
      musicProvider: {
        ...provider,
        getLoginStatus: async (cookie) => ({
          cookie,
          account: { userId: "u-1", nickname: "号主", vipStatus: "vip" },
        }),
      },
    });
  const hostEntry = async (service: SonGuessrService, host: TestConnection) => {
    await createRoom(service, host);
    const room = service.rooms.get("1234")!;
    return { room, entry: room.musicPool!.find((item) => item.platform === "netease")! };
  };

  test("凭据被判死后同账号在等待阶段重登，开关随新凭据恢复", async () => {
    const service = ownerService();
    const host = connection(service, "dead-host");
    const { room, entry } = await hostEntry(service, host);
    expect(entry.enabled).toBe(true);
    releaseMusicAccount(service.ctx, room.id, entry, {
      ok: false,
      code: "MUSIC_SESSION_INVALID",
      reason: "登录状态已失效",
    });
    expect(entry.enabled).toBe(false);

    // 关开关的是服务端不是号主：同一账号重登不能被当成「号主自己关的」而继续保持关闭。
    await execute(service, host, {
      id: "relogin",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=fresh" },
    });
    expect(entry.enabled).toBe(true);
  });

  test("续期等待期间号主重登，旧凭据的续期结果不覆盖新凭据", async () => {
    const service = ownerService();
    const host = connection(service, "renew-race-host");
    const { room, entry } = await hostEntry(service, host);
    let settle!: (
      session: Awaited<ReturnType<Parameters<typeof refreshMusicPoolEntry>[3]>>
    ) => void;
    const pending = refreshMusicPoolEntry(
      service.ctx,
      room,
      entry,
      () => new Promise((resolve) => (settle = resolve))
    );
    // 重登原地替换同一条目，条目仍在池里，只有凭据换了。
    entry.cookie = "MUSIC_U=relogin";
    settle({
      cookie: "MUSIC_U=renewed-old",
      account: { userId: "u-1", nickname: "号主", vipStatus: "vip" },
    });
    await pending;
    expect(entry.cookie).toBe("MUSIC_U=relogin");
  });

  test("开局前复核等待期间号主重登，旧凭据的复核结果不覆盖新凭据也不下发", async () => {
    const service = ownerService();
    const host = connection(service, "revalidate-race-host");
    const { room, entry } = await hostEntry(service, host);
    const refreshedAt = entry.cookieRefreshedAt;
    type Session = Awaited<ReturnType<MusicProvider["getLoginStatus"] & {}>>;
    let settle!: (session: Session) => void;
    const pending = refreshMusicSessionAccount(service.ctx, {
      room,
      platform: "netease",
      entry,
      label: "网易云",
      verifySession: () => undefined,
      getLoginStatus: () => new Promise<Session>((resolve) => (settle = resolve)),
    });
    // 重登原地替换同一条目：条目仍在池里，凭据与账号资料都是新的。
    const reloginAccount = { userId: "u-1", nickname: "重登后", vipStatus: "vip" as const };
    entry.cookie = "MUSIC_U=relogin";
    entry.account = { platform: "netease", ...reloginAccount };
    host.sent.length = 0;
    settle({
      cookie: "MUSIC_U=renewed-old",
      account: { userId: "u-1", nickname: "旧查询带回", vipStatus: "vip" },
    });
    await pending;
    expect(entry.cookie).toBe("MUSIC_U=relogin");
    expect(entry.account.nickname).toBe("重登后");
    expect(entry.cookieRefreshedAt).toBe(refreshedAt);
    expect(
      host.sent.some((item) => item.type === "event" && item.event === "song.auth.session")
    ).toBe(false);
  });

  describe("开局前复核的作废条件", () => {
    type Session = Awaited<ReturnType<NonNullable<MusicProvider["getLoginStatus"]>>>;
    /** 复核开始时在途令牌与本次复核一致，各用例再逐条改掉某一个条件。 */
    const revalidation = async (verifySession: () => void = () => undefined) => {
      const service = ownerService();
      const host = connection(service, "revalidate-host");
      const { room, entry } = await hostEntry(service, host);
      const operation = Symbol("op");
      (roomRuntime(room).musicAuthOperations ??= {})[
        musicAuthOperationKey(entry.playerId, "netease")
      ] = operation;
      let settle!: (session: Session) => void;
      let fail!: (error: unknown) => void;
      const pending = refreshMusicSessionAccount(service.ctx, {
        room,
        platform: "netease",
        entry,
        operation,
        label: "网易云",
        verifySession,
        getLoginStatus: () =>
          new Promise<Session>((resolve, reject) => {
            settle = resolve;
            fail = reject;
          }),
      });
      return { service, room, entry, pending, settle, fail };
    };
    const renewed: Session = {
      cookie: "MUSIC_U=renewed",
      account: { userId: "u-1", nickname: "续期后", vipStatus: "vip" },
    };
    const invalid = () => new AppError("MUSIC_SESSION_INVALID", "登录状态已失效");

    test("查询返回后会话校验失败，复核结果一律不写入", async () => {
      const stale = new AppError("INVALID_PHASE", "开局已作废");
      const { entry, pending, settle } = await revalidation(() => {
        throw stale;
      });
      const before = { cookie: entry.cookie, account: entry.account };
      settle(renewed);
      await expect(pending).rejects.toBe(stale);
      expect(entry.cookie).toBe(before.cookie);
      expect(entry.account).toBe(before.account);
    });

    test("凭据被判死且条目、凭据、登录令牌都没变时，才关开关并标记失效", async () => {
      const { entry, pending, fail } = await revalidation();
      fail(invalid());
      await expect(pending).rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });
      expect(entry.invalidated).toBe(true);
      expect(entry.enabled).toBe(false);
    });

    test("判死结果回来时条目已被摘出池，不再标记", async () => {
      const { room, entry, pending, fail } = await revalidation();
      room.musicPool = room.musicPool!.filter((item) => item !== entry);
      fail(invalid());
      await expect(pending).rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });
      expect(entry.invalidated).toBeUndefined();
      expect(entry.enabled).toBe(true);
    });

    test("判死结果回来时号主已重登换了凭据，不标记新凭据", async () => {
      const { entry, pending, fail } = await revalidation();
      entry.cookie = "MUSIC_U=relogin";
      fail(invalid());
      await expect(pending).rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });
      expect(entry.invalidated).toBeUndefined();
      expect(entry.enabled).toBe(true);
    });

    test("判死结果回来时登录令牌已被别的操作取代，不标记", async () => {
      const { room, entry, pending, fail } = await revalidation();
      const key = musicAuthOperationKey(entry.playerId, "netease");
      (roomRuntime(room).musicAuthOperations ??= {})[key] = Symbol("newer");
      fail(invalid());
      await expect(pending).rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });
      expect(entry.invalidated).toBeUndefined();
      expect(entry.enabled).toBe(true);
    });
  });

  describe("登录校验闭包的六条失效条件", () => {
    const begun = async () => {
      const service = ownerService();
      const host = connection(service, "verify-host");
      const { room } = await hostEntry(service, host);
      const player = room.players[host.record.playerId!]!;
      const verify = beginMusicAuthentication(service.ctx, room, player, host.record, "netease");
      return { service, host, room, player, verify };
    };

    test("什么都没变时校验通过", async () => {
      const { verify } = await begun();
      expect(verify).not.toThrow();
    });

    test("房间已不在房间表里", async () => {
      const { service, room, verify } = await begun();
      service.rooms.set(room.id, { ...room });
      expect(verify).toThrow(expect.objectContaining({ code: "MUSIC_SESSION_INVALID" }));
    });

    test("在途登录令牌被后一次登录取代", async () => {
      const { room, player, verify } = await begun();
      const key = musicAuthOperationKey(player.id, "netease");
      roomRuntime(room).musicAuthOperations![key] = Symbol("newer");
      expect(verify).toThrow(expect.objectContaining({ code: "MUSIC_SESSION_INVALID" }));
    });

    test("座位已被换成另一个玩家对象", async () => {
      const { room, player, verify } = await begun();
      room.players[player.id] = { ...player };
      expect(verify).toThrow(expect.objectContaining({ code: "MUSIC_SESSION_INVALID" }));
    });

    test("玩家已离线", async () => {
      const { player, verify } = await begun();
      player.online = false;
      expect(verify).toThrow(expect.objectContaining({ code: "MUSIC_SESSION_INVALID" }));
    });

    test("连接已不在这个房间", async () => {
      const { host, verify } = await begun();
      host.record.roomId = "9999";
      expect(verify).toThrow(expect.objectContaining({ code: "MUSIC_SESSION_INVALID" }));
    });

    test("连接已不是这个座位", async () => {
      const { host, verify } = await begun();
      host.record.playerId = "someone-else";
      expect(verify).toThrow(expect.objectContaining({ code: "MUSIC_SESSION_INVALID" }));
    });
  });

  describe("取号等待的边界", () => {
    const saturated = async () => {
      let now = 1_000;
      const service = new SonGuessrService({
        now: () => now,
        musicProvider: {
          ...provider,
          getLoginStatus: async (cookie) => ({
            cookie,
            account: { userId: "u-1", nickname: "号主", vipStatus: "vip" },
          }),
        },
      });
      const host = connection(service, "acquire-host");
      const { room, entry } = await hostEntry(service, host);
      entry.inFlight = MUSIC_POOL_MAX_IN_FLIGHT;
      return { service, room, entry, advance: (ms: number) => (now += ms) };
    };

    test("等号期间房间被关掉，被叫醒后返回无租约而不是继续租用", async () => {
      const { service, room, advance } = await saturated();
      const pending = acquireMusicAccount(service.ctx, room, "netease");
      service.rooms.delete(room.id);
      advance(MUSIC_POOL_QUEUE_TIMEOUT_MS + 1);
      wakeMusicPoolWaiters(service.ctx, room.id);
      expect(await pending).toBeUndefined();
    });

    test("等号超过排队时限后不降级，租用在途最少的可用号", async () => {
      const { service, room, entry, advance } = await saturated();
      const pending = acquireMusicAccount(service.ctx, room, "netease");
      advance(MUSIC_POOL_QUEUE_TIMEOUT_MS + 1);
      wakeMusicPoolWaiters(service.ctx, room.id);
      const lease = await pending;
      expect(lease?.cookie).toBe(entry.cookie);
      expect(entry.inFlight).toBe(MUSIC_POOL_MAX_IN_FLIGHT + 1);
    }, 1_000);
  });

  test("后台续期遍历到一半，后面的房间被关掉就不再续它", async () => {
    const calls: string[] = [];
    // 建房时的登录校验也走这个 provider，进入遍历之前不记录也不挂起。
    let armed = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const service = new SonGuessrService({
      musicSessionRefreshIntervalMs: 0,
      musicProvider: {
        ...provider,
        getLoginStatus: async (cookie) => {
          if (armed) calls.push(cookie);
          if (armed && calls.length === 1) await gate;
          return { cookie, account: { userId: "u-1", nickname: "号主", vipStatus: "vip" } };
        },
      },
    });
    const host = connection(service, "sweep-host");
    const { room } = await hostEntry(service, host);
    const qqEntry = (cookie: string) => ({
      playerId: "p-qq",
      platform: "qq" as const,
      cookie,
      account: {
        platform: "qq" as const,
        userId: "u-qq",
        nickname: "QQ",
        vipStatus: "vip" as const,
      },
      enabled: true,
      addedAt: 0,
      inFlight: 0,
      recentOk: 0,
      recentTotal: 0,
    });
    room.musicPool = [qqEntry("qm=first")];
    service.rooms.set("5678", { ...room, id: "5678", musicPool: [qqEntry("qm=second")] });
    armed = true;
    const sweep = refreshDueMusicSessions(service.ctx);
    // 第一间房的续期挂起期间，第二间房被关掉。
    service.rooms.delete("5678");
    release();
    await sweep;
    expect(calls).toEqual(["qm=first"]);
  });

  test("续期等待期间条目被摘出池，旧凭据的续期结果不写回", async () => {
    const service = ownerService();
    const host = connection(service, "renew-removed-host");
    const { room, entry } = await hostEntry(service, host);
    let settle!: (
      session: Awaited<ReturnType<Parameters<typeof refreshMusicPoolEntry>[3]>>
    ) => void;
    const pending = refreshMusicPoolEntry(
      service.ctx,
      room,
      entry,
      () => new Promise((resolve) => (settle = resolve))
    );
    const before = entry.cookie;
    room.musicPool = room.musicPool!.filter((item) => item !== entry);
    settle({
      cookie: "MUSIC_U=renewed-after-removal",
      account: { userId: "u-1", nickname: "号主", vipStatus: "vip" },
    });
    await pending;
    expect(entry.cookie).toBe(before);
  });

  test("续期失败回来时号主已重登，旧凭据的失败不判死新凭据", async () => {
    const service = ownerService();
    const host = connection(service, "renew-fail-host");
    const { room, entry } = await hostEntry(service, host);
    let fail!: (error: unknown) => void;
    const pending = refreshMusicPoolEntry(
      service.ctx,
      room,
      entry,
      () => new Promise((_resolve, reject) => (fail = reject))
    );
    entry.cookie = "MUSIC_U=relogin";
    fail(new AppError("MUSIC_SESSION_INVALID", "登录状态已失效"));
    await pending;
    expect(entry.invalidated).toBeUndefined();
    expect(entry.enabled).toBe(true);
    expect(entry.cookie).toBe("MUSIC_U=relogin");
  });

  test("自动开局加载期间阶段仍是 waiting，共享开关同样锁死", async () => {
    const service = ownerService();
    const host = connection(service, "loading-host");
    const { room } = await hostEntry(service, host);
    room.runtime = { automaticRoundLoading: true };
    await expect(
      execute(service, host, {
        id: "toggle-while-loading",
        type: "song.auth.setPoolSharing",
        roomId: "1234",
        payload: { platform: "netease", enabled: false },
      })
    ).rejects.toMatchObject({ code: "INVALID_PHASE" });
  });

  test("连续限流的账号冷却逐次拉长，成功一次即回到基础冷却", async () => {
    let now = 0;
    const service = new SonGuessrService({
      now: () => now,
      musicProvider: {
        ...provider,
        getLoginStatus: async (cookie) => ({
          cookie,
          account: { userId: "u-1", nickname: "号主", vipStatus: "vip" },
        }),
      },
    });
    const host = connection(service, "cooldown-host");
    const { room, entry } = await hostEntry(service, host);
    const rateLimited = () =>
      releaseMusicAccount(service.ctx, room.id, entry, {
        ok: false,
        code: "MUSIC_API_RATE_LIMITED",
        reason: "操作频繁，请稍候再试",
      });

    rateLimited();
    expect(entry.cooldownUntil).toBe(now + MUSIC_POOL_COOLDOWN_MS);
    now += MUSIC_POOL_COOLDOWN_MS + 1;
    rateLimited();
    expect(entry.cooldownUntil).toBe(now + MUSIC_POOL_COOLDOWN_MS * 2);
    now += MUSIC_POOL_COOLDOWN_MS * 2 + 1;
    rateLimited();
    expect(entry.cooldownUntil).toBe(now + MUSIC_POOL_COOLDOWN_MS * 4);
    now += MUSIC_POOL_COOLDOWN_MS * 4 + 1;
    rateLimited();
    expect(entry.cooldownUntil).toBe(now + MUSIC_POOL_MAX_COOLDOWN_MS);

    // 成功取歌说明额度已恢复：下一次再被限流从基础档重新计。
    releaseMusicAccount(service.ctx, room.id, entry, { ok: true });
    expect(entry.rateLimitStrikes).toBeUndefined();
    now += 1;
    rateLimited();
    expect(entry.cooldownUntil).toBe(now + MUSIC_POOL_COOLDOWN_MS);
  });
});

/** 后台续期是 fire-and-forget：有界轮询号主是否收到新凭据，而不是睡一个猜出来的时长。 */
async function sessionPushed(owner: TestConnection): Promise<void> {
  for (let tick = 0; tick < 200; tick += 1) {
    if (owner.sent.some((item) => item.type === "event" && item.event === "song.auth.session"))
      return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("后台续期没有把新凭据推给号主");
}
