import { describe, expect, test } from "bun:test";
import {
  makeSong,
  songs,
  provider,
  TestConnection,
  connection,
  execute,
  lastEvent,
  createRoom,
  joinRoom,
  startRound,
} from "./Fixtures";
import { MUSIC_POOL_COOLDOWN_MS, SonGuessrService } from "../../src/application/SonGuessrService";
import {
  type SongDetails,
  type SonGuessrPrivateState,
  type SonGuessrRoomSnapshot,
} from "../../src/shared/Index";
import { AppError } from "../../src/domain/Errors";
import {
  ROOM_EMPTY_GRACE_PERIOD_MS,
  HOST_RECONNECT_TIMEOUT_MS,
  JOIN_PASSWORD_MAX_ATTEMPTS,
  JOIN_PASSWORD_ROOM_MAX_ATTEMPTS,
  JOIN_PASSWORD_WINDOW_MS,
  PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS,
} from "../../src/config/Constants";
import { type SongSearchResult } from "../../src/shared/SonGuessr";
import {
  type MusicCookieInput,
  type MusicProvider,
} from "../../src/infrastructure/NeteaseMusicProvider";
import { AggregatedMusicProvider } from "../../src/infrastructure/AggregatedMusicProvider";

describe("SonGuessrService", () => {
  test("等待阶段房主也可以按 Whoisfaker 规则切换旁观和玩家席位", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");

    await execute(service, host, {
      id: "host-watch",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: hostState.playerId, membership: "spectator", isHost: true }),
      ])
    );

    await execute(service, host, {
      id: "host-play",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: false },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: hostState.playerId, membership: "active", isHost: true }),
      ])
    );
  });

  test("断线后的空房间在宽限期后由 housekeeping 自动清理", async () => {
    let now = 0;
    const service = new SonGuessrService({ musicProvider: provider, now: () => now });
    const host = connection(service, "host");
    await createRoom(service, host);

    await service.unregisterConnection(host.record.id);
    expect(service.getRoomSummaries()).toHaveLength(1);
    await service.runHousekeeping();
    expect(service.getRoomSummaries()).toHaveLength(1);
    now += ROOM_EMPTY_GRACE_PERIOD_MS + 1;
    await service.runHousekeeping();
    expect(service.getRoomSummaries()).toHaveLength(0);
  });

  test("房主转移不改账号归属，清号是号主本人的动作", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "session-host");
    const guest = connection(service, "session-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "玩家");
    await execute(service, host, {
      id: "session-transfer",
      type: "song.room.transferHost",
      roomId: "1234",
      payload: { playerId: guestState.playerId },
    });
    // 号跟着贡献者走，不跟着房主身份走：房主换人后原房主的号仍在池里（人还在房）。
    const afterTransfer = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(afterTransfer.hostPlayerId).toBe(guestState.playerId);
    expect(afterTransfer.musicAccountReady).toBe(true);
    expect(afterTransfer.musicPool?.map((entry) => entry.playerId)).toEqual([hostState.playerId]);

    // 新房主清号只清到自己的号；池里没有他的号，别人的号不受影响。
    await execute(service, guest, {
      id: "session-clear-other",
      type: "song.auth.clear",
      roomId: "1234",
      payload: {},
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").musicAccountReady).toBe(
      true
    );

    // 号主本人清号才真的把这条摘掉。
    await execute(service, host, {
      id: "session-clear",
      type: "song.auth.clear",
      roomId: "1234",
      payload: {},
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").musicAccountReady).toBe(
      false
    );
  });

  test("私密房间保留在大厅列表并要求密码加入", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host, {
      visibility: "private",
      password: "secret",
      name: "私密猜歌房",
    });

    expect(service.getRoomSummaries()).toEqual([
      expect.objectContaining({ roomId: "1234", visibility: "private", hasPassword: true }),
    ]);
    await expect(joinRoom(service, guest, "玩家")).rejects.toMatchObject({
      code: "PASSWORD_INCORRECT",
    });
    await joinRoom(service, guest, "玩家", "1234", "secret");
    // 口令只在请求里出现一次：房间快照与大厅摘要都不该带出可读明文。
    expect(JSON.stringify(lastEvent(guest, "song.room.snapshot"))).not.toContain("secret");
    expect(JSON.stringify(service.getRoomSummaries())).not.toContain("secret");
  });

  test("大厅房间摘要包含题目类型且随设置更新实时同步", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    await createRoom(service, host, { name: "初始识曲房" });

    expect(service.getRoomSummaries()).toEqual([
      expect.objectContaining({ name: "初始识曲房", questionType: "song" }),
    ]);

    await execute(service, host, {
      id: "switch-to-anime",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { questionType: "anime" },
    });

    expect(service.getRoomSummaries()).toEqual([
      expect.objectContaining({ name: "初始识曲房", questionType: "anime" }),
    ]);
  });

  test("密码尝试超过上限后连正确密码也拒绝，其它连接不受影响，窗口过后恢复", async () => {
    let now = 1_000_000;
    const service = new SonGuessrService({ musicProvider: provider, now: () => now });
    await createRoom(service, connection(service, "host"), {
      visibility: "private",
      password: "secret",
    });
    let attemptId = 0;
    const attempt = (client: TestConnection, userName: string, password?: string) =>
      execute(service, client, {
        id: `password-attempt-${++attemptId}`,
        type: "song.room.join",
        roomId: "1234",
        payload: password === undefined ? { userName } : { userName, password },
      });

    const attacker = connection(service, "attacker");
    for (let index = 0; index < JOIN_PASSWORD_MAX_ATTEMPTS; index += 1) {
      await expect(attempt(attacker, "尝试者", `猜测${index}`)).rejects.toMatchObject({
        code: "PASSWORD_INCORRECT",
      });
    }
    await expect(attempt(attacker, "尝试者", "secret")).rejects.toMatchObject({
      code: "TOO_MANY_ATTEMPTS",
    });

    // 缺少密码只是提示输入，不消耗配额：另一个连接先空试到上限，仍能凭正确密码进入。
    const friend = connection(service, "friend");
    for (let index = 0; index < JOIN_PASSWORD_MAX_ATTEMPTS; index += 1) {
      await expect(attempt(friend, "朋友")).rejects.toMatchObject({ code: "PASSWORD_INCORRECT" });
    }
    await attempt(friend, "朋友", "secret");

    now += JOIN_PASSWORD_WINDOW_MS + 1;
    await attempt(attacker, "尝试者", "secret");
    expect(
      lastEvent<SonGuessrRoomSnapshot>(friend, "song.room.snapshot")
        .players.map((player) => player.name)
        .sort()
    ).toEqual(["尝试者", "房主", "朋友"].sort());
  });

  test("同一房间的密码尝试有聚合额度：多开连接换不来更多爆破次数", async () => {
    let now = 1_000_000;
    const service = new SonGuessrService({ musicProvider: provider, now: () => now });
    await createRoom(service, connection(service, "host"), {
      visibility: "private",
      password: "secret",
    });
    let attemptId = 0;
    const attempt = (client: TestConnection, userName: string, password: string) =>
      execute(service, client, {
        id: `password-burst-${++attemptId}`,
        type: "song.room.join",
        roomId: "1234",
        payload: { userName, password },
      });

    const sockets = Array.from(
      { length: JOIN_PASSWORD_ROOM_MAX_ATTEMPTS / JOIN_PASSWORD_MAX_ATTEMPTS + 1 },
      (_, index) => connection(service, `burst-${index}`)
    );
    for (const socket of sockets.slice(0, -1)) {
      for (let index = 0; index < JOIN_PASSWORD_MAX_ATTEMPTS; index += 1) {
        await expect(attempt(socket, "尝试者", `猜测${index}`)).rejects.toMatchObject({
          code: "PASSWORD_INCORRECT",
        });
      }
    }

    // 最后一条连接自己一次都没试过，房间聚合额度已被前面的连接用光。
    const overflow = sockets[sockets.length - 1]!;
    await expect(attempt(overflow, "溢出者", "错误口令")).rejects.toMatchObject({
      code: "TOO_MANY_ATTEMPTS",
    });
    // 先计数再校验：正确密码同样被拒，攻击者分不清是额度用完还是口令猜中。
    await expect(attempt(overflow, "溢出者", "secret")).rejects.toMatchObject({
      code: "TOO_MANY_ATTEMPTS",
    });

    now += JOIN_PASSWORD_WINDOW_MS + 1;
    await attempt(overflow, "溢出者", "secret");
    expect(
      lastEvent<SonGuessrRoomSnapshot>(overflow, "song.room.snapshot").players.map(
        (player) => player.name
      )
    ).toEqual(["房主", "溢出者"]);
  });

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
    await execute(service, guest, {
      id: "ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostSeat.playerId },
    });

    await expect(
      execute(service, host, {
        id: "submit",
        type: "song.game.submitSong",
        roomId: "1234",
        payload: { songId: "answer" },
      })
    ).rejects.toMatchObject({ code: "MUSIC_LOGIN_RISK" });

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
    await execute(service, guest, {
      id: "ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostSeat.playerId },
    });

    await expect(
      execute(service, host, {
        id: "submit",
        type: "song.game.submitSong",
        roomId: "1234",
        payload: { songId: "answer" },
      })
    ).rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });

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
    expect(relogged.musicAccounts?.netease?.nickname).toBe("测试账号");
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
    const aggregated = new AggregatedMusicProvider({
      neteaseProvider: neteaseMock,
      qqProvider: qqMock,
    });
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
    const aggregated = new AggregatedMusicProvider({
      neteaseProvider: neteaseMock,
      qqProvider: qqMock,
    });
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
    const aggregated = new AggregatedMusicProvider({
      neteaseProvider: neteaseMock,
      qqProvider: qqMock,
    });
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
    // 后台续期是 fire-and-forget；等它跑完再查下一次检索用的 Cookie。
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

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
    const aggregated = new AggregatedMusicProvider({
      neteaseProvider: neteaseMock,
      qqProvider: qqMock,
    });
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
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // 客户端仍保存着旧副本，重新上传；上游校验仍可通过，但服务端应保留已续期的新 Cookie。
    const reupload = await execute<{ cookie: string }>(service, guest, {
      id: "stale-reupload",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "qm_keyst=old", platform: "qq" },
    });
    expect(reupload.cookie).toBe("qm_keyst=swept");
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
    const aggregated = new AggregatedMusicProvider({
      neteaseProvider: neteaseMock,
      qqProvider: qqMock,
    });
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
    for (const client of [freeGuest, vipGuest]) {
      await execute(service, client, {
        id: `ready-${client.record.id}`,
        type: "song.player.setReady",
        roomId: "1234",
        payload: { ready: true },
      });
    }
    await execute(service, host, {
      id: "start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostSeat.playerId },
    });
    await execute(service, host, {
      id: "submit",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "qq:9001" },
    });

    await execute(service, vipGuest, {
      id: "audio-failed",
      type: "song.game.audioFailed",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    expect(refreshCookies.at(-1)).toBe("qm_keyst=qq-vip");
    expect(submittedCookies).not.toContain("qm_keyst=qq-free");
    expect(
      lastEvent<SonGuessrRoomSnapshot>(vipGuest, "song.room.snapshot").currentRound?.audioUrl
    ).toBe("https://audio/refreshed.mp3");
  });

  test("房主连接断开时保留 Cookie，宽限期后转移房主", async () => {
    const authProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { nickname: "断线账号" },
      }),
    };
    let now = 0;
    const service = new SonGuessrService({ musicProvider: authProvider, now: () => now });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const guestState = await joinRoom(service, guest, "玩家");
    await execute(service, host, {
      id: "load-cookie-before-disconnect",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=disconnect-cookie" },
    });

    await service.unregisterConnection(host.record.id);
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    expect(snapshot.hostPlayerId).toBe(hostState.playerId);
    expect(snapshot.musicAccountReady).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("disconnect-cookie");
    now += HOST_RECONNECT_TIMEOUT_MS + 1;
    await service.runHousekeeping();
    const transferred = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(transferred.hostPlayerId).toBe(guestState.playerId);
    expect(transferred.musicAccountReady).toBe(true);
  });

  test("房主断线宽限期内新玩家加入不会接管房主或音乐会话", async () => {
    let now = 0;
    const service = new SonGuessrService({ musicProvider: provider, now: () => now });
    const host = connection(service, "grace-host");
    const guest = connection(service, "grace-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");

    await service.unregisterConnection(host.record.id);
    now += HOST_RECONNECT_TIMEOUT_MS - 1;
    await joinRoom(service, guest, "宽限期玩家");

    const snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(snapshot.hostPlayerId).toBe(hostState.playerId);
    expect(snapshot.musicAccountReady).toBe(true);
  });

  test("未登录网易云账号时不能开始游戏", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    await execute(service, host, {
      id: "clear-account-before-start",
      type: "song.auth.clear",
      roomId: "1234",
      payload: {},
    });
    await joinRoom(service, guest, "玩家");
    await execute(service, guest, {
      id: "ready-before-login-check",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });

    await expect(
      execute(service, host, {
        id: "start-without-login",
        type: "song.game.start",
        roomId: "1234",
        payload: {},
      })
    ).rejects.toMatchObject({
      code: "MUSIC_LOGIN_REQUIRED",
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("waiting");
  });

  test("开始游戏前会重新校验 Cookie，失效后清除房间账号状态", async () => {
    let statusCalls = 0;
    const expiringProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => {
        statusCalls += 1;
        if (statusCalls > 1) throw new AppError("MUSIC_SESSION_INVALID", "登录状态已失效");
        return { cookie, account: { nickname: "即将失效", vipStatus: "vip" } };
      },
    };
    const service = new SonGuessrService({ musicProvider: expiringProvider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "玩家");
    await execute(service, guest, {
      id: "ready-before-expiry",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });

    await expect(
      execute(service, host, {
        id: "start-after-expiry",
        type: "song.game.start",
        roomId: "1234",
        payload: {},
      })
    ).rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });
    expect(statusCalls).toBe(2);
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").musicAccountReady).toBe(
      false
    );
  });

  test("开始游戏校验遇到限流时透传上游错误且保留账号状态", async () => {
    let statusCalls = 0;
    const rateLimitedProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => {
        statusCalls += 1;
        if (statusCalls > 1) {
          throw new AppError("MUSIC_API_RATE_LIMITED", "操作频繁，请稍候再试");
        }
        return { cookie, account: { nickname: "限流账号", vipStatus: "vip" } };
      },
    };
    const service = new SonGuessrService({ musicProvider: rateLimitedProvider });
    const host = connection(service, "rate-limit-host");
    const guest = connection(service, "rate-limit-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "玩家");
    await execute(service, guest, {
      id: "ready-before-rate-limit",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });

    await expect(
      execute(service, host, {
        id: "start-during-rate-limit",
        type: "song.game.start",
        roomId: "1234",
        payload: {},
      })
    ).rejects.toMatchObject({
      code: "MUSIC_API_RATE_LIMITED",
      message: "操作频繁，请稍候再试",
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").musicAccountReady).toBe(
      true
    );
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
    await execute(service, guest, {
      id: "ready-before-vip-check",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "start-before-vip-check",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "choose-before-vip-check",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });

    const submitted = await execute(service, host, {
      id: "submit-vip-song-without-vip",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    expect(submitted).toMatchObject({ roundNumber: 1 });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
  });
});
