import { describe, expect, test } from "bun:test";

import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  AUDIO_READY_GRACE_MS,
  direction,
  type SonGuessrRoundRecord,
} from "../../src/application/songuessr/Records";
import { AppError } from "../../src/domain/Errors";
import type { GameRoundRecord } from "../../src/domain/GameRecord";
import {
  computeSongAnswererFactors,
  computeSongDifficulty,
  computeSongSubmitterScore,
} from "../../src/domain/SongRules";
import type { EventLogger } from "../../src/infrastructure/EventLogger";
import { fakeBangumiProvider } from "../support/Providers";
import type { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import type {
  BangumiSubjectDetails,
  SonGuessrClientMessage,
  SonGuessrRoomSnapshot,
  SongDetails,
} from "../../src/shared/Index";
import { TEST_ROOMS_ON } from "../TestRoomPolicy";
import {
  anime,
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  makeSong,
  provider,
  songs,
  wrongAnime,
  type TestConnection,
} from "./Fixtures";

/**
 * 回合引擎与计分的边界用例：每条都对着一处「await 之后的复核」「同步占位与回滚」
 * 或计分口径，行为通过命令入口驱动，只在必要时读房间记录里的作答单元。
 */

const defer = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

/** 让已发出的命令走完同步段并停在第一个 await 上。 */
const settleMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let sequence = 0;

interface GameOptions {
  guests?: number;
  settings?: Record<string, unknown>;
  /** 各来宾的队伍号，按来宾序号对应；缺省或 null 表示个人游玩。 */
  teams?: Array<number | null>;
  hostTeam?: number;
  anime?: boolean;
  testRoom?: boolean;
  /** 开局前改题库与来源。 */
  prepare?: (songMap: Record<string, SongDetails>) => void;
  sources?: string[];
  /** 只走到选出题人，由用例自己交歌。 */
  deferSubmit?: boolean;
}

const setupGame = async (options: GameOptions = {}) => {
  let now = 100_000;
  const songMap: Record<string, SongDetails> = { ...songs };
  options.prepare?.(songMap);
  const metadata = {
    impl: (id: string): Promise<SongDetails> => Promise.resolve(songMap[id] ?? songMap.wrong!),
    calls: 0,
  };
  const refresh = {
    impl: (): Promise<string> => Promise.resolve("https://audio/refreshed.mp3"),
    calls: 0,
  };
  const subject = {
    impl: (id: string): Promise<BangumiSubjectDetails> =>
      Promise.resolve(id === anime.id ? anime : wrongAnime),
    calls: 0,
  };
  const musicProvider: MusicProvider = {
    ...provider,
    getSong: async (id) => songMap[id] ?? { ...songMap.answer!, id },
    getSongMetadata: (id) => {
      metadata.calls += 1;
      return metadata.impl(id);
    },
    refreshSongAudio: () => {
      refresh.calls += 1;
      return refresh.impl();
    },
  };
  const bangumiProvider = fakeBangumiProvider({
    getSubject: (id: string) => {
      subject.calls += 1;
      return subject.impl(id);
    },
    searchSubjects: async () => [anime],
  });
  const recorded: GameRoundRecord[] = [];
  const logged: Array<{ type: string; payload?: unknown }> = [];
  const roomId = options.testRoom ? "Oblivionis" : "1234";
  const service = new SonGuessrService({
    musicProvider,
    bangumiProvider,
    random: { nextInt: () => 0 },
    now: () => now,
    gameRecorder: { record: (round) => recorded.push(round), finishRoom: () => {} },
    eventLogger: {
      write: (event: { type: string; payload?: unknown }) => logged.push(event),
      warn: () => {},
    } as unknown as EventLogger,
    ...(options.testRoom ? { testRooms: TEST_ROOMS_ON } : {}),
  });
  const send = <T = unknown>(
    client: TestConnection,
    type: string,
    payload: Record<string, unknown> = {}
  ): Promise<T> =>
    execute<T>(service, client, {
      id: `${type}-${(sequence += 1)}`,
      type,
      roomId,
      payload,
    } as unknown as SonGuessrClientMessage);
  const host = connection(service, `host-${sequence}`);
  await createRoom(service, host, { roomId });
  const hostId = service.rooms.get(roomId)!.hostPlayerId;
  const guests: Array<{ client: TestConnection; id: string }> = [];
  for (let index = 0; index < (options.guests ?? 1); index += 1) {
    const client = connection(service, `guest-${sequence}-${index}`);
    const state = await joinRoom(service, client, `玩家${index}`, roomId);
    guests.push({ client, id: state.playerId });
  }
  await send(host, "song.room.updateSettings", {
    maxGuessesPerRound: 3,
    guessDurationSeconds: 30,
    showGuessTimer: true,
    ...(options.anime ? { questionType: "anime" } : {}),
    ...options.settings,
  });
  if (options.hostTeam !== undefined)
    await send(host, "song.player.setTeam", { team: options.hostTeam });
  for (const [index, guest] of guests.entries()) {
    const team = options.teams?.[index];
    if (team) await send(guest.client, "song.player.setTeam", { team });
    await send(guest.client, "song.player.setReady", { ready: true });
  }
  const startedAt = now;
  const game = {
    service,
    roomId,
    host,
    hostId,
    guests,
    send,
    metadata,
    refresh,
    subject,
    recorded,
    logged,
    songMap,
    bangumiProvider,
    startedAt: () => startedAt,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    room: () => service.rooms.get(roomId)!,
    round: () => service.rooms.get(roomId)!.currentRound!,
    stateOf: (index: number) =>
      service.rooms.get(roomId)!.currentRound!.players[guests[index]!.id]!,
    playerOf: (index: number) => service.rooms.get(roomId)!.players[guests[index]!.id]!,
    ready: (index: number) =>
      send(guests[index]!.client, "song.game.audioReady", { roundNumber: 1 }),
    guess: (index: number, songId: string) =>
      send<{
        attempt: { result: string; guessNumber: number; feedback?: Record<string, unknown> };
      }>(guests[index]!.client, "song.game.guess", { songId }),
    guessAnime: (index: number, subjectId: string) =>
      send<{ attempt: { result: string; guessNumber: number } }>(
        guests[index]!.client,
        "song.game.guessAnime",
        { subjectId }
      ),
    submit: async () => {
      await send(host, "song.game.start");
      await send(host, "song.game.chooseSubmitter", { playerId: hostId });
    },
    deliver: async () => {
      if (options.anime) await send(host, "song.game.submitAnime", { subjectId: anime.id });
      else {
        await send(host, "song.game.submitSong", {
          songId: "answer",
          ...(options.sources ? { sources: options.sources } : {}),
        });
      }
    },
    snapshotOf: (client: TestConnection) =>
      lastEvent<SonGuessrRoomSnapshot>(client, "song.room.snapshot"),
  };
  await game.submit();
  if (!options.deferSubmit) await game.deliver();
  return game;
};

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error("应当被拒绝");
};

