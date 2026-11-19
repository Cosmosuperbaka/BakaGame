import { describe, expect, test } from "bun:test";
import { LOBBY_MERGE_WINDOW_MS } from "../../src/application/LobbyFanout";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import { AppError } from "../../src/domain/Errors";
import { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import {
  SonGuessrClientMessage,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
} from "../../src/shared/Index";
import {
  TestConnection,
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  provider,
} from "./Fixtures";

describe("SonGuessrService", () => {
  test("猜歌大厅订阅只回给自己，窗口内的多次建房并为一次下发", async () => {
    let now = Date.UTC(2026, 3, 10);
    let pendingFlush: { at: number; flush: () => void } | undefined;
    const service = new SonGuessrService({
      musicProvider: provider,
      now: () => now,
      random: { nextInt: () => 0 },
      lobbyFanoutSchedule: (flush, delayMs) => {
        pendingFlush = { at: now + delayMs, flush };
      },
    });
    const advance = (ms: number) => {
      now += ms;
      if (pendingFlush && pendingFlush.at <= now) {
        const timer = pendingFlush;
        pendingFlush = undefined;
        timer.flush();
      }
    };
    const frames = (client: TestConnection) =>
      client.sent.filter((item) => item.event === "song.lobby.rooms");
    const create = async (roomId: string) =>
      execute(service, connection(service, `song-host-${roomId}`), {
        id: `create-${roomId}`,
        type: "song.room.create",
        payload: {
          roomId,
          name: `${roomId}房`,
          visibility: "public",
          allowSpectators: true,
          userName: "房主",
        },
      } as SonGuessrClientMessage);

    const first = connection(service, "song-lobby-a");
    const second = connection(service, "song-lobby-b");
    for (const client of [first, second]) {
      await execute(service, client, {
        id: `sub-${client.record.id}`,
        type: "song.lobby.subscribeRooms",
        payload: {},
      });
    }
    expect(frames(first)).toHaveLength(1);
    expect(frames(second)).toHaveLength(1);

    await create("7001");
    await create("7002");
    await create("7003");
    expect(frames(first)).toHaveLength(2);
    expect(frames(second)).toHaveLength(2);

    // 尾沿按注入时钟收敛：两次变更之间不需要新事件，整段突发一次带出。
    advance(LOBBY_MERGE_WINDOW_MS);
    expect(frames(first)).toHaveLength(3);
    const listed = (frames(first).at(-1)!.payload as Array<{ roomId: string }>)
      .map((room) => room.roomId)
      .sort();
    expect(listed).toEqual(["7001", "7002", "7003"]);
  });

  test("后台控制口：列出隐藏房，移走房主后重选房主，关房通知全员", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const guestState = await joinRoom(service, guest, "玩家");
    const hostId = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState").playerId;

    const [room] = service.adminListRooms();
    expect(room).toMatchObject({
      game: "song",
      roomId: "1234",
      name: "猜歌房",
      hidden: false,
      visibility: "public",
    });
    expect(room!.players.map((player) => [player.name, player.host])).toEqual([
      ["房主", true],
      ["玩家", false],
    ]);

    await service.adminKickPlayer("1234", hostId);
    expect(lastEvent<{ roomId: string }>(host, "song.room.kicked")).toEqual({ roomId: "1234" });
    expect(lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").hostPlayerId).toBe(
      guestState.playerId
    );
    expect(service.adminListRooms()[0]!.players.map((player) => player.name)).toEqual(["玩家"]);
    await expect(service.adminKickPlayer("1234", hostId)).rejects.toMatchObject({
      code: "PLAYER_NOT_FOUND",
    });

    await service.adminCloseRoom("1234");
    expect(lastEvent<{ reason: string }>(guest, "song.room.closed")).toMatchObject({
      reason: "admin_closed",
    });
    expect(service.adminListRooms()).toEqual([]);
    await expect(service.adminCloseRoom("1234")).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
  });

  test("房间在线人数不设上限", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    await createRoom(service, host);

    for (let index = 1; index <= 30; index += 1) {
      const player = connection(service, `player-${index}`);
      await joinRoom(service, player, `玩家${index}`);
    }

    const snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.players).toHaveLength(31);
  });

  test("房主可以踢人且被踢连接立即收到事件", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const guestState = await joinRoom(service, guest, "玩家");

    await execute(service, host, {
      id: "kick",
      type: "song.room.kick",
      roomId: "1234",
      payload: { playerId: guestState.playerId },
    });

    expect(lastEvent<{ roomId: string }>(guest, "song.room.kicked")).toEqual({ roomId: "1234" });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").players).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: guestState.playerId })])
    );
    await expect(
      execute(service, guest, {
        id: "chat-after-kick",
        type: "song.chat.send",
        payload: { text: "还在吗" },
      })
    ).rejects.toMatchObject({ code: "PLAYER_NOT_IN_ROOM" });
  });

  test("出题人反复提交取不到音频的歌，也不能无限期占住选题阶段", async () => {
    let now = 1_000_000;
    const musicProvider: MusicProvider = {
      ...provider,
      getSong: async () => {
        throw new AppError("SONG_UNAVAILABLE", "歌曲暂时无法播放");
      },
    };
    const service = new SonGuessrService({ musicProvider, now: () => now });
    const host = connection(service, "stall-host");
    const guest = connection(service, "stall-guest");
    await createRoom(service, host);
    const hostId = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState").playerId;
    await joinRoom(service, guest, "客人");
    const send = (id: string, type: string, payload: unknown) =>
      execute(service, host, { id, type, roomId: "1234", payload } as never);
    await execute(service, guest, {
      id: "stall-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await send("stall-start", "song.game.start", {});
    await send("stall-choose", "song.game.chooseSubmitter", { playerId: hostId });

    // 每次提交都会顺延时限；累计超过两个时限后必须被巡检退回选出题人。
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      now += 100_000;
      await expect(
        send(`stall-submit-${attempt}`, "song.game.submitSong", { songId: "missing" })
      ).rejects.toMatchObject({ code: "SONG_UNAVAILABLE" });
      await service.runHousekeeping();
    }
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot")).toMatchObject({
      phase: "choosingSubmitter",
    });
  });

  describe("后台视图与在线计数", () => {
    test("单人房在后台照样列出且标为不进大厅；健康快照只数在线且未被移出的玩家", async () => {
      const service = new SonGuessrService({ musicProvider: provider });
      const solo = connection(service, "admin-solo");
      await createRoom(service, solo, { roomId: "5678", solo: true });
      const host = connection(service, "admin-host");
      const guest = connection(service, "admin-guest");
      await createRoom(service, host);
      const guestState = await joinRoom(service, guest, "玩家");

      const views = service.adminListRooms();
      expect(views.find((view) => view.roomId === "5678")?.hidden).toBe(true);
      expect(views.find((view) => view.roomId === "1234")?.hidden).toBe(false);
      expect(service.getHealthSnapshot().onlinePlayerCount).toBe(3);

      await execute(service, host, {
        id: "admin-kick",
        type: "song.room.kick",
        roomId: "1234",
        payload: { playerId: guestState.playerId },
      });
      expect(service.getHealthSnapshot().onlinePlayerCount).toBe(2);
      await expect(service.adminCloseRoom("9999")).rejects.toMatchObject({
        code: "ROOM_NOT_FOUND",
      });
    });
  });

  describe("聊天与系统消息", () => {
    const say = (service: SonGuessrService, client: TestConnection, id: string, text: string) =>
      execute(service, client, {
        id,
        type: "song.chat.send",
        roomId: "1234",
        payload: { text },
      });

    test("聊天只走增量事件，文本去空白与控制字符，系统消息发送者占位保持现值", async () => {
      const service = new SonGuessrService({ musicProvider: provider });
      const host = connection(service, "chat-host");
      const guest = connection(service, "chat-guest");
      await createRoom(service, host);
      await joinRoom(service, guest, "玩家");

      await say(service, host, "c1", "  你好​   世界 ");
      expect(
        lastEvent<{ message: { text: string; system: boolean } }>(guest, "song.chat.message")
      ).toMatchObject({ message: { text: "你好 世界", system: false } });

      const [created, joined] = service.rooms.get("1234")!.chat;
      expect(created).toMatchObject({ playerId: "system", playerName: "系统", system: true });
      expect(joined).toMatchObject({ playerId: "system", playerName: "系统", system: true });
    });

    test("空消息报 INVALID_MESSAGE，超长文本在服务层截到 200，频率超限报 RATE_LIMITED", async () => {
      const service = new SonGuessrService({ musicProvider: provider });
      const host = connection(service, "chat-limit-host");
      await createRoom(service, host);

      await expect(say(service, host, "empty", " ​ ")).rejects.toMatchObject({
        code: "INVALID_MESSAGE",
      });
      await say(service, host, "long", "字".repeat(300));
      expect(service.rooms.get("1234")!.chat.at(-1)!.text).toHaveLength(200);

      for (let index = 0; index < 3; index += 1) await say(service, host, `ok-${index}`, "好");
      await expect(say(service, host, "over", "好")).rejects.toMatchObject({
        code: "RATE_LIMITED",
        message: "发言过于频繁，请稍后再试",
      });
    });

    test("聊天记录只留最近一个窗口，挤掉最旧的", async () => {
      let now = 1_000_000;
      const service = new SonGuessrService({ musicProvider: provider, now: () => now });
      const host = connection(service, "chat-window-host");
      await createRoom(service, host);
      for (let index = 0; index < 30; index += 1) {
        now += 1_000;
        await say(service, host, `w-${index}`, `消息 ${index} 号`);
      }
      const texts = service.rooms.get("1234")!.chat.map((message) => message.text);
      expect(texts).toHaveLength(20);
      expect(texts.at(-1)).toBe("消息 29 号");
      expect(texts[0]).toBe("消息 10 号");
    });
  });
});
