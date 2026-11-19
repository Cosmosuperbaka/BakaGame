import { describe, expect, test } from "bun:test";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS,
  ROOM_EMPTY_GRACE_PERIOD_MS,
  ROOM_EXPIRING_WARNING_MS,
  ROOM_IDLE_TIMEOUT_MS,
} from "../../src/config/Constants";
import { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { SonGuessrPrivateState, SonGuessrRoomSnapshot, SongDetails } from "../../src/shared/Index";
import { TEST_ROOMS_ON } from "../TestRoomPolicy";
import { deferred } from "../support/Deferred";
import {
  TestConnection,
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  provider,
  songs,
  startRound,
} from "./Fixtures";

describe("SonGuessrService", () => {
  describe("房主离开而其余成员全部离线", () => {
    /** 两人房：客人先断线（座位离线保留），房主随后离开或被后台移走。 */
    const setupVacancy = async () => {
      let now = 1_000_000;
      const service = new SonGuessrService({ musicProvider: provider, now: () => now });
      const host = connection(service, "vacancy-host");
      const guest = connection(service, "vacancy-guest");
      await createRoom(service, host);
      const hostId = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState").playerId;
      const guestState = await joinRoom(service, guest, "客人");
      await service.unregisterConnection(guest.record.id);
      const comeBack = async () => {
        const client = connection(service, "vacancy-guest-2");
        await execute(service, client, {
          id: "vacancy-reconnect",
          type: "song.room.reconnect",
          payload: { roomId: "1234", sessionToken: guestState.sessionToken },
        });
        return client;
      };
      return {
        service,
        host,
        hostId,
        guestId: guestState.playerId,
        comeBack,
        advance: (ms: number) => {
          now += ms;
        },
      };
    };
    const renameRoom = (service: SonGuessrService, client: TestConnection) =>
      execute(service, client, {
        id: "vacancy-rename",
        type: "song.room.updateSettings",
        roomId: "1234",
        payload: { name: "改名" },
      });

    test("房主显式离开后，离线的客人回来当场成为房主", async () => {
      const ctx = await setupVacancy();
      await execute(ctx.service, ctx.host, {
        id: "vacancy-leave",
        type: "song.room.leave",
        roomId: "1234",
        payload: {},
      });
      ctx.advance(10_000);
      const back = await ctx.comeBack();
      expect(lastEvent<SonGuessrRoomSnapshot>(back, "song.room.snapshot").hostPlayerId).toBe(
        ctx.guestId
      );
      await ctx.service.runHousekeeping();
      ctx.advance(70_000);
      await ctx.service.runHousekeeping();
      expect(lastEvent<SonGuessrRoomSnapshot>(back, "song.room.snapshot").hostPlayerId).toBe(
        ctx.guestId
      );
      await expect(renameRoom(ctx.service, back)).resolves.toMatchObject({});
    });

    test("房主被后台移走后，离线的客人回来当场成为房主", async () => {
      const ctx = await setupVacancy();
      await ctx.service.adminKickPlayer("1234", ctx.hostId);
      ctx.advance(10_000);
      const back = await ctx.comeBack();
      expect(lastEvent<SonGuessrRoomSnapshot>(back, "song.room.snapshot").hostPlayerId).toBe(
        ctx.guestId
      );
      await expect(renameRoom(ctx.service, back)).resolves.toMatchObject({});
    });

    test("房主与客人先后断线，重连期限过后客人回来当场接任", async () => {
      const ctx = await setupVacancy();
      await ctx.service.unregisterConnection(ctx.host.record.id);
      // 超过房主重连期限、仍在空房宽限内：巡检不会重选，回来的人要自己接上。
      ctx.advance(70_000);
      const back = await ctx.comeBack();
      expect(lastEvent<SonGuessrRoomSnapshot>(back, "song.room.snapshot").hostPlayerId).toBe(
        ctx.guestId
      );
      await expect(renameRoom(ctx.service, back)).resolves.toMatchObject({});
    });
  });

  describe("座位绑定与房主", () => {
    const reconnect = (service: SonGuessrService, client: TestConnection, sessionToken: string) =>
      execute(service, client, {
        id: `reconnect-${client.record.id}`,
        type: "song.room.reconnect",
        payload: { roomId: "1234", sessionToken },
      });
    const transfer = (service: SonGuessrService, client: TestConnection, playerId: string) =>
      execute(service, client, {
        id: "transfer",
        type: "song.room.transferHost",
        roomId: "1234",
        payload: { playerId },
      });

    test("同一连接用另一座位的令牌重连：旧座位随之释放，不留在线的影子座位", async () => {
      const service = new SonGuessrService({ musicProvider: provider });
      const host = connection(service, "swap-host");
      const guest = connection(service, "swap-guest");
      await createRoom(service, host);
      const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
      const guestState = await joinRoom(service, guest, "客人");

      // 客人的连接拿房主的令牌重连：连接换到房主座位，原来的客人座位不能还挂着在线。
      await reconnect(service, guest, hostState.sessionToken);

      const room = service.rooms.get("1234")!;
      expect(room.players[guestState.playerId]).toBeUndefined();
      expect(room.players[hostState.playerId]).toMatchObject({
        online: true,
        connectionId: "swap-guest",
      });
      expect(service.ctx.connections.findConnectionByPlayer("1234", hostState.playerId)?.id).toBe(
        "swap-guest"
      );
    });

    test("手动转让房主：目标必须是在线的正式真人", async () => {
      const service = new SonGuessrService({ musicProvider: provider });
      const host = connection(service, "move-host");
      const guest = connection(service, "move-guest");
      const spectator = connection(service, "move-spectator");
      await createRoom(service, host);
      const guestState = await joinRoom(service, guest, "客人");
      await execute(service, spectator, {
        id: "spectate-join",
        type: "song.room.join",
        roomId: "1234",
        payload: { userName: "旁观者" },
      });
      const spectatorId = lastEvent<SonGuessrPrivateState>(
        spectator,
        "song.game.privateState"
      ).playerId;
      await execute(service, spectator, {
        id: "spectate",
        type: "song.player.setSpectator",
        roomId: "1234",
        payload: { spectator: true },
      });

      await expect(transfer(service, host, spectatorId)).rejects.toMatchObject({
        code: "INVALID_TARGET",
      });
      await service.unregisterConnection(guest.record.id);
      await expect(transfer(service, host, guestState.playerId)).rejects.toMatchObject({
        code: "INVALID_TARGET",
      });
      expect(service.rooms.get("1234")!.hostPlayerId).not.toBe(guestState.playerId);
    });

    test("停机恢复后房主带完整重连宽限：先回来的客人不会抢走房主", async () => {
      let now = 1_000_000;
      const service = new SonGuessrService({ musicProvider: provider, now: () => now });
      const host = connection(service, "restore-host");
      const guest = connection(service, "restore-guest");
      await createRoom(service, host);
      const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
      const guestState = await joinRoom(service, guest, "客人");
      // 停机前房主在线，快照里没有任何重连截止。
      const exported = service.exportSnapshots();

      now += 5_000;
      const restarted = new SonGuessrService({ musicProvider: provider, now: () => now });
      expect(restarted.restoreSnapshots(exported, now)).toBe(1);
      const back = connection(restarted, "restore-guest-2");
      await reconnect(restarted, back, guestState.sessionToken);
      expect(restarted.rooms.get("1234")!.hostPlayerId).toBe(hostState.playerId);

      // 宽限内房主回来仍是房主；宽限耗尽后巡检把房主交给在线的客人。
      now += 70_000;
      await restarted.runHousekeeping();
      expect(restarted.rooms.get("1234")!.hostPlayerId).toBe(guestState.playerId);
    });
  });

  describe("巡检与发布", () => {
    const expiringCount = (client: TestConnection) =>
      client.sent.filter((item) => item.event === "song.room.expiring").length;
    const chat = (service: SonGuessrService, client: TestConnection) =>
      execute(service, client, {
        id: "activity",
        type: "song.chat.send",
        roomId: "1234",
        payload: { text: "还在" },
      });

    test("闲置预警每段闲置只发一次，有新活动后下一段闲置重新预警", async () => {
      let now = 1_000_000;
      const service = new SonGuessrService({ musicProvider: provider, now: () => now });
      const host = connection(service, "warn-host");
      await createRoom(service, host);

      now += ROOM_IDLE_TIMEOUT_MS - ROOM_EXPIRING_WARNING_MS / 2;
      await service.runHousekeeping();
      await service.runHousekeeping();
      expect(expiringCount(host)).toBe(1);

      // 有新活动：这一段闲置结束，下一段闲置到点要再预警一次（布尔标记会一次用尽）。
      await chat(service, host);
      now += ROOM_IDLE_TIMEOUT_MS - ROOM_EXPIRING_WARNING_MS / 2;
      await service.runHousekeeping();
      expect(expiringCount(host)).toBe(2);
      expect(service.rooms.has("1234")).toBe(true);

      now += ROOM_EXPIRING_WARNING_MS;
      await service.runHousekeeping();
      expect(service.rooms.has("1234")).toBe(false);
    });

    test("一间房巡检抛错只记日志，其余房间照常回收", async () => {
      let now = 1_000_000;
      const warned: string[] = [];
      const service = new SonGuessrService({
        musicProvider: provider,
        now: () => now,
        eventLogger: { write: () => {}, warn: (message: string) => warned.push(message) } as never,
      });
      await createRoom(service, connection(service, "broken-host"), { roomId: "1111" });
      await createRoom(service, connection(service, "idle-host"), { roomId: "2222" });
      // 白盒让第一间房的活动时刻读取即抛错：它的巡检必然失败，且排在第二间之前。
      Object.defineProperty(service.rooms.get("1111"), "lastActivityAt", {
        get: () => {
          throw new Error("坏状态");
        },
      });

      now += ROOM_IDLE_TIMEOUT_MS + 1;
      await service.runHousekeeping();

      expect(service.rooms.has("2222")).toBe(false);
      expect(warned).toEqual(["猜歌房间巡检失败，已跳过该房间"]);
    });

    test("同一次发布里公共快照帧只封一次，各人的私有态各自构造", async () => {
      const service = new SonGuessrService({ musicProvider: provider });
      const host = connection(service, "frame-host");
      const guest = connection(service, "frame-guest");
      await createRoom(service, host);
      await joinRoom(service, guest, "客人");
      host.sent.length = 0;
      guest.sent.length = 0;

      await execute(service, guest, {
        id: "frame-ready",
        type: "song.player.setReady",
        roomId: "1234",
        payload: { ready: true },
      });

      const snapshotOf = (client: TestConnection) =>
        client.sent.find((item) => item.event === "song.room.snapshot");
      const privateOf = (client: TestConnection) =>
        client.sent.find((item) => item.event === "song.game.privateState");
      expect(snapshotOf(host)).toBeDefined();
      expect(snapshotOf(host)).toBe(snapshotOf(guest));
      expect(privateOf(host)).not.toBe(privateOf(guest));
    });
  });

  describe("房间生命周期的玩法侧收尾", () => {
    const leave = (service: SonGuessrService, client: TestConnection) =>
      execute(service, client, {
        id: "leave",
        type: "song.room.leave",
        roomId: "1234",
        payload: {},
      });

    test("房主易主后新房主恒为已准备，并作废在途的自动开局操作", async () => {
      const service = new SonGuessrService({ musicProvider: provider });
      const host = connection(service, "settle-host");
      const guest = connection(service, "settle-guest");
      await createRoom(service, host);
      const guestState = await joinRoom(service, guest, "客人");
      const room = service.rooms.get("1234")!;
      expect(room.players[guestState.playerId].isReady).toBe(false);
      room.runtime = { automaticRoundLoading: true, automaticRoundOperation: Symbol("loading") };

      await leave(service, host);

      expect(room.hostPlayerId).toBe(guestState.playerId);
      expect(room.players[guestState.playerId].isReady).toBe(true);
      expect(room.runtime?.automaticRoundLoading).toBe(false);
      expect(room.runtime?.automaticRoundOperation).toBeUndefined();
    });

    test("手动转让房主同样让新房主已准备", async () => {
      const service = new SonGuessrService({ musicProvider: provider });
      const host = connection(service, "move-ready-host");
      await createRoom(service, host);
      const guestState = await joinRoom(service, connection(service, "move-ready-guest"), "客人");
      await execute(service, host, {
        id: "move-ready",
        type: "song.room.transferHost",
        roomId: "1234",
        payload: { playerId: guestState.playerId },
      });
      expect(service.rooms.get("1234")!.players[guestState.playerId].isReady).toBe(true);
    });

    test("闲置关房与空房关房向全员发关闭事件并写明原因，音乐池清空、等号请求被叫醒", async () => {
      let now = 1_000_000;
      const service = new SonGuessrService({ musicProvider: provider, now: () => now });
      const host = connection(service, "close-host");
      await createRoom(service, host);
      const room = service.rooms.get("1234")!;
      let woken = 0;
      service.ctx.musicPoolWaiters.set("1234", new Set([() => woken++]));

      now += ROOM_IDLE_TIMEOUT_MS + 1;
      await service.runHousekeeping();

      expect(lastEvent<{ roomId: string; reason: string }>(host, "song.room.closed")).toEqual({
        roomId: "1234",
        reason: "idle_timeout",
      });
      expect(room.musicPool).toEqual([]);
      expect(woken).toBe(1);
      expect(host.record.roomId).toBeUndefined();
      expect(service.rooms.has("1234")).toBe(false);

      const lonely = connection(service, "close-empty-host");
      await createRoom(service, lonely);
      const watcher = connection(service, "close-watcher");
      await joinRoom(service, watcher, "旁人");
      await service.unregisterConnection(lonely.record.id);
      await service.unregisterConnection(watcher.record.id);
      now += ROOM_EMPTY_GRACE_PERIOD_MS + 1;
      await service.runHousekeeping();
      expect(service.rooms.has("1234")).toBe(false);
    });

    test("空房宽限内只补校准不关房，宽限满后以 empty 关房", async () => {
      let now = 1_000_000;
      const service = new SonGuessrService({ musicProvider: provider, now: () => now });
      const host = connection(service, "grace-host");
      await createRoom(service, host);
      const watcher = connection(service, "grace-watcher");
      await joinRoom(service, watcher, "旁人");
      await service.unregisterConnection(host.record.id);
      await service.unregisterConnection(watcher.record.id);
      now += ROOM_EMPTY_GRACE_PERIOD_MS - 1_000;
      await service.runHousekeeping();
      expect(service.rooms.has("1234")).toBe(true);
      now += 2_000;
      await service.runHousekeeping();
      expect(service.rooms.has("1234")).toBe(false);
    });

    test("空的测试房不推进后续巡检：离线席位不被清理", async () => {
      let now = 1_000_000;
      const service = new SonGuessrService({
        musicProvider: provider,
        testRooms: TEST_ROOMS_ON,
        now: () => now,
      });
      const host = connection(service, "tr-host");
      await createRoom(service, host, { roomId: "Oblivionis" });
      await service.unregisterConnection(host.record.id);
      now += PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS + 1_000;
      await service.runHousekeeping();
      const room = service.rooms.get("Oblivionis")!;
      expect(Object.keys(room.players)).toHaveLength(1);
    });

    test("回座重新补齐本回合的作答状态", async () => {
      const service = new SonGuessrService({ musicProvider: provider });
      const host = connection(service, "round-host");
      const guest = connection(service, "round-guest");
      await createRoom(service, host);
      const guestState = await joinRoom(service, guest, "客人");
      await startRound(
        service,
        host,
        guest,
        lastEvent<SonGuessrPrivateState>(host, "song.game.privateState").playerId
      );
      const round = service.rooms.get("1234")!.currentRound!;
      delete round.players[guestState.playerId];
      await service.unregisterConnection(guest.record.id);
      await execute(service, connection(service, "round-guest-2"), {
        id: "round-back",
        type: "song.room.reconnect",
        payload: { roomId: "1234", sessionToken: guestState.sessionToken },
      });
      expect(round.players[guestState.playerId]).toBeDefined();
    });

    test("回座刷新播放地址的等待期间，缺状态的回座者不被当作已作答完毕", async () => {
      const hold = deferred<SongDetails>();
      let holding = false;
      const musicProvider: MusicProvider = {
        ...provider,
        getSong: (...args) => (holding ? hold.promise : provider.getSong(...args)),
      };
      const service = new SonGuessrService({ musicProvider });
      const host = connection(service, "wait-host");
      const answerer = connection(service, "wait-answerer");
      const returning = connection(service, "wait-returning");
      await createRoom(service, host);
      await joinRoom(service, answerer, "作答者");
      const returningState = await joinRoom(service, returning, "回座者");
      await execute(service, returning, {
        id: "ready-returning",
        type: "song.player.setReady",
        roomId: "1234",
        payload: { ready: true },
      });
      await startRound(
        service,
        host,
        answerer,
        lastEvent<SonGuessrPrivateState>(host, "song.game.privateState").playerId
      );
      const room = service.rooms.get("1234")!;
      await service.unregisterConnection(returning.record.id);
      // 掉线时的发布会顺手补齐状态，要在它之后再模拟「切轮瞬间状态缺失」。
      delete room.currentRound!.players[returningState.playerId];

      // 回座在刷新播放地址处挂起；此时别人放弃作答，会立刻判一次「本回合是否已结束」。
      holding = true;
      const reconnecting = execute(service, connection(service, "wait-returning-2"), {
        id: "wait-back",
        type: "song.room.reconnect",
        payload: { roomId: "1234", sessionToken: returningState.sessionToken },
      });
      await execute(service, answerer, {
        id: "wait-give-up",
        type: "song.game.giveUp",
        roomId: "1234",
        payload: {},
      });
      expect(room.phase).toBe("playing");

      hold.resolve(songs.answer);
      await reconnecting;
      expect(room.phase).toBe("playing");
    });
  });

  describe("建私密房期间（口令摘要尚未算完）", () => {
    /** 把摘要停在手里：测试决定它何时算完，窗口内的一切读写都发生在 await 之间。 */
    const holdDigest = () => {
      const digest = deferred<string>();
      const hasher = {
        hash: () => digest.promise,
        verify: async (password: string, stored: string) => stored === `digest:${password}`,
      };
      return { digest, hasher };
    };
    const createPrivate = (service: SonGuessrService, client: TestConnection, roomId = "1234") =>
      execute(service, client, {
        id: `create-${roomId}`,
        type: "song.room.create",
        payload: {
          roomId,
          name: "私房",
          visibility: "private",
          password: "secret",
          allowSpectators: true,
          userName: "房主",
        },
      });

    test("窗口内房间不可见，无口令与同号建房都被拒，摘要算完后凭口令可进", async () => {
      const { digest, hasher } = holdDigest();
      const service = new SonGuessrService({ musicProvider: provider, passwordHasher: hasher });
      const host = connection(service, "window-host");
      const creating = createPrivate(service, host);

      expect(service.rooms.has("1234")).toBe(false);
      expect(service.getRoomSummaries()).toEqual([]);
      const intruder = connection(service, "window-intruder");
      await expect(
        execute(service, intruder, {
          id: "window-join",
          type: "song.room.join",
          roomId: "1234",
          payload: { userName: "闯入者" },
        })
      ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
      await expect(
        createPrivate(service, connection(service, "window-rival"))
      ).rejects.toMatchObject({ code: "ROOM_EXISTS" });

      digest.resolve("digest:secret");
      await creating;
      await expect(
        execute(service, intruder, {
          id: "window-join-2",
          type: "song.room.join",
          roomId: "1234",
          payload: { userName: "闯入者" },
        })
      ).rejects.toMatchObject({ code: "PASSWORD_INCORRECT" });
      const guest = connection(service, "window-guest");
      await expect(joinRoom(service, guest, "客人", "1234", "secret")).resolves.toMatchObject({});
    });

    test("摘要期间连接已断开：不登记房间，房号随即释放", async () => {
      const { digest, hasher } = holdDigest();
      const service = new SonGuessrService({ musicProvider: provider, passwordHasher: hasher });
      const host = connection(service, "gone-host");
      const creating = createPrivate(service, host);
      await service.unregisterConnection(host.record.id);
      digest.resolve("digest:secret");
      await expect(creating).rejects.toMatchObject({ code: "SESSION_INVALID" });
      expect(service.rooms.has("1234")).toBe(false);

      const retry = connection(service, "gone-retry");
      await expect(createRoom(service, retry)).resolves.toMatchObject({ roomId: "1234" });
    });

    test("摘要算失败：房号释放，可以重新建房", async () => {
      const { digest, hasher } = holdDigest();
      const service = new SonGuessrService({ musicProvider: provider, passwordHasher: hasher });
      const creating = createPrivate(service, connection(service, "fail-host"));
      digest.reject(new Error("hash failed"));
      await expect(creating).rejects.toThrow("hash failed");
      await expect(createRoom(service, connection(service, "fail-retry"))).resolves.toMatchObject({
        roomId: "1234",
      });
    });
  });
});