const timeoutsOf = (round: SonGuessrRoundRecord, ids?: string[]) =>
  round.attempts.filter(
    (attempt) => attempt.result === "timeout" && (!ids || ids.includes(attempt.playerId))
  );

describe("猜测的同步占位、等待判定与失败回滚", () => {
  test("占位期间同单元再次提交：窗口即便已过期也只报校验中，不补记超时", async () => {
    const game = await setupGame({ guests: 2 });
    await game.ready(0);
    await game.ready(1);
    const pending = defer<SongDetails>();
    game.metadata.impl = () => pending.promise;
    const first = game.guess(0, "wrong");
    await settleMicrotasks();
    expect(game.stateOf(0)).toMatchObject({ inFlight: true, guessesUsed: 1 });

    game.advance(31_000);
    const error = await rejection(game.guess(0, "wrong"));
    expect(error.code).toBe("GUESS_IN_PROGRESS");
    expect(game.stateOf(0).guessesUsed).toBe(1);
    expect(game.round().attempts).toHaveLength(0);

    pending.resolve(songs.wrong);
    await first;
    expect(game.round().attempts.map((attempt) => attempt.result)).toEqual(["wrong"]);
  });

  test("猜番占位期间同单元再次提交：窗口即便已过期也只报校验中，不补记超时", async () => {
    const game = await setupGame({ guests: 2, anime: true });
    await game.ready(0);
    await game.ready(1);
    const pending = defer<BangumiSubjectDetails>();
    game.subject.impl = () => pending.promise;
    const first = game.guessAnime(0, wrongAnime.id);
    await settleMicrotasks();
    expect(game.stateOf(0)).toMatchObject({ inFlight: true, guessesUsed: 1 });

    game.advance(31_000);
    const error = await rejection(game.guessAnime(0, wrongAnime.id));
    expect(error.code).toBe("GUESS_IN_PROGRESS");
    expect(game.stateOf(0).guessesUsed).toBe(1);
    expect(game.round().attempts).toHaveLength(0);

    pending.resolve(wrongAnime);
    await first;
  });

  test("音频未就绪不能猜歌，也不占用次数", async () => {
    const game = await setupGame({ guests: 1 });
    const error = await rejection(game.guess(0, "wrong"));
    expect(error.code).toBe("AUDIO_NOT_READY");
    expect(game.stateOf(0).guessesUsed).toBe(0);
    expect(game.metadata.calls).toBe(0);
  });

  test("回合硬截止已过：提交的猜测只触发整回合结算，不会走到上游", async () => {
    const game = await setupGame({ guests: 1 });
    await game.ready(0);
    game.advance(3 * (30 + 20) * 1_000 + 1_000);
    const error = await rejection(game.guess(0, "answer"));
    expect(error.code).toBe("ROUND_EXPIRED");
    expect(game.metadata.calls).toBe(0);
    expect(game.room().phase).toBe("roundResult");
    expect(game.stateOf(0).guessesUsed).toBe(1);
    expect(game.recorded).toHaveLength(1);
  });

  test("猜番：回合硬截止已过只触发整回合结算，不会走到上游", async () => {
    const game = await setupGame({ guests: 1, anime: true });
    await game.ready(0);
    game.subject.calls = 0;
    game.advance(3 * (30 + 20) * 1_000 + 1_000);
    const error = await rejection(game.guessAnime(0, anime.id));
    expect(error.code).toBe("ROUND_EXPIRED");
    expect(game.subject.calls).toBe(0);
    expect(game.room().phase).toBe("roundResult");
    expect(game.recorded).toHaveLength(1);
  });

  test("补记的超时用尽最后一次机会：按结算后的状态重新校验并拒绝", async () => {
    const game = await setupGame({ guests: 2, settings: { maxGuessesPerRound: 1 } });
    await game.ready(0);
    await game.ready(1);
    game.advance(31_000);
    const error = await rejection(game.guess(0, "answer"));
    expect(error.code).toBe("NO_MORE_GUESSES");
    expect(game.metadata.calls).toBe(0);
    expect(timeoutsOf(game.round())).toHaveLength(1);
  });

  test("猜番：补记的超时用尽最后一次机会，按结算后的状态重新校验并拒绝", async () => {
    const game = await setupGame({ guests: 2, anime: true, settings: { maxGuessesPerRound: 1 } });
    await game.ready(0);
    await game.ready(1);
    game.subject.calls = 0;
    game.advance(31_000);
    const error = await rejection(game.guessAnime(0, anime.id));
    expect(error.code).toBe("NO_MORE_GUESSES");
    expect(game.subject.calls).toBe(0);
  });

  test("补记的超时恰好结束回合：拒绝本次提交，并把结算后的房间发给全房", async () => {
    const game = await setupGame({ guests: 1, settings: { maxGuessesPerRound: 1 } });
    await game.ready(0);
    game.advance(31_000);
    const error = await rejection(game.guess(0, "answer"));
    expect(error.code).toBe("ROUND_EXPIRED");
    expect(game.room().phase).toBe("roundResult");
    expect(game.snapshotOf(game.host).phase).toBe("roundResult");
    expect(game.metadata.calls).toBe(0);
  });

  test("猜番：窗口到期后提交，先补记一次超时再作为新窗口的第一次作答", async () => {
    const game = await setupGame({ guests: 1, anime: true });
    await game.ready(0);
    game.advance(31_000);
    const result = await game.guessAnime(0, wrongAnime.id);
    expect(result.attempt).toMatchObject({ result: "wrong", guessNumber: 2 });
    expect(game.round().attempts.map((attempt) => attempt.result)).toEqual(["timeout", "wrong"]);
  });

  test("上游查询失败：次数、累计猜测数与占位全部回滚，之后可以正常再猜", async () => {
    const game = await setupGame({ guests: 2 });
    await game.ready(0);
    game.metadata.impl = () => Promise.reject(new AppError("MUSIC_API_ERROR", "上游失败"));
    const error = await rejection(game.guess(0, "wrong"));
    expect(error.code).toBe("MUSIC_API_ERROR");
    expect(game.stateOf(0)).toMatchObject({ guessesUsed: 0, inFlight: false });
    expect(game.playerOf(0).totalGuesses).toBe(0);

    game.metadata.impl = (id) => Promise.resolve(songs[id as "wrong"]);
    const retry = await game.guess(0, "wrong");
    expect(retry.attempt.guessNumber).toBe(1);
  });

  test("猜番：上游查询失败时同样整体回滚占位", async () => {
    const game = await setupGame({ guests: 2, anime: true });
    await game.ready(0);
    game.subject.impl = () => Promise.reject(new AppError("BANGUMI_API_ERROR", "上游失败"));
    const error = await rejection(game.guessAnime(0, wrongAnime.id));
    expect(error.code).toBe("BANGUMI_API_ERROR");
    expect(game.stateOf(0)).toMatchObject({ guessesUsed: 0, inFlight: false });
    expect(game.playerOf(0).totalGuesses).toBe(0);
  });

  test("猜番：没有配置 Bangumi 接口时在占位之前拒绝", async () => {
    const game = await setupGame({ guests: 2, anime: true });
    await game.ready(0);
    (game.service.options as { bangumiProvider?: unknown }).bangumiProvider = undefined;
    const error = await rejection(game.guessAnime(0, wrongAnime.id));
    expect(error.code).toBe("BANGUMI_API_UNAVAILABLE");
    expect(game.stateOf(0).guessesUsed).toBe(0);
    expect(game.stateOf(0).inFlight).toBeFalsy();
  });

  test("上游失败时回合已被换掉：只释放占位，不动已结算回合的计数", async () => {
    const game = await setupGame({ guests: 2 });
    await game.ready(0);
    const pending = defer<SongDetails>();
    game.metadata.impl = () => pending.promise;
    const guess = rejection(game.guess(0, "wrong"));
    await settleMicrotasks();
    const state = game.stateOf(0);
    await game.send(game.host, "song.game.skipRound");
    pending.reject(new AppError("MUSIC_API_ERROR", "上游失败"));
    await guess;
    expect(state.inFlight).toBe(false);
    expect(state.guessesUsed).toBe(1);
    expect(game.playerOf(0).totalGuesses).toBe(1);
  });

  describe("await 之后复验房间与回合", () => {
    test("回合在等待期间已结算：拒绝并释放占位，不记录猜测也不计分", async () => {
      const game = await setupGame({ guests: 2 });
      await game.ready(0);
      const pending = defer<SongDetails>();
      game.metadata.impl = () => pending.promise;
      const guess = rejection(game.guess(0, "answer"));
      await settleMicrotasks();
      const state = game.stateOf(0);
      await game.send(game.host, "song.game.skipRound");
      pending.resolve(songs.answer);
      expect((await guess).code).toBe("ROUND_EXPIRED");
      expect(state).toMatchObject({ inFlight: false, correct: false });
      expect(game.round().attempts).toHaveLength(0);
      expect(game.playerOf(0).score).toBe(0);
    });

    test("等待期间已开下一回合：旧回合的猜测作废，新回合的状态与分数不受影响", async () => {
      const game = await setupGame({ guests: 2 });
      await game.ready(0);
      const pending = defer<SongDetails>();
      game.metadata.impl = () => pending.promise;
      const guess = rejection(game.guess(0, "answer"));
      await settleMicrotasks();
      const oldRound = game.round();
      await game.send(game.host, "song.game.skipRound");
      await game.send(game.host, "song.game.nextRound");
      await game.send(game.host, "song.game.chooseSubmitter", { playerId: game.hostId });
      await game.send(game.host, "song.game.submitSong", { songId: "answer" });
      expect(game.round()).not.toBe(oldRound);
      pending.resolve(songs.answer);
      expect((await guess).code).toBe("ROUND_EXPIRED");
      expect(oldRound.attempts).toHaveLength(0);
      expect(game.playerOf(0).score).toBe(0);
      expect(game.playerOf(0).correctGuesses).toBe(0);
      expect(game.round().attempts).toHaveLength(0);
    });

    test("等待期间玩家被踢：旧猜测作废，回合继续", async () => {
      const game = await setupGame({ guests: 2 });
      await game.ready(0);
      await game.ready(1);
      const pending = defer<SongDetails>();
      game.metadata.impl = () => pending.promise;
      const guess = rejection(game.guess(0, "answer"));
      await settleMicrotasks();
      const round = game.round();
      const state = game.stateOf(0);
      await game.send(game.host, "song.room.kick", { playerId: game.guests[0]!.id });
      pending.resolve(songs.answer);
      expect((await guess).code).toBe("ROUND_EXPIRED");
      expect(state.inFlight).toBe(false);
      expect(round.attempts).toHaveLength(0);
      expect(round.correctPlayerIds).toEqual([]);
      expect(game.room().phase).toBe("playing");
    });

    test("猜番：等待期间回合已结算，旧猜测作废", async () => {
      const game = await setupGame({ guests: 2, anime: true });
      await game.ready(0);
      const pending = defer<BangumiSubjectDetails>();
      game.subject.impl = () => pending.promise;
      const guess = rejection(game.guessAnime(0, anime.id));
      await settleMicrotasks();
      const state = game.stateOf(0);
      await game.send(game.host, "song.game.skipRound");
      pending.resolve(anime);
      expect((await guess).code).toBe("ROUND_EXPIRED");
      expect(state).toMatchObject({ inFlight: false, correct: false });
      expect(game.round().attempts).toHaveLength(0);
      expect(game.playerOf(0).score).toBe(0);
    });

    test("猜番：等待期间玩家被踢，旧猜测作废", async () => {
      const game = await setupGame({ guests: 2, anime: true });
      await game.ready(0);
      await game.ready(1);
      const pending = defer<BangumiSubjectDetails>();
      game.subject.impl = () => pending.promise;
      const guess = rejection(game.guessAnime(0, anime.id));
      await settleMicrotasks();
      const round = game.round();
      await game.send(game.host, "song.room.kick", { playerId: game.guests[0]!.id });
      pending.resolve(anime);
      expect((await guess).code).toBe("ROUND_EXPIRED");
      expect(round.attempts).toHaveLength(0);
      expect(game.room().phase).toBe("playing");
    });
  });

  test("作答状态缺失时猜歌走自愈：补回状态后照常作答", async () => {
    const game = await setupGame({ guests: 2 });
    await game.ready(0);
    delete game.round().players[game.guests[0]!.id];
    const result = await game.guess(0, "wrong");
    expect(result.attempt.result).toBe("wrong");
    expect(game.round().players[game.guests[0]!.id]).toBeDefined();
  });

  test("作答状态缺失时报就绪也走自愈，并回传倒计时", async () => {
    const game = await setupGame({ guests: 2 });
    delete game.round().players[game.guests[0]!.id];
    const result = await game.ready(0);
    expect(result).toMatchObject({ deadlineAt: expect.any(Number) });
    expect(game.round().audioReady[game.guests[0]!.id]).toBe(true);
  });
});

