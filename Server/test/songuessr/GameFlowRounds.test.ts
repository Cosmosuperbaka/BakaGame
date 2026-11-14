import { GameRoundRecord } from "../../src/domain/GameRecord";
import { describe, expect, test } from "bun:test";
import {
  audioTicketOf,
  chosenSongId,
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
  type SongDetails,
  type SonGuessrPrivateState,
  type SonGuessrRoomSnapshot,
} from "../../src/shared/Index";
import { type MusicProvider } from "../../src/infrastructure/music/MusicProvider";

describe("SonGuessrService", () => {
  test("异步取歌期间出题人离开后不会安装无归属回合", async () => {
    let resolveSong!: (song: SongDetails) => void;
    const pendingSong = new Promise<SongDetails>((resolve) => {
      resolveSong = resolve;
    });
    const delayedProvider: MusicProvider = {
      ...provider,
      getSong: async () => pendingSong,
    };
    const service = new SonGuessrService({ musicProvider: delayedProvider });
    const host = connection(service, "pending-host");
    const guest = connection(service, "pending-submitter");
    await createRoom(service, host);
    const guestState = await joinRoom(service, guest, "出题人");
    await execute(service, guest, {
      id: "pending-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "pending-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "pending-choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: guestState.playerId },
    });

    const submitPromise = execute(service, guest, {
      id: "pending-submit",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    await execute(service, guest, {
      id: "pending-leave",
      type: "song.room.leave",
      roomId: "1234",
      payload: {},
    });
    resolveSong(songs.answer);

    await expect(submitPromise).resolves.toEqual({ ignored: true });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot")).toMatchObject({
      phase: "choosingSubmitter",
      roundNumber: 0,
    });
  });

  test("完整迁移出题、逐次猜测、反馈、计分与结算流程", async () => {
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => 1_000,
    });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");

    await execute(service, guest, {
      id: "join",
      type: "song.room.join",
      roomId: "1234",
      payload: { userName: "玩家" },
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
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "submit",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });

    const playing = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(playing.phase).toBe("playing");
    expect(chosenSongId(service, "1234")).toBe("answer");
    expect(playing.currentRound).not.toHaveProperty("attempts");
    expect(JSON.stringify(playing)).not.toContain("答案歌");
    await expect(
      execute(service, host, {
        id: "normal-submitter-cannot-guess",
        type: "song.game.guess",
        roomId: "1234",
        payload: { songId: "wrong" },
      })
    ).rejects.toMatchObject({ code: "SUBMITTER_CANNOT_GUESS" });

    await execute(service, guest, {
      id: "audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    const wrong = (await execute(service, guest, {
      id: "wrong",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "wrong" },
    })) as { attempt: { feedback: { releaseYearDirection: string } } };
    expect(wrong.attempt.feedback.releaseYearDirection).toBe("higher");
    expect(
      lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").visibleAttempts
    ).toEqual([
      expect.objectContaining({
        playerName: "玩家",
        guessedSong: expect.objectContaining({ title: "错误歌" }),
      }),
    ]);
    expect(
      lastEvent<SonGuessrPrivateState>(host, "song.game.privateState").visibleAttempts
    ).toEqual([
      expect.objectContaining({
        playerName: "玩家",
        guessedSong: expect.objectContaining({ title: "错误歌" }),
      }),
    ]);

    await execute(service, guest, {
      id: "correct",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    const result = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(result.phase).toBe("roundResult");
    expect(result.roundSummary?.song.title).toBe("答案歌");
    // 新口径：玩家第 2 次才猜中（精度 2/3），速度按用时趋近满分 → round(10×1.2×2/3)=8；
    // 出题人按难度分 round(8×1.0×D)=3。
    expect(result.roundSummary?.scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerName: "玩家", score: 8, delta: 8 }),
        expect.objectContaining({ playerName: "房主", score: 3, delta: 3 }),
      ])
    );
  });

  test("猜歌玩家刷新时保持当前回合并刷新播放地址", async () => {
    let songLoads = 0;
    const refreshProvider: MusicProvider = {
      ...provider,
      getSong: async (id) => ({
        ...songs[id as keyof typeof songs],
        audioUrl: `https://audio/refresh-${++songLoads}.mp3`,
      }),
    };
    const service = new SonGuessrService({
      musicProvider: refreshProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "refresh-host");
    const guest = connection(service, "refresh-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "刷新玩家");
    await startRound(service, host, guest, hostState.playerId);
    const playingUrl = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound
      ?.audioUrl;
    const ticket = audioTicketOf(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot"));
    expect(service.resolveAudioRedirect("1234", ticket)).toBe("https://audio/refresh-1.mp3");

    await service.unregisterConnection(guest.record.id);
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");

    const refreshed = connection(service, "refresh-guest-new");
    await execute(service, refreshed, {
      id: "refresh-reconnect",
      type: "song.room.reconnect",
      payload: { roomId: "1234", sessionToken: guestState.sessionToken },
    });
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(refreshed, "song.room.snapshot");
    expect(snapshot).toMatchObject({
      phase: "playing",
      // 刷新只换服务端保存的上游地址，客户端拿到的站内地址不变。
      currentRound: { roundNumber: 1, audioUrl: playingUrl },
    });
    expect(service.resolveAudioRedirect("1234", ticket)).toBe("https://audio/refresh-2.mp3");
    expect(lastEvent<SonGuessrPrivateState>(refreshed, "song.game.privateState").canGiveUp).toBe(
      true
    );
  });

  test("回合结算写入一条对局记录：答案、猜测时间线与本轮得分", async () => {
    const records: GameRoundRecord[] = [];
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      gameRecorder: {
        record: (round) => records.push(structuredClone(round)),
        finishRoom: () => {},
      },
    });
    const host = connection(service, "record-host");
    const guest = connection(service, "record-guest");
    guest.record.account = { userId: "user-guest", image: null };
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "记录玩家");
    await startRound(service, host, guest, hostState.playerId);
    await execute(service, guest, {
      id: "record-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    await execute(service, guest, {
      id: "record-wrong",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "wrong" },
    });
    await execute(service, guest, {
      id: "record-right",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("roundResult");

    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record).toMatchObject({
      game: "song",
      roomId: "1234",
      roundNumber: 1,
      summary: { song: { id: "answer" }, submitter: "房主", correct: ["记录玩家"], skipped: false },
    });
    expect(record!.timeline.map((event) => event.result)).toEqual(["wrong", "correct"]);
    const guestRecord = record!.players.find((player) => player.name === "记录玩家");
    expect(guestRecord).toMatchObject({ userId: "user-guest" });
    expect(guestRecord!.score).toBeGreaterThan(0);
  });

  test("结算后补发旧 audioReady 会被幂等忽略", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "stale-ready-host");
    const guest = connection(service, "stale-ready-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);
    await execute(service, guest, {
      id: "stale-ready-give-up",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });

    await expect(
      execute(service, guest, {
        id: "stale-ready-after-result",
        type: "song.game.audioReady",
        roomId: "1234",
        payload: { roundNumber: 1 },
      })
    ).resolves.toEqual({ ignored: true });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("roundResult");
  });
});
