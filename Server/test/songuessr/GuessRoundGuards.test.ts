import { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { describe, expect, test } from "bun:test";
import {
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  provider,
  songs,
  startRound,
} from "./Fixtures";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  SERVER_SHUTDOWN_MESSAGE,
  SonGuessrRoomSnapshot,
  type SonGuessrPrivateState,
} from "../../src/shared/Index";

describe("SonGuessrService", () => {
  test("关闭歌词和猜测时限后不公开歌词且不创建截止时间", async () => {
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => 10_000,
    });
    const host = connection(service, "settings-host");
    const guest = connection(service, "settings-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await execute(service, host, {
      id: "hidden-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { showLyrics: false, showGuessTimer: false },
    });
    await startRound(service, host, guest, hostState.playerId);

    const playing = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(playing.settings).toMatchObject({ showLyrics: false, showGuessTimer: false });
    expect(playing.currentRound?.lyricClip.lines).toEqual([]);
    const ready = (await execute(service, guest, {
      id: "no-timer-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    })) as { deadlineAt?: number };
    expect(ready.deadlineAt).toBeUndefined();
    expect(
      lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").guessDeadlineAt
    ).toBeUndefined();
  });

  test("进行中禁止修改房间设置且回合继续使用开局快照", async () => {
    let now = 20_000;
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => now,
    });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);
    await execute(service, guest, {
      id: "audio-first-round",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    const firstDeadline = lastEvent<SonGuessrPrivateState>(
      guest,
      "song.game.privateState"
    ).guessDeadlineAt;
    expect(firstDeadline).toBe(now + 60_000);

    await expect(
      execute(service, host, {
        id: "settings-during-round",
        type: "song.room.updateSettings",
        roomId: "1234",
        payload: { maxGuessesPerRound: 1, guessDurationSeconds: 10, lyricsLineCount: 3 },
      })
    ).rejects.toMatchObject({ code: "INVALID_PHASE" });
    const currentPrivate = lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState");
    expect(currentPrivate.remainingGuesses).toBe(3);
    expect(currentPrivate.guessDeadlineAt).toBe(firstDeadline);

    await execute(service, guest, {
      id: "give-up-current",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "next-round-settings",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "choose-next",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "submit-next",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    expect(
      lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").currentRound?.lyricClip.lines
    ).toHaveLength(5);
    now += 1_000;
    await execute(service, guest, {
      id: "audio-next-round",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 2 },
    });
    const nextPrivate = lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState");
    expect(nextPrivate.remainingGuesses).toBe(3);
    expect(nextPrivate.guessDeadlineAt).toBe(now + 60_000);
  });

  test("允许用展示中的歌词原词搜索", async () => {
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);

    await expect(
      execute(service, guest, {
        id: "search-lyric",
        type: "song.music.search",
        roomId: "1234",
        payload: { keyword: "歌词1" },
      })
    ).resolves.toMatchObject({ results: expect.any(Array) });
    await expect(
      execute(service, guest, {
        id: "search-normal",
        type: "song.music.search",
        roomId: "1234",
        payload: { keyword: "测试歌手" },
      })
    ).resolves.toMatchObject({ results: expect.any(Array) });
  });

  test("歌单 ID 解析支持纯数字、带参数 URL、Hash 路由与移动端链接", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    await createRoom(service, host);

    // 1. 纯数字 ID
    await execute(service, host, {
      id: "filter-num",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { autoFilters: { playlist: { id: "987654321" }, artists: [], minPopularity: 0 } },
    });
    let snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.settings.autoFilters.playlist?.id).toBe("987654321");

    // 2. 带 Query 参数的标准 URL
    await execute(service, host, {
      id: "filter-query",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        autoFilters: {
          playlist: { id: "https://music.163.com/playlist?id=12345678&userid=999" },
          artists: [],
          minPopularity: 0,
        },
      },
    });
    snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.settings.autoFilters.playlist?.id).toBe("12345678");

    // 3. SPA Hash 路由 URL
    await execute(service, host, {
      id: "filter-hash",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        autoFilters: {
          playlist: { id: "https://music.163.com/#/playlist?id=87654321" },
          artists: [],
          minPopularity: 0,
        },
      },
    });
    snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.settings.autoFilters.playlist?.id).toBe("87654321");
  });

  test("并发猜歌时前置占锁与配额保护，禁止突破猜测上限", async () => {
    const slowProvider: MusicProvider = {
      ...provider,
      getSongMetadata: async (id) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return songs[id as keyof typeof songs] ?? songs.wrong;
      },
    };
    const service = new SonGuessrService({
      musicProvider: slowProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "host-race");
    const guest = connection(service, "guest-race");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "并发测试玩家");
    await startRound(service, host, guest, hostState.playerId);

    // 玩家标记音频已就绪
    await execute(service, guest, {
      id: "audio-ready",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });

    // 并发发起两次猜歌（故意制造微任务交错）
    const guess1 = execute(service, guest, {
      id: "guess-1",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "wrong" },
    });
    const guess2 = execute(service, guest, {
      id: "guess-2",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "wrong" },
    });

    const results = await Promise.allSettled([guess1, guess2]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe("GUESS_IN_PROGRESS");

    const snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    const guesserPlayer = snapshot.players.find((p) => p.id === guestState.playerId);
    expect(guesserPlayer?.guessesUsed).toBe(1);
  });

  test("音频未就绪玩家在超过加载宽限期后由巡检超时结算，避免房间死锁", async () => {
    let mockTime = 100_000;
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => mockTime,
    });
    const host = connection(service, "host-stall");
    const guest = connection(service, "guest-stall");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "卡死玩家");
    await startRound(service, host, guest, hostState.playerId);

    const initialSnapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(initialSnapshot.phase).toBe("playing");

    // 硬截止锚定在「首名玩家真正具备答题条件」的时刻：没人就绪的房间不该凭空倒计时。
    // 注意必须由猜歌玩家（guest）上报就绪 —— 出题人（host）本就不能参与猜歌。
    await execute(service, guest, {
      id: "guest-stall-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });

    // 硬截止要覆盖全部猜测窗口（默认 3 次 × 60 秒）与各自的回源裕量：
    // 第一次猜测的倒计时远不是整回合的上限，不能在这一刻就结算。
    mockTime += 200_000;
    await service.runHousekeeping();
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");

    // 越过锚点 + 3 × (60 + 20) 秒后才由硬截止保底结算，房间不会死锁。
    mockTime += 45_000;
    await service.runHousekeeping();

    const finalSnapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(finalSnapshot.phase).toBe("roundResult");
    expect(finalSnapshot.roundSummary).toBeDefined();
  });

  test("创建、加入与重连指令直接返回完整快照与私有状态，杜绝客户端加载悬挂", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "host-ack");
    const guest = connection(service, "guest-ack");

    const created = (await createRoom(service, host, {
      roomId: "9876",
      userName: "房主Ack",
    })) as any;
    expect(created.roomId).toBe("9876");
    expect(created.snapshot).toBeDefined();
    expect(created.snapshot.roomId).toBe("9876");
    expect(created.privateState).toBeDefined();
    expect(created.privateState.playerId).toBe(created.playerId);

    const joined = (await execute(service, guest, {
      id: "join-ack",
      type: "song.room.join",
      roomId: "9876",
      payload: { userName: "客人Ack" },
    })) as any;
    expect(joined.roomId).toBe("9876");
    expect(joined.snapshot).toBeDefined();
    expect(joined.snapshot.roomId).toBe("9876");
    expect(joined.privateState).toBeDefined();
    expect(joined.privateState.playerId).toBe(joined.playerId);

    const reconnected = (await execute(service, host, {
      id: "reconnect-ack",
      type: "song.room.reconnect",
      payload: { roomId: "9876", sessionToken: created.sessionToken },
    })) as any;
    expect(reconnected.roomId).toBe("9876");
    expect(reconnected.snapshot).toBeDefined();
    expect(reconnected.privateState).toBeDefined();
  });

  test("服务停机通知会广播到所有猜歌连接", () => {
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
    });
    const client = connection(service, "shutdown-client");
    service.notifyShutdown();
    expect(lastEvent<{ message: string }>(client, "server.shutdown")?.message).toBe(
      SERVER_SHUTDOWN_MESSAGE
    );
  });
});