describe("队伍共用同一个作答状态对象", () => {
  test("同队成员持有同一份状态：一人占位、猜中，队友读到的就是同一份", async () => {
    const game = await setupGame({ guests: 3, teams: [1, 1, null], settings: { bloodMode: true } });
    for (const index of [0, 1, 2]) await game.ready(index);
    const round = game.round();
    expect(round.players[game.guests[0]!.id]).toBe(round.players[game.guests[1]!.id]!);
    expect(round.players[game.guests[2]!.id]).not.toBe(round.players[game.guests[0]!.id]!);

    // 占位：队友在上游校验期间看到的是「队友正在提交」，次数也是同一份。
    const pending = defer<SongDetails>();
    game.metadata.impl = () => pending.promise;
    const first = game.guess(0, "answer");
    await settleMicrotasks();
    expect(game.stateOf(1)).toMatchObject({ inFlight: true, guessesUsed: 1 });
    const blocked = await rejection(game.guess(1, "wrong"));
    expect(blocked).toMatchObject({
      code: "GUESS_IN_PROGRESS",
      message: "队友正在提交猜测，请稍候",
    });

    pending.resolve(songs.answer);
    await first;
    // 猜中：队友那一头同时变成已猜中，不是各自一份拷贝。
    expect(game.stateOf(1)).toMatchObject({
      correct: true,
      inFlight: false,
      deadlineAt: undefined,
    });
    expect(game.round().players[game.guests[1]!.id]).toBe(
      game.round().players[game.guests[0]!.id]!
    );
    const teammate = await rejection(game.guess(1, "wrong"));
    expect(teammate).toMatchObject({ code: "ALREADY_CORRECT", message: "队友已经猜中了" });
  });

  test("同队一人猜中、另一人放弃：提示按「本队」措辞", async () => {
    const game = await setupGame({ guests: 3, teams: [1, 1, null], settings: { bloodMode: true } });
    for (const index of [0, 1, 2]) await game.ready(index);
    await game.guess(0, "answer");
    const error = await rejection(game.send(game.guests[1]!.client, "song.game.giveUp"));
    expect(error).toMatchObject({ code: "ALREADY_CORRECT", message: "本队已经猜中了" });
  });

  test("同队一人放弃：队友再猜时提示本队已放弃", async () => {
    const game = await setupGame({ guests: 3, teams: [1, 1, null], settings: { bloodMode: true } });
    for (const index of [0, 1, 2]) await game.ready(index);
    await game.send(game.guests[0]!.client, "song.game.giveUp");
    expect(game.stateOf(1).gaveUp).toBe(true);
    const error = await rejection(game.guess(1, "wrong"));
    expect(error).toMatchObject({ code: "ALREADY_GAVE_UP", message: "本队已经放弃本回合" });
  });

  test("出题人的队友观战：猜番命令报队友观战", async () => {
    const game = await setupGame({ guests: 2, teams: [1, null], hostTeam: 1, anime: true });
    await game.ready(1);
    const error = await rejection(game.guessAnime(0, anime.id));
    expect(error.code).toBe("TEAM_OBSERVER");
  });

  test("队伍超时：队员不全在线时只按在线人数扣次数", async () => {
    const game = await setupGame({
      guests: 3,
      teams: [1, 1, null],
      settings: { guessDurationSeconds: 10 },
    });
    for (const index of [0, 1, 2]) await game.ready(index);
    await game.service.unregisterConnection(game.guests[1]!.client.record.id);
    game.advance(11_000);
    await game.service.runHousekeeping();
    const ids = [game.guests[0]!.id, game.guests[1]!.id];
    const timeouts = timeoutsOf(game.round(), ids);
    expect(timeouts.map((attempt) => attempt.playerId)).toEqual([game.guests[0]!.id]);
    expect(game.stateOf(0).guessesUsed).toBe(1);
    expect(game.playerOf(0).totalGuesses).toBe(1);
    expect(game.playerOf(1).totalGuesses).toBe(0);
  });

  test("队伍超时：扣的次数不超过剩余次数", async () => {
    const game = await setupGame({
      guests: 3,
      teams: [1, 1, null],
      settings: { guessDurationSeconds: 10, maxGuessesPerRound: 1 },
    });
    for (const index of [0, 1, 2]) await game.ready(index);
    game.advance(11_000);
    await game.service.runHousekeeping();
    const ids = [game.guests[0]!.id, game.guests[1]!.id];
    expect(timeoutsOf(game.round(), ids)).toHaveLength(1);
    expect(game.stateOf(0).guessesUsed).toBe(1);
  });

  test("队伍超时：队员全部离线时仍扣一次，记在第一位队员名下", async () => {
    const game = await setupGame({
      guests: 3,
      teams: [1, 1, null],
      settings: { guessDurationSeconds: 10 },
    });
    for (const index of [0, 1, 2]) await game.ready(index);
    await game.service.unregisterConnection(game.guests[0]!.client.record.id);
    await game.service.unregisterConnection(game.guests[1]!.client.record.id);
    game.advance(11_000);
    await game.service.runHousekeeping();
    const ids = [game.guests[0]!.id, game.guests[1]!.id];
    expect(timeoutsOf(game.round(), ids).map((attempt) => attempt.playerId)).toEqual([
      game.guests[0]!.id,
    ]);
  });
});

