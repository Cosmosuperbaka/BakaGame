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
import { SonGuessrRoomSnapshot, type SonGuessrPrivateState } from "../../src/shared/Index";

const guessAnswer = (
  service: SonGuessrService,
  client: ReturnType<typeof connection>,
  id: string
) =>
  execute(service, client, {
    id: `guess-${id}`,
    type: "song.game.guess",
    roomId: "1234",
    payload: { songId: "answer" },
  });

/** 三名作答者 + 一名旁观者的血战回合，出题人为房主，全员音频就绪。 */
async function startBloodRound() {
  const service = new SonGuessrService({
    musicProvider: provider,
    random: { nextInt: () => 0 },
  });
  const host = connection(service, "blood-host");
  const first = connection(service, "blood-first");
  const second = connection(service, "blood-second");
  const third = connection(service, "blood-third");
  await createRoom(service, host);
  const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
  const states = [
    await joinRoom(service, first, "第一名"),
    await joinRoom(service, second, "第二名"),
    await joinRoom(service, third, "第三名"),
  ];
  await execute(service, host, {
    id: "blood-settings",
    type: "song.room.updateSettings",
    roomId: "1234",
    payload: { bloodMode: true },
  });
  const guests = [first, second, third];
  // startRound 会替 first 准备，这里只准备另外两位。
  for (const [index, client] of [second, third].entries()) {
    await execute(service, client, {
      id: `ready-${index}`,
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
  }
  await startRound(service, host, first, hostState.playerId);
  for (const [index, client] of guests.entries()) {
    await execute(service, client, {
      id: `audio-${index}`,
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
  }
  return { service, host, guests, states };
}

describe("SonGuessrService", () => {
  test("血战分母开局冻结：先猜中的人离房后，后来者的名次分不会变成负数", async () => {
    const { service, host, guests, states } = await startBloodRound();
    const [first, second, third] = guests;
    await guessAnswer(service, first, "first");
    await guessAnswer(service, second, "second");
    for (const [client, id] of [
      [first, "first"],
      [second, "second"],
    ] as const) {
      await execute(service, client, {
        id: `leave-${id}`,
        type: "song.room.leave",
        roomId: "1234",
        payload: {},
      });
    }

    await guessAnswer(service, third, "third");
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.phase).toBe("roundResult");
    // 第 3 名仍按开局 3 个作答单元计：(3 - 3 + 1) / 3 → round(10 / 3) = 3。
    expect(snapshot.players).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: states[2].playerId, score: 3 })])
    );
    expect(snapshot.roundSummary?.breakdown?.answerableCount).toBe(3);
  });

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
});
