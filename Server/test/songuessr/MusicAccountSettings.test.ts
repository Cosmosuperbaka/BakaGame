import { AppError } from "../../src/domain/Errors";
import { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { describe, expect, test } from "bun:test";
import {
  TestConnection,
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  provider,
} from "./Fixtures";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import { type SonGuessrPrivateState, type SonGuessrRoomSnapshot } from "../../src/shared/Index";
import {
  HOST_RECONNECT_TIMEOUT_MS,
  JOIN_PASSWORD_MAX_ATTEMPTS,
  JOIN_PASSWORD_ROOM_MAX_ATTEMPTS,
  JOIN_PASSWORD_WINDOW_MS,
  ROOM_EMPTY_GRACE_PERIOD_MS,
} from "../../src/config/Constants";

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
});