describe("放弃与跳过", () => {
  test("血战里已猜中的人不能再放弃", async () => {
    const game = await setupGame({ guests: 2, settings: { bloodMode: true } });
    await game.ready(0);
    await game.ready(1);
    await game.guess(0, "answer");
    const error = await rejection(game.send(game.guests[0]!.client, "song.game.giveUp"));
    expect(error).toMatchObject({ code: "ALREADY_CORRECT", message: "你已经猜对了" });
    expect(game.stateOf(0).deadlineAt).toBeUndefined();
  });

  test("放弃后倒计时清空，再次放弃被拒；放弃记录的序号接在已用次数之后", async () => {
    const game = await setupGame({ guests: 2 });
    await game.ready(0);
    await game.ready(1);
    await game.guess(0, "wrong");
    await game.send(game.guests[0]!.client, "song.game.giveUp");
    expect(game.stateOf(0).deadlineAt).toBeUndefined();
    const gaveUp = game.round().attempts.at(-1)!;
    expect(gaveUp).toMatchObject({ result: "gaveUp", guessNumber: 2 });
    const error = await rejection(game.send(game.guests[0]!.client, "song.game.giveUp"));
    expect(error).toMatchObject({ code: "ROUND_ACTION_FINISHED", message: "你已完成本回合操作" });
    const again = await rejection(game.guess(0, "wrong"));
    expect(again.code).toBe("ALREADY_GAVE_UP");
  });

  test("次数用尽后再猜被拒", async () => {
    const game = await setupGame({ guests: 2, settings: { maxGuessesPerRound: 1 } });
    await game.ready(0);
    await game.ready(1);
    await game.guess(0, "wrong");
    const error = await rejection(game.guess(0, "wrong"));
    expect(error.code).toBe("NO_MORE_GUESSES");
    expect(game.stateOf(0).deadlineAt).toBeUndefined();
  });

  test("跳过回合清空全员倒计时，且出题人不得分", async () => {
    const game = await setupGame({ guests: 2 });
    await game.ready(0);
    await game.ready(1);
    expect(game.stateOf(1).deadlineAt).toBeDefined();
    await game.send(game.host, "song.game.skipRound");
    expect(game.stateOf(0).deadlineAt).toBeUndefined();
    expect(game.stateOf(1).deadlineAt).toBeUndefined();
    expect(game.room().players[game.hostId]!.score).toBe(0);
  });
});

