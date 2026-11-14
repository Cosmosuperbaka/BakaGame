import { MUSIC_POOL_COOLDOWN_MS } from "../../src/application/songuessr/Records";
import { AppError } from "../../src/domain/Errors";
import { MusicCookieInput, MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { describe, expect, test } from "bun:test";
import {
  audioTicketOf,
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  makeSong,
  provider,
  songs,
  startRound,
} from "./Fixtures";
import { createAggregatedProvider } from "../support/AggregatedProviders";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  SongDetails,
  SongSearchResult,
  type SonGuessrPrivateState,
  type SonGuessrRoomSnapshot,
} from "../../src/shared/Index";
import { PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS } from "../../src/config/Constants";

describe("SonGuessrService", () => {
  test("账号池凭据只存在房间内存、供全房请求使用，号主离房即摘除", async () => {
    const usedCookies: Array<MusicCookieInput | undefined> = [];
    const authProvider: MusicProvider = {
      ...provider,
      search: async (_keyword, _limit, cookie) => {
        usedCookies.push(cookie);
        return [];
      },
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { userId: "pool-account", nickname: "池内账号" },
      }),
    };
    const service = new SonGuessrService({ musicProvider: authProvider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "玩家");

    // 任何在房玩家都能贡献自己的号：不再是房主独占的房间会话。
    const login = (await execute(service, guest, {
      id: "guest-loads-cookie",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=guest-cookie" },
    })) as {
      cookie: string;
      account: { userId?: string; nickname: string; avatarUrl?: string };
    };
    expect(login).toHaveProperty("account");
    const readySnapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(readySnapshot.musicAccountReady).toBe(true);
    expect(readySnapshot.musicPool?.map((entry) => entry.playerId)).toEqual([
      hostState.playerId,
      guestState.playerId,
    ]);
    // 凭据只留在服务端内存：房主拿到的快照里不带别人（也不带自己）的 cookie。
    expect(JSON.stringify(readySnapshot)).not.toContain("MUSIC_U=guest-cookie");
    expect(JSON.stringify(readySnapshot)).not.toContain("MUSIC_U=test-host");
    expect(JSON.stringify(host.sent)).not.toContain("MUSIC_U=guest-cookie");

    // 同档按加入先后取号：房主的号先进池，检索取的是房主那条凭据。
    await execute(service, guest, {
      id: "search-with-pool-cookie",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "测试" },
    });
    expect(usedCookies.at(-1)).toEqual({ netease: "MUSIC_U=test-host" });

    await execute(service, guest, {
      id: "owner-leaves",
      type: "song.room.leave",
      roomId: "1234",
      payload: {},
    });
    const afterLeave = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(afterLeave.hostPlayerId).toBe(hostState.playerId);
    // 贡献者离房，他的号立即移出；房主自己的号不受影响。
    expect(afterLeave.musicPool?.map((entry) => entry.playerId)).toEqual([hostState.playerId]);
    expect(afterLeave.musicAccountReady).toBe(true);
    expect(JSON.stringify(afterLeave)).not.toContain("MUSIC_U=guest-cookie");

    await execute(service, host, {
      id: "search-after-owner-left",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "测试" },
    });
    expect(usedCookies.at(-1)).toEqual({ netease: "MUSIC_U=test-host" });
  });

  test("关掉共享开关后本房不再取用该号，已在途的请求照旧跑完", async () => {
    let releaseSearch: (() => void) | undefined;
    let gateNextSearch = true;
    const usedCookies: Array<MusicCookieInput | undefined> = [];
    const gateProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie, platform) => ({
        cookie,
        account: {
          platform: platform === "qq" ? "qq" : "netease",
          nickname: "共享账号",
          vipStatus: "vip",
        },
      }),
      search: async (_keyword, _limit, cookie) => {
        usedCookies.push(cookie);
        // 只卡住第一次检索：让它在「关开关」发生的那一刻还在途。
        if (gateNextSearch) {
          gateNextSearch = false;
          await new Promise<void>((resolve) => {
            releaseSearch = resolve;
          });
        }
        return [songs.answer];
      },
    };
    const service = new SonGuessrService({ musicProvider: gateProvider });
    const host = connection(service, "share-host");
    const guest = connection(service, "share-guest");
    await createRoom(service, host);
    const guestState = await joinRoom(service, guest, "贡献者");
    // 房主先关掉自己的共享：池里只剩贡献者的号，便于确认在途请求记在谁身上。
    await execute(service, host, {
      id: "host-off",
      type: "song.auth.setPoolSharing",
      roomId: "1234",
      payload: { platform: "netease", enabled: false },
    });
    await execute(service, guest, {
      id: "guest-loads",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=guest-cookie" },
    });

    const inflight = execute(service, host, {
      id: "search-inflight",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "在途" },
    });
    for (let attempt = 0; attempt < 200 && !releaseSearch; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(releaseSearch).toBeDefined();
    expect(usedCookies.at(-1)).toEqual({ netease: "MUSIC_U=guest-cookie" });

    // 上游还没回来时关掉开关：租约不收回，快照里能看到这一号的在途数。
    await execute(service, guest, {
      id: "guest-off",
      type: "song.auth.setPoolSharing",
      roomId: "1234",
      payload: { platform: "netease", enabled: false },
    });
    const paused = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(paused.musicPool?.find((entry) => entry.playerId === guestState.playerId)).toMatchObject(
      { enabled: false, inFlight: 1, recentTotal: 0 }
    );

    releaseSearch!();
    const settled = await inflight;
    expect((settled as { results: SongDetails[] }).results.map((song) => song.id)).toEqual([
      "answer",
    ]);

    // 关掉之后本房不再取用该号：两端都没有可取号，检索按「无号」发出。
    await execute(service, host, {
      id: "search-after-off",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "关掉之后" },
    });
    expect(usedCookies.at(-1)).toBeUndefined();
  });

  test("开局后共享开关锁死：改开关被拒，局中登录的号也不默认入池", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "lock-host");
    const guest = connection(service, "lock-guest");
    await createRoom(service, host);
    const hostSeat = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "同房玩家");
    await execute(service, guest, {
      id: "guest-loads",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=guest-cookie" },
    });
    await startRound(service, host, guest, hostSeat.playerId);

    await expect(
      execute(service, guest, {
        id: "toggle-while-playing",
        type: "song.auth.setPoolSharing",
        roomId: "1234",
        payload: { platform: "netease", enabled: false },
      })
    ).rejects.toMatchObject({ code: "INVALID_PHASE" });

    // 局中重新装载凭据同样不开开关：否则「等待阶段才可改」能被一条登录绕过去。
    await execute(service, guest, {
      id: "guest-reloads",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=guest-cookie-2" },
    });
    const midGame = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(
      midGame.musicPool?.find((entry) => entry.playerId === guestState.playerId)
    ).toMatchObject({ enabled: false });
    expect(midGame.musicPool?.find((entry) => entry.playerId === hostSeat.playerId)).toMatchObject({
      enabled: true,
    });
    expect(midGame.musicAccountReady).toBe(true);
  });

  test("贡献者掉线宽限内号仍在池里，超期后连号一起清出房间", async () => {
    let now = 0;
    const usedCookies: Array<MusicCookieInput | undefined> = [];
    const service = new SonGuessrService({
      musicProvider: {
        ...provider,
        search: async (_keyword, _limit, cookie) => {
          usedCookies.push(cookie);
          return [];
        },
      },
      now: () => now,
    });
    const host = connection(service, "offline-host");
    const guest = connection(service, "offline-guest");
    await createRoom(service, host);
    const hostSeat = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "掉线玩家");
    // 同样先关掉房主的号，池里只剩掉线玩家的号，检索取到谁就说明谁的号还可用。
    await execute(service, host, {
      id: "host-off",
      type: "song.auth.setPoolSharing",
      roomId: "1234",
      payload: { platform: "netease", enabled: false },
    });
    await execute(service, guest, {
      id: "guest-loads",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=guest-cookie" },
    });

    await service.unregisterConnection(guest.record.id);
    const withinGrace = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(withinGrace.musicPool?.map((entry) => entry.playerId)).toEqual([
      hostSeat.playerId,
      guestState.playerId,
    ]);
    await execute(service, host, {
      id: "search-within-grace",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "宽限内" },
    });
    expect(usedCookies.at(-1)).toEqual({ netease: "MUSIC_U=guest-cookie" });

    now += PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS + 1;
    await service.runHousekeeping();
    const expired = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(expired.players.map((player) => player.name)).not.toContain("掉线玩家");
    expect(expired.musicPool?.map((entry) => entry.playerId)).toEqual([hostSeat.playerId]);
    // 号也一起没了，池子空到两端都取不到号。
    await execute(service, host, {
      id: "search-after-expire",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "超期后" },
    });
    expect(usedCookies.at(-1)).toBeUndefined();
  });

  test("风控失败立即摘下该号并冷却，冷却期内不取号、到点自动恢复", async () => {
    let now = 0;
    const usedCookies: Array<MusicCookieInput | undefined> = [];
    const service = new SonGuessrService({
      musicProvider: {
        ...provider,
        search: async (_keyword, _limit, cookie) => {
          usedCookies.push(cookie);
          return [];
        },
        getSong: async () => {
          throw new AppError("MUSIC_LOGIN_RISK", "音乐账号存在安全风险，请稍后再试");
        },
      },
      now: () => now,
    });
    const host = connection(service, "risk-host");
    const guest = connection(service, "risk-guest");
    await createRoom(service, host);
    const hostSeat = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "同房玩家");

    await expect(startRound(service, host, guest, hostSeat.playerId)).rejects.toMatchObject({
      code: "MUSIC_LOGIN_RISK",
    });

    await execute(service, host, {
      id: "sync",
      type: "song.room.requestSync",
      roomId: "1234",
      payload: {},
    });
    const failed = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(failed.musicPool?.find((entry) => entry.playerId === hostSeat.playerId)).toMatchObject({
      inFlight: 0,
      recentOk: 0,
      recentTotal: 1,
      cooldownUntil: MUSIC_POOL_COOLDOWN_MS,
    });
    expect(
      failed.musicPool?.find((entry) => entry.playerId === hostSeat.playerId)?.lastFailureReason
    ).toContain("安全风险");

    // 冷却期内不再取这个号：池里只剩它，于是检索按「无号」发出。
    await execute(service, host, {
      id: "search-during-cooldown",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "冷却中" },
    });
    expect(usedCookies.at(-1)).toBeUndefined();

    // 风控是上游暂时的态度：冷却到点自动恢复，不擅自关掉号主的开关。
    now += MUSIC_POOL_COOLDOWN_MS + 1;
    await execute(service, host, {
      id: "search-after-cooldown",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "冷却之后" },
    });
    expect(usedCookies.at(-1)).toEqual({ netease: "MUSIC_U=test-host" });
    await execute(service, host, {
      id: "sync-after-cooldown",
      type: "song.room.requestSync",
      roomId: "1234",
      payload: {},
    });
    const recovered = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(
      recovered.musicPool?.find((entry) => entry.playerId === hostSeat.playerId)
    ).toMatchObject({ enabled: true, recentOk: 1, recentTotal: 2 });
    expect(
      recovered.musicPool?.find((entry) => entry.playerId === hostSeat.playerId)?.cooldownUntil
    ).toBeUndefined();
  });

  test("凭据被判死时该号退出取号并冷却，号主重登清掉冷却与失败原因", async () => {
    let now = 0;
    const service = new SonGuessrService({
      musicProvider: {
        ...provider,
        getSong: async () => {
          throw new AppError("MUSIC_SESSION_INVALID", "网易云登录状态已失效，请重新扫码登录");
        },
      },
      now: () => now,
    });
    const host = connection(service, "invalid-host");
    const guest = connection(service, "invalid-guest");
    await createRoom(service, host);
    const hostSeat = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "同房玩家");
    await execute(service, guest, {
      id: "guest-loads",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=guest-cookie" },
    });

    await expect(startRound(service, host, guest, hostSeat.playerId)).rejects.toMatchObject({
      code: "MUSIC_SESSION_INVALID",
    });

    await execute(service, host, {
      id: "sync",
      type: "song.room.requestSync",
      roomId: "1234",
      payload: {},
    });
    const invalidated = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(
      invalidated.musicPool?.find((entry) => entry.playerId === hostSeat.playerId)
    ).toMatchObject({ enabled: false, cooldownUntil: MUSIC_POOL_COOLDOWN_MS });

    // 判死的凭据冷却到点也不会自己活过来：只有号主重登才清冷却并恢复开关。
    now += MUSIC_POOL_COOLDOWN_MS + 1;
    await execute(service, host, {
      id: "sync-after-cooldown",
      type: "song.room.requestSync",
      roomId: "1234",
      payload: {},
    });
    expect(
      lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").musicPool?.find(
        (entry) => entry.playerId === hostSeat.playerId
      )
    ).toMatchObject({ enabled: false });

    await execute(service, host, {
      id: "reload",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=test-host-fresh" },
    });
    const relogged = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    const hostEntry = relogged.musicPool?.find((entry) => entry.playerId === hostSeat.playerId);
    expect(hostEntry).toMatchObject({ enabled: false });
    expect(hostEntry?.cooldownUntil).toBeUndefined();
    expect(hostEntry?.lastFailureReason).toBeUndefined();
    expect(relogged.musicAccountReady).toBe(true);
    expect(hostEntry?.account.nickname).toBe("测试账号");
    expect(guestState.playerId).toBeDefined();
  });

  test("池内没有 QQ 账号时以匿名音源补充检索，加入 QQ 号后改用账号", async () => {
    let qqSearchCalls = 0;
    const qqCookies: (MusicCookieInput | undefined)[] = [];
    const neteaseMock: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { platform: "netease", nickname: "网易云用户", vipStatus: "vip" },
      }),
      search: async () => [songs.answer],
    };
    const qqMock: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { platform: "qq", nickname: "QQ用户", vipStatus: "nonVip" },
      }),
      search: async (_keyword, _limit, cookie) => {
        qqSearchCalls += 1;
        qqCookies.push(cookie);
        return [{ ...songs.wrong, id: "qq:2001" }];
      },
    };
    const aggregated = createAggregatedProvider({ netease: neteaseMock, qq: qqMock });
    const service = new SonGuessrService({ musicProvider: aggregated });
    const host = connection(service, "degrade-host");
    const guest = connection(service, "degrade-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "QQ 号主");

    const withoutQq = await execute<{ results: SongSearchResult[] }>(service, host, {
      id: "search-without-qq",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "降级" },
    });
    expect(qqSearchCalls).toBe(1);
    expect(qqCookies[0]).toBeUndefined();
    expect(withoutQq.results.some((song) => song.id.startsWith("qq:"))).toBe(true);

    await execute(service, guest, {
      id: "guest-qq",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "qm_keyst=qq-cookie", platform: "qq" },
    });
    const withQq = await execute<{ results: SongSearchResult[] }>(service, host, {
      id: "search-with-qq",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "降级" },
    });
    expect(qqSearchCalls).toBe(2);
    expect(qqCookies[1]).toBe("qm_keyst=qq-cookie");
    expect(withQq.results.some((song) => song.id.startsWith("qq:"))).toBe(true);
  });

  test("QQ-only 房间的共有曲目由 QQ 代表", async () => {
    const neteaseMock: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { platform: "netease", nickname: "网易云用户", vipStatus: "vip" },
      }),
      search: async () => [songs.answer],
    };
    const qqMock: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { platform: "qq", nickname: "QQ用户", vipStatus: "nonVip" },
      }),
      search: async () => [{ ...songs.answer, id: "qq:2001" }],
    };
    const aggregated = createAggregatedProvider({ netease: neteaseMock, qq: qqMock });
    const service = new SonGuessrService({ musicProvider: aggregated });
    const host = connection(service, "qq-only-host");
    const guest = connection(service, "qq-only-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "QQ 号主");
    // createRoom 默认给房主挂网易云号；这里清掉，构造真正的 QQ-only 房间。
    await execute(service, host, {
      id: "clear-netease",
      type: "song.auth.clear",
      roomId: "1234",
      payload: { platform: "netease" },
    });
    await execute(service, guest, {
      id: "qq-only-cookie",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "qm_keyst=qq-cookie", platform: "qq" },
    });

    const result = await execute<{ results: SongSearchResult[] }>(service, host, {
      id: "qq-only-search",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "共有曲目" },
    });
    expect(result.results[0]?.id.startsWith("qq:")).toBe(true);
  });

  test("池视图带归属昵称、会员档、在途数与近期成功率，且不含任何凭据", async () => {
    const usedCookies: Array<MusicCookieInput | undefined> = [];
    const service = new SonGuessrService({
      musicProvider: {
        ...provider,
        getLoginStatus: async (cookie, platform) => ({
          cookie,
          account: {
            platform: platform === "qq" ? "qq" : "netease",
            nickname: platform === "qq" ? "QQ用户" : "网易云用户",
            vipStatus: platform === "qq" ? "nonVip" : "vip",
          },
        }),
        search: async (_keyword, _limit, cookie) => {
          usedCookies.push(cookie);
          return [];
        },
      },
    });
    const host = connection(service, "view-host");
    const guest = connection(service, "view-guest");
    await createRoom(service, host);
    const hostSeat = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "贡献者");
    await execute(service, guest, {
      id: "guest-loads",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=guest-cookie" },
    });

    // 池是全房可见的：贡献者拿到的快照与房主同一份，非房主靠它渲染自己的开关。
    const guestView = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").musicPool ?? [];
    expect(guestView.map((entry) => entry.playerId)).toEqual([
      hostSeat.playerId,
      guestState.playerId,
    ]);
    expect(guestView.find((entry) => entry.playerId === hostSeat.playerId)).toMatchObject({
      playerName: "房主",
      platform: "netease",
      enabled: true,
      inFlight: 0,
      recentOk: 0,
      recentTotal: 0,
    });

    await execute(service, host, {
      id: "search",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "视图" },
    });
    await execute(service, host, {
      id: "sync",
      type: "song.room.requestSync",
      roomId: "1234",
      payload: {},
    });

    const view = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").musicPool ?? [];
    // 取号成功后统计跟着走：房主据此看出哪个号在跑、跑得顺不顺。
    expect(view.find((entry) => entry.playerId === hostSeat.playerId)).toMatchObject({
      enabled: true,
      inFlight: 0,
      recentOk: 1,
      recentTotal: 1,
    });
    // 会员档按贡献者各自的号展示，房主据此判断会员曲目能不能取到直链。
    expect(view.find((entry) => entry.playerId === hostSeat.playerId)?.account.vipStatus).toBe(
      "vip"
    );
    expect(view.find((entry) => entry.playerId === guestState.playerId)?.account.vipStatus).toBe(
      "vip"
    );
    expect(JSON.stringify(view)).not.toContain("guest-cookie");
    expect(JSON.stringify(view)).not.toContain("test-host");
  });

  test("QQ 会员曲目取会员号：非会员号先进池也不选它", async () => {
    const submittedCookies: Array<MusicCookieInput | undefined> = [];
    const refreshCookies: Array<MusicCookieInput | undefined> = [];
    const vipSong = { ...makeSong("qq:9001", "会员曲", 2020), requiresVip: true };
    const service = new SonGuessrService({
      musicProvider: {
        ...provider,
        getLoginStatus: async (cookie, platform) => ({
          cookie,
          account: {
            platform: platform === "qq" ? "qq" : "netease",
            nickname: cookie.includes("vip") ? "QQ会员" : "QQ非会员",
            vipStatus: cookie.includes("vip") ? "vip" : "nonVip",
          },
        }),
        getSong: async (id, cookie) => {
          submittedCookies.push(cookie);
          return { ...vipSong, id };
        },
        refreshSongAudio: async (_id, cookie) => {
          refreshCookies.push(cookie);
          return "https://audio/refreshed.mp3";
        },
      },
    });
    const host = connection(service, "vip-host");
    const freeGuest = connection(service, "vip-free");
    const vipGuest = connection(service, "vip-paid");
    await createRoom(service, host);
    const hostSeat = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, freeGuest, "非会员");
    await joinRoom(service, vipGuest, "会员");
    // 非会员号先入池：只按加入时间取号就会挑到它，按会员档才挑得到会员号。
    await execute(service, freeGuest, {
      id: "free-loads",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "qm_keyst=qq-free", platform: "qq" },
    });
    await execute(service, vipGuest, {
      id: "vip-loads",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "qm_keyst=qq-vip", platform: "qq" },
    });
    await execute(service, vipGuest, {
      id: "ready-vip",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await startRound(service, host, freeGuest, hostSeat.playerId, "qq:9001");

    await execute(service, vipGuest, {
      id: "audio-failed",
      type: "song.game.audioFailed",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    expect(refreshCookies.at(-1)).toBe("qm_keyst=qq-vip");
    expect(submittedCookies).not.toContain("qm_keyst=qq-free");
    expect(
      service.resolveAudioRedirect(
        "1234",
        audioTicketOf(lastEvent<SonGuessrRoomSnapshot>(vipGuest, "song.room.snapshot"))
      )
    ).toBe("https://audio/refreshed.mp3");
  });

  test("非会员提交会员专享歌曲时按实际音频放行", async () => {
    const nonVipProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { nickname: "普通账号", vipStatus: "nonVip" },
      }),
      // getSong 已把会员曲交给解灰链路取回完整音频，`requiresVip` 不再参与出题判定。
      getSong: async (id) => ({ ...songs[id as keyof typeof songs], requiresVip: true }),
    };
    const service = new SonGuessrService({ musicProvider: nonVipProvider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "玩家");
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const submitted = await startRound(service, host, guest, hostState.playerId);
    expect(submitted).toMatchObject({ roundNumber: 1 });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
  });

  test("账号取歌被限流时，同一请求改用匿名出口再试一次而不是整轮失败", async () => {
    const cookies: Array<MusicCookieInput | undefined> = [];
    const rateLimitedProvider: MusicProvider = {
      ...provider,
      getSong: async (_id, cookie) => {
        cookies.push(cookie);
        // 账号出口打满：上游只认这条出口的配额，匿名出口仍取得到歌。
        if (cookie) throw new AppError("MUSIC_API_RATE_LIMITED", "操作频繁，请稍候再试");
        return songs.answer;
      },
    };
    const service = new SonGuessrService({ musicProvider: rateLimitedProvider });
    const host = connection(service, "rate-submit-host");
    const guest = connection(service, "rate-submit-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);

    // 第一次用池内账号，被限流归还后池子已把它冷却，重试落到匿名出口。
    expect(cookies).toEqual(["MUSIC_U=test-host", undefined]);
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
  });

  test("检索取号被限流时，同一请求改用匿名出口再试一次", async () => {
    const cookies: Array<MusicCookieInput | undefined> = [];
    const rateLimitedProvider: MusicProvider = {
      ...provider,
      search: async (_keyword, _limit, cookie) => {
        cookies.push(cookie);
        if (cookie) throw new AppError("MUSIC_API_RATE_LIMITED", "操作频繁，请稍候再试");
        return [songs.answer];
      },
    };
    const service = new SonGuessrService({ musicProvider: rateLimitedProvider });
    const host = connection(service, "rate-search-host");
    await createRoom(service, host);

    const result = await execute<{ results: SongSearchResult[] }>(service, host, {
      id: "search",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "答案" },
    });

    expect(result.results).toHaveLength(1);
    expect(cookies).toEqual([{ netease: "MUSIC_U=test-host" }, undefined]);
  });
});
