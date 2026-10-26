import { MusicProvider } from "../../src/infrastructure/NeteaseMusicProvider";
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
  test("血战模式按抢答排名递减计分且不会在首位答对后提前结算", async () => {
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "blood-host");
    const first = connection(service, "blood-first");
    const second = connection(service, "blood-second");
    const third = connection(service, "blood-third");
    const spectator = connection(service, "blood-spectator");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const firstState = await joinRoom(service, first, "第一名");
    const secondState = await joinRoom(service, second, "第二名");
    const thirdState = await joinRoom(service, third, "第三名");
    await joinRoom(service, spectator, "旁观者");
    await execute(service, spectator, {
      id: "spectate",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });
    await execute(service, host, {
      id: "blood-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { bloodMode: true },
    });
    for (const [client, id] of [
      [first, "first"],
      [second, "second"],
      [third, "third"],
    ] as const) {
      await execute(service, client, {
        id: `ready-${id}`,
        type: "song.player.setReady",
        roomId: "1234",
        payload: { ready: true },
      });
    }
    await execute(service, host, {
      id: "blood-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "blood-choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "blood-submit",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    for (const [client, id] of [
      [first, "first"],
      [second, "second"],
      [third, "third"],
    ] as const) {
      await execute(service, client, {
        id: `audio-${id}`,
        type: "song.game.audioReady",
        roomId: "1234",
        payload: { roundNumber: 1 },
      });
    }

    await execute(service, first, {
      id: "guess-first",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    let snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.phase).toBe("playing");
    // 血战速度系数 = (可作答人数 - 名次 + 1) / 可作答人数：3 人里第 1 名得满分。
    expect(snapshot.players).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: firstState.playerId, score: 10 })])
    );

    await execute(service, second, {
      id: "guess-second",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
    await execute(service, third, {
      id: "guess-third",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.phase).toBe("roundResult");
    expect(snapshot.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstState.playerId, score: 10 }),
        expect.objectContaining({ id: secondState.playerId, score: 7 }),
        expect.objectContaining({ id: thirdState.playerId, score: 3 }),
        expect.objectContaining({ name: "旁观者", score: 0, membership: "spectator" }),
      ])
    );
  });

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

  test("回合结算后返回等待阶段保留轮数和累计分数", async () => {
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
    await execute(service, guest, {
      id: "audio-ready-first-round",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    await execute(service, guest, {
      id: "correct-first-round",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "answer" },
    });

    await execute(service, host, {
      id: "return-to-waiting",
      type: "song.game.finish",
      roomId: "1234",
      payload: {},
    });
    const waiting = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(waiting).toMatchObject({ phase: "waiting", roundNumber: 1 });
    expect(waiting.roundSummary).toBeUndefined();
    expect(waiting.finalScores).toBeUndefined();
    expect(waiting.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "房主", score: 4, isReady: true }),
        expect.objectContaining({ name: "玩家", score: 12, isReady: false }),
      ])
    );

    await execute(service, guest, {
      id: "ready-again",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "start-again",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    const restarted = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(restarted).toMatchObject({ phase: "choosingSubmitter", roundNumber: 1 });
    expect(restarted.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "房主", score: 4 }),
        expect.objectContaining({ name: "玩家", score: 12 }),
      ])
    );
  });

  test("逐轮结果只保留当前回合，换轮与回到等待时清零", async () => {
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "marks-host");
    const guest = connection(service, "marks-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);
    await execute(service, guest, {
      id: "marks-audio-first",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    await execute(service, guest, {
      id: "marks-guess-first",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    const firstResult = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(firstResult.phase).toBe("roundResult");
    expect(firstResult.players.find((player) => player.name === "玩家")?.roundMarks).toEqual([
      "correct",
    ]);

    // 点「再来一轮」就已经进入下一轮：上一轮的结局不能跟着进新回合。
    await execute(service, host, {
      id: "marks-next",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    const between = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(between.phase).toBe("choosingSubmitter");
    expect(between.players.every((player) => player.roundMarks.length === 0)).toBe(true);

    await execute(service, host, {
      id: "marks-choose-second",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "marks-submit-second",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    await execute(service, guest, {
      id: "marks-audio-second",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 2 },
    });
    await execute(service, guest, {
      id: "marks-guess-second",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    const secondResult = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(secondResult.roundNumber).toBe(2);
    expect(secondResult.players.find((player) => player.name === "玩家")?.roundMarks).toEqual([
      "correct",
    ]);

    await execute(service, host, {
      id: "marks-finish",
      type: "song.game.finish",
      roomId: "1234",
      payload: {},
    });
    const waiting = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(waiting.phase).toBe("waiting");
    expect(waiting.players.every((player) => player.roundMarks.length === 0)).toBe(true);
  });

  test("中途加入者可以预约下轮席位，旁观真人也可以担任出题人", async () => {
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    const lateJoiner = connection(service, "late");
    const observer = connection(service, "observer");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);

    const lateState = await joinRoom(service, lateJoiner, "中途加入");
    expect(lastEvent<SonGuessrRoomSnapshot>(lateJoiner, "song.room.snapshot").players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: lateState.playerId, membership: "spectator" }),
      ])
    );
    await expect(
      execute(service, lateJoiner, {
        id: "join-next-round",
        type: "song.player.setSpectator",
        roomId: "1234",
        payload: { spectator: false },
      })
    ).resolves.toEqual({ spectator: false, queued: true });
    expect(lastEvent<SonGuessrRoomSnapshot>(lateJoiner, "song.room.snapshot").players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: lateState.playerId,
          membership: "spectator",
          nextRoundMembership: "active",
        }),
      ])
    );
    expect(lastEvent<SonGuessrPrivateState>(lateJoiner, "song.game.privateState").canGuess).toBe(
      false
    );
    const observerState = await joinRoom(service, observer, "旁观出题人");

    await execute(service, guest, {
      id: "give-up-first-round",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "next-round",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: lateState.playerId, membership: "active" }),
      ])
    );
    await execute(service, host, {
      id: "choose-observer",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: observerState.playerId },
    });
    expect(lastEvent<SonGuessrPrivateState>(observer, "song.game.privateState").canSubmitSong).toBe(
      true
    );
    await execute(service, observer, {
      id: "observer-submits",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound).toMatchObject(
      { submitterPlayerId: observerState.playerId }
    );
    expect(lastEvent<SonGuessrPrivateState>(lateJoiner, "song.game.privateState").canGiveUp).toBe(
      true
    );
  });

  test("0分数的旁观者掉线立即移除", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "spec-host");
    const spectator = connection(service, "spec-spectator");
    await createRoom(service, host);
    const specState = await joinRoom(service, spectator, "旁观者");
    await execute(service, spectator, {
      id: "set-spectator",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });
    expect((service as any).rooms.get("1234")!.players[specState.playerId]).toBeDefined();
    await service.unregisterConnection(spectator.record.id);
    expect((service as any).rooms.get("1234")!.players[specState.playerId]).toBeUndefined();
  });

  test("离线旁观者的下轮参战预约不会阻塞回合", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "offline-queue-host");
    const guest = connection(service, "offline-queue-guest");
    const lateJoiner = connection(service, "offline-queue-late");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);
    const lateState = await joinRoom(service, lateJoiner, "离线预约者");
    // 给该旁观者设置分数，确保不会作为0分旁观者在掉线时被立即移除
    (service as any).rooms.get("1234")!.players[lateState.playerId]!.score = 5;
    await execute(service, lateJoiner, {
      id: "queue-active-while-playing",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: false },
    });
    await service.unregisterConnection(lateJoiner.record.id);
    await execute(service, guest, {
      id: "finish-first-round",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "prepare-next-round",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "choose-next-submitter",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "submit-next-song",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });

    const nextRound = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(nextRound.phase).toBe("playing");
    expect(nextRound.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: lateState.playerId,
          membership: "spectator",
          nextRoundMembership: "active",
          online: false,
        }),
      ])
    );
    await execute(service, guest, {
      id: "finish-next-round",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("roundResult");
  });

  test("手动模式全员预约旁观后回到等待阶段且不创建空回合", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "all-watch-host");
    const guest = connection(service, "all-watch-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);
    for (const client of [host, guest]) {
      await execute(service, client, {
        id: `queue-watch-${client.record.id}`,
        type: "song.player.setSpectator",
        roomId: "1234",
        payload: { spectator: true },
      });
    }
    await execute(service, guest, {
      id: "finish-before-all-watch",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "next-after-all-watch",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });

    const snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.phase).toBe("waiting");
    expect(snapshot.currentRound).toBeUndefined();
    expect(snapshot.hostPlayerId).toBe(hostState.playerId);
    expect(snapshot.players).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: hostState.playerId, membership: "spectator", isHost: true }),
        expect.objectContaining({ id: guestState.playerId, membership: "spectator" }),
      ])
    );
  });

  test("自动模式全员预约旁观后回到等待阶段且不请求下一首歌", async () => {
    let songLoads = 0;
    const autoProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "自动题库", songCount: 1 },
        songs: [songs.answer],
      }),
      getSong: async (id) => {
        songLoads += 1;
        return provider.getSong(id);
      },
    };
    const service = new SonGuessrService({
      musicProvider: autoProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "auto-all-watch-host");
    const guest = connection(service, "auto-all-watch-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "玩家");
    await execute(service, host, {
      id: "auto-all-watch-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionMode: "automatic",
        autoFilters: {
          playlist: { id: "42", name: "自动题库", songCount: 1 },
          artists: [],
          minPopularity: 0,
        },
      },
    });
    await execute(service, guest, {
      id: "auto-all-watch-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "auto-all-watch-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    expect(songLoads).toBe(1);

    for (const client of [host, guest]) {
      await execute(service, client, {
        id: `auto-queue-watch-${client.record.id}`,
        type: "song.player.setSpectator",
        roomId: "1234",
        payload: { spectator: true },
      });
    }
    await execute(service, host, {
      id: "auto-finish-round",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, guest, {
      id: "auto-finish-round-guest",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "auto-next-after-all-watch",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });

    const snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.phase).toBe("waiting");
    expect(snapshot.currentRound).toBeUndefined();
    expect(songLoads).toBe(1);
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

  test("歌名匹配忽略版本信息且共同歌手即可判对", async () => {
    const matchingAnswer = {
      ...songs.answer,
      title: "答案歌（Live Ver.）",
      artist: "歌手甲 / 歌手乙",
    };
    const matchingGuess = {
      ...songs.wrong,
      title: "答案歌 (inst.)",
      artist: "歌手丙 feat. 歌手乙",
    };
    const matchingProvider: MusicProvider = {
      ...provider,
      getSong: async () => matchingAnswer,
      getSongMetadata: async () => matchingGuess,
    };
    const service = new SonGuessrService({
      musicProvider: matchingProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "matching-host");
    const guest = connection(service, "matching-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "匹配玩家");
    await startRound(service, host, guest, hostState.playerId);
    await execute(service, guest, {
      id: "matching-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    const result = (await execute(service, guest, {
      id: "matching-guess",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "different-id" },
    })) as { attempt: { result: string } };
    expect(result.attempt.result).toBe("correct");
  });

  test("歌名匹配会清理裸露及符号包裹的版本后缀", async () => {
    const variants = [
      ["答案歌 feat. 歌手乙", "答案歌"],
      ["答案歌 Remix", "答案歌"],
      ["答案歌 TV Size", "答案歌"],
      ["答案歌 ~~ Live ~~", "答案歌"],
      ["答案歌 -- Remix --", "答案歌"],
      ["答案歌 —— TV Size ——", "答案歌"],
      ["答案歌 ～ Acoustic ～", "答案歌"],
    ] as const;

    for (const [answerTitle, guessTitle] of variants) {
      const matchingProvider: MusicProvider = {
        ...provider,
        getSong: async () => ({ ...songs.answer, title: answerTitle, artist: "歌手甲 / 歌手乙" }),
        getSongMetadata: async () => ({ ...songs.wrong, title: guessTitle, artist: "歌手乙" }),
      };
      const service = new SonGuessrService({
        musicProvider: matchingProvider,
        random: { nextInt: () => 0 },
      });
      const host = connection(service, `variant-host-${answerTitle}`);
      const guest = connection(service, `variant-guest-${answerTitle}`);
      await createRoom(service, host);
      const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
      await joinRoom(service, guest, "版本匹配玩家");
      await startRound(service, host, guest, hostState.playerId);
      await execute(service, guest, {
        id: `variant-audio-${answerTitle}`,
        type: "song.game.audioReady",
        roomId: "1234",
        payload: { roundNumber: 1 },
      });
      const result = (await execute(service, guest, {
        id: `variant-guess-${answerTitle}`,
        type: "song.game.guess",
        roomId: "1234",
        payload: { songId: "different-id" },
      })) as { attempt: { result: string } };
      expect(result.attempt.result).toBe("correct");
    }
  });

  test("不含版本关键词的符号后缀仍属于歌名", async () => {
    const matchingProvider: MusicProvider = {
      ...provider,
      getSong: async () => ({ ...songs.answer, title: "答案歌 -- 第二章", artist: "歌手乙" }),
      getSongMetadata: async () => ({ ...songs.wrong, title: "答案歌", artist: "歌手乙" }),
    };
    const service = new SonGuessrService({
      musicProvider: matchingProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "subtitle-host");
    const guest = connection(service, "subtitle-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "副标题玩家");
    await startRound(service, host, guest, hostState.playerId);
    await execute(service, guest, {
      id: "subtitle-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    const result = (await execute(service, guest, {
      id: "subtitle-guess",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "different-id" },
    })) as { attempt: { result: string } };
    expect(result.attempt.result).toBe("wrong");
  });

  test("手动模式开启自动轮流后直接轮到下一位正式玩家出题", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "rotate-host");
    const guest = connection(service, "rotate-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "轮流玩家");
    await execute(service, host, {
      id: "rotate-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { autoRotateSubmitter: true },
    });
    await startRound(service, host, guest, hostState.playerId);
    await execute(service, guest, {
      id: "rotate-give-up",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "rotate-next",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot")).toMatchObject({
      phase: "submittingSong",
      pendingSubmitterPlayerId: guestState.playerId,
    });
    expect(lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").canSubmitSong).toBe(
      true
    );
  });

  test("玩家可以主动放弃并且只记录一个放弃结果", async () => {
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

    expect(lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").canGiveUp).toBe(true);
    await execute(service, guest, {
      id: "give-up",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    const result = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(result.phase).toBe("roundResult");
    expect(result.roundSummary?.attempts).toEqual([
      expect.objectContaining({ playerName: "玩家", result: "gaveUp" }),
    ]);
    expect(result.roundSummary?.attempts[0]).not.toHaveProperty("guessedSong");
  });

  test("housekeeping 将过期猜测记为超时并在次数耗尽后结算", async () => {
    let now = 10_000;
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => now,
    });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const hostPlayerId = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState").playerId;
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
      id: "settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { maxGuessesPerRound: 1, guessDurationSeconds: 10 },
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
      payload: { playerId: hostPlayerId },
    });
    await execute(service, host, {
      id: "song",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    await execute(service, guest, {
      id: "audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    const originalDeadline = lastEvent<SonGuessrPrivateState>(
      guest,
      "song.game.privateState"
    ).guessDeadlineAt;
    now += 5_000;
    await execute(service, guest, {
      id: "audio-again",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    expect(lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").guessDeadlineAt).toBe(
      originalDeadline
    );

    now += 5_000;
    await service.runHousekeeping();
    const result = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(result.phase).toBe("roundResult");
    expect(result.roundSummary?.attempts[0]).toMatchObject({
      result: "timeout",
      playerName: "玩家",
    });
    // 无人猜中：出题人按硬边界扣 2。
    expect(result.roundSummary?.scores).toEqual(
      expect.arrayContaining([expect.objectContaining({ playerName: "房主", score: -2 })])
    );
  });

  test("房主局中预约旁观在回合结束后依然保持房主身份", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "host-spec-test");
    const guest1 = connection(service, "guest1-spec-test");
    const guest2 = connection(service, "guest2-spec-test");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest1, "玩家1");
    await joinRoom(service, guest2, "玩家2");
    await execute(service, guest1, {
      id: "ready-1",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, guest2, {
      id: "ready-2",
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
      id: "song",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });

    // 房主局中预约下轮旁观
    await execute(service, host, {
      id: "host-queue-spectator",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });

    const queuedSnapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    const hostPlayerBefore = queuedSnapshot.players.find((p) => p.id === hostState.playerId);
    expect(hostPlayerBefore?.nextRoundMembership).toBe("spectator");
    expect(hostPlayerBefore?.isHost).toBe(true);

    // 玩家放弃回合，结算并进入下一轮准备阶段
    await execute(service, guest1, {
      id: "give-up-1",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, guest2, {
      id: "give-up-2",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });

    await execute(service, host, {
      id: "next-round",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });

    const nextSnapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    const hostPlayerAfter = nextSnapshot.players.find((p) => p.id === hostState.playerId);
    expect(hostPlayerAfter?.membership).toBe("spectator");
    expect(hostPlayerAfter?.isHost).toBe(true);
    expect(nextSnapshot.hostPlayerId).toBe(hostState.playerId);
  });

  test("局中点击下轮加入旁观或玩家再次点击可撤销预约", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "toggle-host");
    const guest = connection(service, "toggle-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "玩家");
    await startRound(service, host, guest, hostState.playerId);

    // 玩家第一次点击下轮加入旁观：预约成功
    await execute(service, guest, {
      id: "queue-spec",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });
    let snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(snapshot.players.find((p) => p.id === guestState.playerId)?.nextRoundMembership).toBe(
      "spectator"
    );

    // 玩家第二次点击下轮加入旁观：撤销预约
    await execute(service, guest, {
      id: "cancel-queue-spec",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });
    snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(
      snapshot.players.find((p) => p.id === guestState.playerId)?.nextRoundMembership
    ).toBeUndefined();
  });

  test("「下轮加入」的席位只在再来一轮时生效，选人出题都不算换轮", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "seat-host");
    const guest = connection(service, "seat-guest");
    const other = connection(service, "seat-other");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "预约旁观的玩家");
    await joinRoom(service, other, "另一位玩家");
    for (const client of [guest, other]) {
      await execute(service, client, {
        id: `ready-${client.record.id}`,
        type: "song.player.setReady",
        roomId: "1234",
        payload: { ready: true },
      });
    }
    const seat = (playerId: string) =>
      lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").players.find(
        (player) => player.id === playerId
      );

    await execute(service, host, {
      id: "seat-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "seat-choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "seat-submit",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");

    // 局中预约：只在下一个轮次起点生效
    await execute(service, guest, {
      id: "seat-queue-spectator",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });
    await execute(service, guest, {
      id: "seat-give-up-1",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, other, {
      id: "seat-give-up-2",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    expect(seat(guestState.playerId)).toMatchObject({
      membership: "active",
      nextRoundMembership: "spectator",
    });

    // 点了再来一轮、进入选出题人，这一刻已经是下一轮
    await execute(service, host, {
      id: "seat-next-1",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    const switched = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(switched.phase).toBe("choosingSubmitter");
    expect(seat(guestState.playerId)).toMatchObject({
      membership: "spectator",
      nextRoundMembership: undefined,
    });

    // 选出题人阶段再预约回来：本局选定出题人和提交题目都不能生效
    await execute(service, guest, {
      id: "seat-queue-active",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: false },
    });
    await execute(service, host, {
      id: "seat-choose-2",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "seat-submit-2",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
    expect(seat(guestState.playerId)).toMatchObject({
      membership: "spectator",
      nextRoundMembership: "active",
    });

    await execute(service, other, {
      id: "seat-give-up-3",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "seat-next-2",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    expect(seat(guestState.playerId)).toMatchObject({
      membership: "active",
      nextRoundMembership: undefined,
    });
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