describe("音频就绪与刷新", () => {
  test("开局加载在途或轮次号不符时，就绪通知被忽略", async () => {
    const game = await setupGame({ guests: 1 });
    expect(
      await game.send(game.guests[0]!.client, "song.game.audioReady", { roundNumber: 99 })
    ).toEqual({ ignored: true });
    game.room().runtime = { ...game.room().runtime, automaticRoundLoading: true };
    expect(await game.ready(0)).toEqual({ ignored: true });
    expect(game.round().audioReady[game.guests[0]!.id]).toBe(false);
  });

  test("刷新播放地址：旧轮次号、非猜歌阶段与旁观者一律忽略，不打上游", async () => {
    const game = await setupGame({ guests: 1 });
    const failed = (roundNumber: number, client = game.guests[0]!.client) =>
      game.send(client, "song.game.audioFailed", { roundNumber });
    expect(await failed(99)).toEqual({ ignored: true });
    const watcher = connection(game.service, "watcher-failed");
    await joinRoom(game.service, watcher, "旁观者", game.roomId);
    expect(await failed(1, watcher)).toEqual({ ignored: true });
    expect(game.refresh.calls).toBe(0);
    await game.send(game.host, "song.game.skipRound");
    expect(await failed(1)).toEqual({ ignored: true });
    expect(game.refresh.calls).toBe(0);
  });

  test("刷新播放地址等待期间回合已结算：不写回新地址", async () => {
    const game = await setupGame({ guests: 1 });
    const pending = defer<string>();
    game.refresh.impl = () => pending.promise;
    const before = game.round().song.audioUrl;
    const refresh = game.send(game.guests[0]!.client, "song.game.audioFailed", { roundNumber: 1 });
    await settleMicrotasks();
    expect(game.refresh.calls).toBe(1);
    await game.send(game.host, "song.game.skipRound");
    pending.resolve("https://audio/late.mp3");
    expect(await refresh).toEqual({ ignored: true });
    expect(game.round().song.audioUrl).toBe(before);
  });
});

describe("巡检里的回合结算", () => {
  test("补就绪与判超时必须在同一轮巡检里都跑完", async () => {
    const game = await setupGame({ guests: 2, settings: { guessDurationSeconds: 10 } });
    await game.ready(1);
    game.advance(AUDIO_READY_GRACE_MS + 1_000);
    await game.service.runHousekeeping();
    expect(game.round().audioReady[game.guests[0]!.id]).toBe(true);
    expect(game.stateOf(1).guessesUsed).toBe(1);
    expect(timeoutsOf(game.round()).map((attempt) => attempt.playerId)).toEqual([
      game.guests[1]!.id,
    ]);
  });

  test("补就绪以首个就绪玩家定下的宽限为准，不用回合开始时的旧宽限", async () => {
    const game = await setupGame({ guests: 2 });
    game.advance(10_000);
    await game.ready(1);
    game.advance(6_000);
    await game.service.runHousekeeping();
    expect(game.round().audioReady[game.guests[0]!.id]).toBe(false);
    game.advance(AUDIO_READY_GRACE_MS);
    await game.service.runHousekeeping();
    expect(game.round().audioReady[game.guests[0]!.id]).toBe(true);
  });

  test("补就绪不碰已经放弃的单元", async () => {
    const game = await setupGame({ guests: 2 });
    await game.send(game.guests[0]!.client, "song.game.giveUp");
    game.advance(AUDIO_READY_GRACE_MS + 1_000);
    await game.service.runHousekeeping();
    expect(game.round().audioReady[game.guests[0]!.id]).toBe(false);
    expect(game.round().audioReady[game.guests[1]!.id]).toBe(true);
  });

  test("硬截止到点：没有倒计时的单元也被强制记超时并结算", async () => {
    const game = await setupGame({ guests: 2, settings: { showGuessTimer: false } });
    await game.ready(0);
    await game.ready(1);
    game.advance(3 * (30 + 20) * 1_000 + 1_000);
    await game.service.runHousekeeping();
    expect(game.room().phase).toBe("roundResult");
    expect(game.room().roundSummary!.attempts.filter((a) => a.result === "timeout")).toHaveLength(
      2
    );
  });

  test("硬截止到点：已猜中的单元不会再被记超时", async () => {
    const game = await setupGame({ guests: 2, settings: { bloodMode: true } });
    await game.ready(0);
    await game.ready(1);
    await game.guess(0, "answer");
    game.advance(3 * (30 + 20) * 1_000 + 1_000);
    await game.service.runHousekeeping();
    expect(game.room().phase).toBe("roundResult");
    expect(game.stateOf(0).guessesUsed).toBe(1);
    expect(timeoutsOf(game.round()).map((attempt) => attempt.playerId)).toEqual([
      game.guests[1]!.id,
    ]);
  });

  test("记超时用尽次数后清掉倒计时", async () => {
    const game = await setupGame({
      guests: 2,
      settings: { guessDurationSeconds: 10, maxGuessesPerRound: 1 },
    });
    // 乙还没就绪，回合不会因为甲的超时而结束，倒计时的清理只能出自「次数用尽」本身。
    await game.ready(0);
    game.advance(11_000);
    await game.service.runHousekeeping();
    expect(game.room().phase).toBe("playing");
    expect(game.stateOf(0).guessesUsed).toBe(1);
    expect(game.stateOf(0).deadlineAt).toBeUndefined();
  });

  test("到期结算与手动结算先后发生：只结算一次，对局记录与出题人分数不重复", async () => {
    const game = await setupGame({ guests: 2, settings: { bloodMode: true } });
    await game.ready(0);
    await game.ready(1);
    await game.guess(0, "answer");
    await game.send(game.host, "song.game.skipRound");
    const hostScore = game.room().players[game.hostId]!.score;
    game.advance(3 * (30 + 20) * 1_000 + 1_000);
    await game.service.runHousekeeping();
    await game.service.runHousekeeping();
    expect(game.recorded).toHaveLength(1);
    expect(game.room().players[game.hostId]!.score).toBe(hostScore);
    expect(game.room().phase).toBe("roundResult");
  });

  test("结算前回合是否完整：没有变化的巡检不会提前收回合", async () => {
    const game = await setupGame({ guests: 2 });
    await game.ready(0);
    await game.ready(1);
    game.advance(1_000);
    await game.service.runHousekeeping();
    expect(game.room().phase).toBe("playing");
  });
});

describe("回合完整性的各条触发路径", () => {
  test("缺作答状态的人按已完成处理，不拖住回合", async () => {
    const game = await setupGame({ guests: 2, settings: { bloodMode: true } });
    await game.ready(0);
    await game.ready(1);
    delete game.round().players[game.guests[1]!.id];
    await game.guess(0, "answer");
    expect(game.room().phase).toBe("roundResult");
  });

  test("最后一个未完成的人离房：回合随即结算", async () => {
    const game = await setupGame({ guests: 2, settings: { bloodMode: true } });
    await game.ready(0);
    await game.ready(1);
    await game.guess(0, "answer");
    expect(game.room().phase).toBe("playing");
    await game.send(game.guests[1]!.client, "song.room.leave");
    expect(game.room().phase).toBe("roundResult");
  });

  test("最后一个未完成的人被踢：回合随即结算", async () => {
    const game = await setupGame({ guests: 2, settings: { bloodMode: true } });
    await game.ready(0);
    await game.ready(1);
    await game.guess(0, "answer");
    await game.send(game.host, "song.room.kick", { playerId: game.guests[1]!.id });
    expect(game.room().phase).toBe("roundResult");
  });
});

describe("逐轮结局标记与对局记录", () => {
  test("四种结局各得其标记；被踢的人不产生标记", async () => {
    const game = await setupGame({
      guests: 5,
      settings: { bloodMode: true, maxGuessesPerRound: 1 },
    });
    for (const index of [0, 1, 2, 3, 4]) await game.ready(index);
    await game.guess(0, "answer");
    await game.send(game.guests[1]!.client, "song.game.giveUp");
    await game.guess(2, "wrong");
    await game.send(game.host, "song.room.kick", { playerId: game.guests[4]!.id });
    await game.send(game.host, "song.game.skipRound");
    const marks = (index: number) => game.playerOf(index).roundMarks;
    expect(marks(0)).toEqual(["correct"]);
    expect(marks(1)).toEqual(["gaveUp"]);
    expect(marks(2)).toEqual(["outOfGuesses"]);
    expect(marks(3)).toEqual(["timeout"]);
    expect(marks(4)).toEqual([]);
  });

  test("对局记录：跳过标记、时间线、番剧摘要与账号一并写全", async () => {
    const game = await setupGame({ guests: 2, anime: true });
    await game.ready(0);
    await game.ready(1);
    game.playerOf(0).account = { userId: "user-1" } as never;
    await game.guessAnime(0, wrongAnime.id);
    game.advance(5_000);
    await game.send(game.host, "song.game.skipRound");
    const record = game.recorded[0]!;
    expect(record).toMatchObject({
      game: "song",
      roundNumber: 1,
      startedAt: game.startedAt(),
      endedAt: game.now(),
    });
    expect(record.summary).toMatchObject({
      questionType: "anime",
      anime: { id: anime.id, name: anime.name, nameCn: anime.nameCn },
      submitter: "房主",
      skipped: true,
      correct: [],
    });
    expect(record.timeline).toEqual([
      expect.objectContaining({ type: "guess", result: "wrong", anime: wrongAnime.nameCn }),
    ]);
    expect(record.players.find((player) => player.name === "玩家0")?.userId).toBe("user-1");
  });

  test("对局记录：猜歌的时间线带歌名与歌手，猜中者与得分入账", async () => {
    const game = await setupGame({ guests: 2, settings: { bloodMode: true } });
    await game.ready(0);
    await game.ready(1);
    await game.guess(0, "wrong");
    await game.guess(0, "answer");
    await game.send(game.guests[1]!.client, "song.game.giveUp");
    const record = game.recorded[0]!;
    expect(record.summary).toMatchObject({
      questionType: "song",
      skipped: false,
      correct: ["玩家0"],
      submitter: "房主",
    });
    expect(record.timeline.map((item) => item.song ?? item.result)).toEqual([
      `${songs.wrong.title} - ${songs.wrong.artist}`,
      `${songs.answer.title} - ${songs.answer.artist}`,
      "gaveUp",
    ]);
    const scoreOf = (name: string) => record.players.find((player) => player.name === name)!.score;
    expect(scoreOf("玩家0")).toBeGreaterThan(0);
    expect(
      game.logged.find((event) => event.type === "song.game.round_finished")?.payload
    ).toMatchObject({
      roundNumber: 1,
      correctCount: 1,
    });
  });
});

describe("计分口径", () => {
  test("用时占比从首名玩家能答题起算，且猜中后清掉全队倒计时", async () => {
    const game = await setupGame({ guests: 2, settings: { bloodMode: false } });
    game.advance(10_000);
    await game.ready(0);
    await game.ready(1);
    game.advance(15_000);
    await game.guess(0, "answer");
    const expected = computeSongAnswererFactors({
      bloodMode: false,
      rank: 1,
      answerableCount: 2,
      elapsedRatio: 15_000 / 30_000,
      guessesUsed: 1,
      maxGuessesPerRound: 3,
    });
    expect(game.playerOf(0).score).toBe(expected.score);
    expect(game.stateOf(0).deadlineAt).toBeUndefined();
    // 对照：若从回合开始起算（25 秒），得分必然不同，否则这条用例守不住起点。
    const wrongStart = computeSongAnswererFactors({
      bloodMode: false,
      rank: 1,
      answerableCount: 2,
      elapsedRatio: 25_000 / 30_000,
      guessesUsed: 1,
      maxGuessesPerRound: 3,
    });
    expect(wrongStart.score).not.toBe(expected.score);
  });

  test("难度分与出题人得分：取猜中那一次的用时、总尝试数与平均答题分", async () => {
    const game = await setupGame({ guests: 2, settings: { bloodMode: true } });
    game.advance(10_000);
    await game.ready(0);
    await game.ready(1);
    game.advance(3_000);
    await game.guess(0, "wrong");
    game.advance(6_000);
    await game.guess(0, "answer");
    game.advance(3_000);
    await game.guess(1, "answer");
    const summary = game.room().roundSummary!;
    const factors = summary.breakdown!.players;
    const difficulty = computeSongDifficulty({
      answerableCount: 2,
      correctCount: 2,
      totalAttempts: 3,
      correctElapsedRatios: [9_000 / 30_000, 12_000 / 30_000],
      maxGuessesPerRound: 3,
    });
    expect(summary.breakdown!.difficulty).toBe(difficulty);
    expect(summary.breakdown!.answerableCount).toBe(2);
    const expectedSubmitter = computeSongSubmitterScore({
      answerableCount: 2,
      correctCount: 2,
      averageAnswererScore: (factors[0]!.score + factors[1]!.score) / 2,
      difficulty,
    });
    expect(summary.scores.find((score) => score.playerId === game.hostId)?.delta).toBe(
      expectedSubmitter
    );
    expect(expectedSubmitter).toBeGreaterThan(0);
  });

  test("用时超过单次时限的猜中，难度分里的用时占比夹到 1", async () => {
    const game = await setupGame({ guests: 2, settings: { bloodMode: true } });
    game.advance(10_000);
    await game.ready(0);
    await game.ready(1);
    game.advance(31_000);
    await game.guess(0, "answer");
    await game.send(game.guests[1]!.client, "song.game.giveUp");
    const summary = game.room().roundSummary!;
    expect(summary.breakdown!.difficulty).toBe(
      computeSongDifficulty({
        answerableCount: 2,
        correctCount: 1,
        totalAttempts: 2,
        correctElapsedRatios: [1],
        maxGuessesPerRound: 3,
      })
    );
  });

  test("测试房：人机不进作答单元，出题人自己可答所以计入", async () => {
    const game = await setupGame({ guests: 1, testRoom: true, deferSubmit: true });
    await game.send(game.host, "song.test.addBot", { count: 1 });
    await game.deliver();
    await game.ready(0);
    await game.guess(0, "answer");
    const summary = game.room().roundSummary!;
    expect(summary.breakdown!.answerableCount).toBe(2);
  });

  test("猜歌反馈：方向、共同标签与语言匹配都按猜测对答案计算", async () => {
    const game = await setupGame({
      guests: 1,
      prepare: (songMap) => {
        songMap.answer = {
          ...songMap.answer!,
          language: "English",
          encyclopedia: { summary: "百科", tags: ["POP", "answer"] },
        };
        songMap.wrong = {
          ...makeSong("wrong", "错误歌", 2018),
          language: "english",
          encyclopedia: { summary: "百科", tags: ["pop", "wrong"] },
        };
      },
    });
    await game.ready(0);
    const { attempt } = await game.guess(0, "wrong");
    expect(attempt.feedback).toEqual({
      releaseYear: 2018,
      releaseYearDirection: direction(2018, 2022),
      popularity: 60,
      popularityDirection: direction(60, 90),
      languageMatch: true,
      sharedTags: ["pop"],
    });
    expect(direction(2018, 2022)).not.toBe(direction(2022, 2018));
  });

  test("备用音源的歌也算猜对", async () => {
    const game = await setupGame({
      guests: 1,
      sources: ["answer", "alt-source"],
      prepare: (songMap) => {
        songMap["alt-source"] = { ...makeSong("alt-source", "完全不同的歌名", 2001) };
      },
    });
    expect(game.round().alternateSongIds).toEqual(["alt-source"]);
    await game.ready(0);
    const { attempt } = await game.guess(0, "alt-source");
    expect(attempt.result).toBe("correct");
  });
});
