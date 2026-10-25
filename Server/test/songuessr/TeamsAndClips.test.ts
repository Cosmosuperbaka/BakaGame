import { AppError } from "../../src/domain/Errors";
import { MusicProvider } from "../../src/infrastructure/NeteaseMusicProvider";
import { describe, expect, test } from "bun:test";
import {
  TestConnection,
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  provider,
  songs,
} from "./Fixtures";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  createManualLyricClip,
  createSongLyricClip,
} from "../../src/application/songuessr/LyricClip";
import { SonGuessrPrivateState, type SonGuessrRoomSnapshot } from "../../src/shared/Index";

describe("SonGuessr 组队", () => {
  const setTeam = (service: SonGuessrService, client: TestConnection, team: number | null) =>
    execute(service, client, {
      id: `team-${client.record.id}-${team}`,
      type: "song.player.setTeam",
      roomId: "1234",
      payload: { team },
    });
  const ready = (service: SonGuessrService, client: TestConnection) =>
    execute(service, client, {
      id: `ready-${client.record.id}`,
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
  const audio = (service: SonGuessrService, client: TestConnection) =>
    execute(service, client, {
      id: `audio-${client.record.id}`,
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
  const guess = (service: SonGuessrService, client: TestConnection, songId: string) =>
    execute(service, client, {
      id: `guess-${client.record.id}-${songId}`,
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId },
    });
  const privateOf = (client: TestConnection) =>
    lastEvent<SonGuessrPrivateState>(client, "song.game.privateState");
  const playerOf = (client: TestConnection, playerId: string) =>
    lastEvent<SonGuessrRoomSnapshot>(client, "song.room.snapshot").players.find(
      (player) => player.id === playerId
    )!;

  /** 房主个人出题；甲乙同在 1 队，丙个人游玩。 */
  const setup = async (settings: Record<string, unknown> = {}) => {
    let now = 10_000;
    const service = new SonGuessrService({
      musicProvider: provider,
      random: { nextInt: () => 0 },
      now: () => now,
    });
    const host = connection(service, "team-host");
    const a = connection(service, "team-a");
    const b = connection(service, "team-b");
    const c = connection(service, "team-c");
    await createRoom(service, host);
    const hostId = privateOf(host).playerId;
    const aId = (await joinRoom(service, a, "甲")).playerId;
    const bId = (await joinRoom(service, b, "乙")).playerId;
    const cId = (await joinRoom(service, c, "丙")).playerId;
    await setTeam(service, a, 1);
    await setTeam(service, b, 1);
    if (Object.keys(settings).length) {
      await execute(service, host, {
        id: "team-settings",
        type: "song.room.updateSettings",
        roomId: "1234",
        payload: settings,
      });
    }
    for (const client of [a, b, c]) await ready(service, client);
    return {
      service,
      host,
      a,
      b,
      c,
      hostId,
      aId,
      bId,
      cId,
      advance: (ms: number) => {
        now += ms;
      },
    };
  };
  const play = async (
    ctx: Awaited<ReturnType<typeof setup>>,
    submitterId: string,
    submitter: TestConnection
  ) => {
    await execute(ctx.service, ctx.host, {
      id: "team-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(ctx.service, ctx.host, {
      id: "team-choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: submitterId },
    });
    await execute(ctx.service, submitter, {
      id: "team-submit",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
  };

  test("队伍只在等待阶段由参与玩家选择，旁观会清掉队伍", async () => {
    const ctx = await setup();
    expect(playerOf(ctx.host, ctx.aId).team).toBe(1);
    await execute(ctx.service, ctx.a, {
      id: "spectate",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });
    expect(playerOf(ctx.host, ctx.aId)).toMatchObject({ membership: "spectator", team: null });
    await expect(setTeam(ctx.service, ctx.a, 2)).rejects.toMatchObject({
      code: "SPECTATOR_FORBIDDEN",
    });
    await execute(ctx.service, ctx.a, {
      id: "back",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: false },
    });
    await ready(ctx.service, ctx.a);
    await setTeam(ctx.service, ctx.a, 1);
    await play(ctx, ctx.hostId, ctx.host);
    await expect(setTeam(ctx.service, ctx.c, 2)).rejects.toMatchObject({ code: "INVALID_PHASE" });
  });

  test("同队共用次数与猜测记录，一人猜中全队结束，分数只记给猜中者", async () => {
    const ctx = await setup({ maxGuessesPerRound: 3 });
    await play(ctx, ctx.hostId, ctx.host);
    for (const client of [ctx.a, ctx.b, ctx.c]) await audio(ctx.service, client);

    await guess(ctx.service, ctx.a, "wrong");
    // 乙看得到队友这一次，次数一起少了一次；别队的丙看不到
    expect(privateOf(ctx.b)).toMatchObject({ remainingGuesses: 2 });
    expect(privateOf(ctx.b).visibleAttempts.map((attempt) => attempt.playerId)).toEqual([ctx.aId]);
    expect(privateOf(ctx.c)).toMatchObject({ remainingGuesses: 3, visibleAttempts: [] });

    await guess(ctx.service, ctx.b, "answer");
    // 本队第 2 次才猜中（精度 2/3），非血战速度按用时趋近满分 → round(10×1.2×2/3)=8。
    expect(playerOf(ctx.host, ctx.bId)).toMatchObject({ roundStatus: "correct", score: 8 });
    expect(playerOf(ctx.host, ctx.aId)).toMatchObject({ roundStatus: "teamCorrect", score: 0 });
    expect(privateOf(ctx.a)).toMatchObject({ canGuess: false, canGiveUp: false });
    // 没开血战：一名玩家猜对就把整局结束，队友与别队都不再有机会作答
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(ctx.host, "song.room.snapshot");
    expect(snapshot.phase).toBe("roundResult");
    await expect(guess(ctx.service, ctx.a, "answer")).rejects.toMatchObject({
      code: "NO_ACTIVE_ROUND",
    });
    await expect(guess(ctx.service, ctx.c, "wrong")).rejects.toMatchObject({
      code: "NO_ACTIVE_ROUND",
    });
    const summary = snapshot.roundSummary!;
    expect(summary.correctPlayerIds).toEqual([ctx.bId]);
    // 出题人按难度分结算：2 个单元里 1 个猜中、总共试了 2 次 → round(8×1.0×0.55)=4
    expect(summary.scores.find((score) => score.playerId === ctx.hostId)?.delta).toBe(4);
  });

  test("血战开启时猜中只结束所在队，队友不能再猜，别队继续作答", async () => {
    const ctx = await setup({ maxGuessesPerRound: 3, bloodMode: true });
    await play(ctx, ctx.hostId, ctx.host);
    for (const client of [ctx.a, ctx.b, ctx.c]) await audio(ctx.service, client);

    await guess(ctx.service, ctx.b, "answer");
    expect(playerOf(ctx.host, ctx.bId)).toMatchObject({ roundStatus: "correct" });
    expect(playerOf(ctx.host, ctx.aId)).toMatchObject({ roundStatus: "teamCorrect" });
    await expect(guess(ctx.service, ctx.a, "answer")).rejects.toMatchObject({
      code: "ALREADY_CORRECT",
      message: "队友已经猜中了",
    });
    // 丙还在猜，回合不结束
    expect(lastEvent<SonGuessrRoomSnapshot>(ctx.host, "song.room.snapshot").phase).toBe("playing");

    await execute(ctx.service, ctx.c, {
      id: "give-up",
      type: "song.game.giveUp",
      roomId: "1234",
      payload: {},
    });
    const summary = lastEvent<SonGuessrRoomSnapshot>(ctx.host, "song.room.snapshot").roundSummary!;
    expect(summary.correctPlayerIds).toEqual([ctx.bId]);
  });

  test("出题人的队友本局观战：看得到答案与全房猜测，不能作答，也不拖住回合", async () => {
    const ctx = await setup();
    await setTeam(ctx.service, ctx.host, 1);
    await play(ctx, ctx.aId, ctx.a);
    expect(privateOf(ctx.b)).toMatchObject({
      teamObserver: true,
      canGuess: false,
      submittedSong: { id: "answer" },
    });
    expect(playerOf(ctx.host, ctx.bId).roundStatus).toBe("observing");
    expect(playerOf(ctx.host, ctx.hostId).roundStatus).toBe("observing");
    await expect(guess(ctx.service, ctx.b, "answer")).rejects.toMatchObject({
      code: "TEAM_OBSERVER",
    });

    await audio(ctx.service, ctx.c);
    await guess(ctx.service, ctx.c, "wrong");
    expect(privateOf(ctx.b).visibleAttempts.map((attempt) => attempt.playerId)).toEqual([ctx.cId]);
    await guess(ctx.service, ctx.c, "answer");
    expect(lastEvent<SonGuessrRoomSnapshot>(ctx.host, "song.room.snapshot").phase).toBe(
      "roundResult"
    );
  });

  test("整队出题后没人可猜的玩家不能当出题人，候选名单只下发给房主", async () => {
    const ctx = await setup();
    await setTeam(ctx.service, ctx.host, 1);
    await setTeam(ctx.service, ctx.c, 1);
    // 全员同队：谁出题都会把其他人一起带去观战
    expect(privateOf(ctx.host).submitterCandidateIds).toEqual([]);
    await expect(
      execute(ctx.service, ctx.host, {
        id: "start",
        type: "song.game.start",
        roomId: "1234",
        payload: {},
      })
    ).rejects.toMatchObject({ code: "NO_SUBMITTER_CANDIDATE" });

    await setTeam(ctx.service, ctx.c, 2);
    expect([...privateOf(ctx.host).submitterCandidateIds].sort()).toEqual(
      [ctx.hostId, ctx.aId, ctx.bId, ctx.cId].sort()
    );
    expect(privateOf(ctx.a).submitterCandidateIds).toEqual([]);
  });

  test("队伍超时按在线队员人数扣次数，计时全队共用一份", async () => {
    const ctx = await setup({ maxGuessesPerRound: 3, guessDurationSeconds: 10 });
    await play(ctx, ctx.hostId, ctx.host);
    await audio(ctx.service, ctx.a);
    const deadline = privateOf(ctx.a).guessDeadlineAt;
    ctx.advance(3_000);
    // 队友后就绪不重开全队的计时
    await audio(ctx.service, ctx.b);
    expect(privateOf(ctx.b).guessDeadlineAt).toBe(deadline);
    await audio(ctx.service, ctx.c);

    ctx.advance(7_000);
    await ctx.service.runHousekeeping();
    expect(privateOf(ctx.a).remainingGuesses).toBe(1);
    expect(
      privateOf(ctx.a).visibleAttempts.map((attempt) => [attempt.playerId, attempt.result])
    ).toEqual([
      [ctx.aId, "timeout"],
      [ctx.bId, "timeout"],
    ]);
  });

  test("血战按作答单元排名：每队只有猜中者得分，观战队友不计入分母", async () => {
    const ctx = await setup({ bloodMode: true });
    await setTeam(ctx.service, ctx.host, 2);
    const extra = connection(ctx.service, "team-d");
    await joinRoom(ctx.service, extra, "丁");
    await setTeam(ctx.service, extra, 2);
    await ready(ctx.service, extra);
    // 房主出题，同队的丁本局观战：可作答单元是甲/乙一队与丙两处，分母为 2，丁不计入。
    await play(ctx, ctx.hostId, ctx.host);
    for (const client of [ctx.a, ctx.b, ctx.c]) await audio(ctx.service, client);
    await guess(ctx.service, ctx.c, "answer");
    await guess(ctx.service, ctx.a, "answer");
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(ctx.host, "song.room.snapshot");
    expect(snapshot.phase).toBe("roundResult");
    // 血战：丙第 1 名满分，甲/乙一队第 2 名得 (2-2+1)/2 = 半速。
    expect(playerOf(ctx.host, ctx.cId).score).toBe(10);
    expect(playerOf(ctx.host, ctx.aId).score).toBe(5);
    expect(playerOf(ctx.host, ctx.bId).score).toBe(0);
  });
});

describe("手动出题片段", () => {
  const enterSubmittingPhase = async (service: SonGuessrService) => {
    const host = connection(service, `clip-host-${Math.random()}`);
    const guest = connection(service, `clip-guest-${Math.random()}`);
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "玩家");
    await execute(service, guest, {
      id: "clip-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "clip-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "clip-choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    return { host, guest, hostState, guestState };
  };

  test("缺省片段沿用自动切片；合法区间取交集歌词", () => {
    const song = { lyrics: songs.answer.lyrics, durationMs: 60_000 };
    expect(createManualLyricClip(song, undefined)).toBeUndefined();
    expect(createManualLyricClip(song, { startTime: 2_000, endTime: 8_000 })).toEqual({
      startTime: 2_000,
      endTime: 8_000,
      lines: songs.answer.lyrics.slice(1, 7),
    });
  });

  test("越界、反向或过短的手动片段返回空，交给原来的随机切片", () => {
    const song = { lyrics: songs.answer.lyrics, durationMs: 60_000 };
    expect(createManualLyricClip(song, { startTime: 0, endTime: 1_000 })).toBeUndefined();
    expect(createManualLyricClip(song, { startTime: 8_000, endTime: 2_000 })).toBeUndefined();
    expect(createManualLyricClip(song, { startTime: 50_000, endTime: 80_000 })).toBeUndefined();
    expect(createManualLyricClip(song, { startTime: -1_000, endTime: 5_000 })).toBeUndefined();
    // 不再有 30 秒上限：整首都可以选，只要不少于 5 秒。
    expect(createManualLyricClip(song, { startTime: 10_000, endTime: 60_000 })).toMatchObject({
      startTime: 10_000,
      endTime: 60_000,
    });
    // 时长未知时不做上界校验，合法区间照常生效。
    expect(
      createManualLyricClip({ lyrics: songs.answer.lyrics }, { startTime: 2_000, endTime: 8_000 })
        ?.endTime
    ).toBe(8_000);
  });

  test("出题人可预览所选歌曲，非出题人与作答阶段都拿不到答案的试听与歌词", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "clip-preview-host");
    const guest = connection(service, "clip-preview-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家");

    // 等待阶段还不是出题人：不允许提前取答案详情。
    await expect(
      execute(service, host, {
        id: "preview-waiting",
        type: "song.music.detail",
        roomId: "1234",
        payload: { songId: "answer" },
      })
    ).rejects.toMatchObject({ code: "NOT_SUBMITTER" });

    await execute(service, guest, {
      id: "preview-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "preview-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "preview-choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });

    const preview = await execute<{ song: { id: string; audioUrl: string; lyrics: unknown[] } }>(
      service,
      host,
      {
        id: "preview-detail",
        type: "song.music.detail",
        roomId: "1234",
        payload: { songId: "answer" },
      }
    );
    expect(preview.song).toMatchObject({
      id: "answer",
      audioUrl: "https://audio/answer.mp3",
      durationMs: 180_000,
    });
    expect(preview.song.lyrics).toHaveLength(8);
    expect(preview.song.lyrics[0]).toMatchObject({ time: 1_000, endTime: 2_000, text: "歌词1" });

    await expect(
      execute(service, guest, {
        id: "preview-guest",
        type: "song.music.detail",
        roomId: "1234",
        payload: { songId: "answer" },
      })
    ).rejects.toMatchObject({ code: "NOT_SUBMITTER" });

    await execute(service, host, {
      id: "preview-submit",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer", clip: { startTime: 2_000, endTime: 8_000 } },
    });
    await expect(
      execute(service, host, {
        id: "preview-after-submit",
        type: "song.music.detail",
        roomId: "1234",
        payload: { songId: "answer" },
      })
    ).rejects.toMatchObject({ code: "NOT_SUBMITTER" });
  });

  test("主源取不到音频时按客户端回传的备用源兜底并进入回合", async () => {
    const calls: string[] = [];
    const failoverProvider: MusicProvider = {
      ...provider,
      getSong: async (id) => {
        calls.push(id);
        if (id === "answer") throw new AppError("SONG_UNAVAILABLE", "主源不可用");
        return { ...songs.answer, id, audioUrl: `https://audio/${id}.mp3` };
      },
    };
    const service = new SonGuessrService({
      musicProvider: failoverProvider,
      random: { nextInt: () => 0 },
    });
    const { host, guest } = await enterSubmittingPhase(service);
    const preview = await execute<{ song: { id: string; sources?: string[] } }>(service, host, {
      id: "source-preview",
      type: "song.music.detail",
      roomId: "1234",
      payload: { songId: "answer", sources: ["answer", "qq:alt"], requiresVip: false },
    });
    expect(preview.song.id).toBe("qq:alt");
    expect(preview.song.sources).toEqual(["qq:alt", "answer"]);
    expect(calls).toEqual(["answer", "qq:alt"]);

    await execute(service, host, {
      id: "source-submit",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer", sources: ["answer", "qq:alt"], requiresVip: false },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").phase).toBe("playing");
    expect(calls).toEqual(["answer", "qq:alt", "answer", "qq:alt"]);
  });

  test("手动片段随回合下发，快照导出恢复后仍在", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const { host, guest, guestState } = await enterSubmittingPhase(service);
    await execute(service, host, {
      id: "clip-submit",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer", clip: { startTime: 2_000, endTime: 8_000 } },
    });
    const round = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").currentRound;
    expect(round?.lyricClip).toEqual({
      startTime: 2_000,
      endTime: 8_000,
      lines: songs.answer.lyrics.slice(1, 7),
    });

    const exported = service.exportSnapshots();
    expect(JSON.stringify(exported)).toContain('"startTime":2000');
    const restarted = new SonGuessrService({ musicProvider: provider });
    expect(restarted.restoreSnapshots(exported, Date.now())).toBe(1);
    const restoredClient = connection(restarted, "clip-restored-guest");
    await execute(restarted, restoredClient, {
      id: "clip-restore",
      type: "song.room.reconnect",
      payload: { roomId: "1234", sessionToken: guestState.sessionToken },
    });
    expect(
      lastEvent<SonGuessrRoomSnapshot>(restoredClient, "song.room.snapshot").currentRound?.lyricClip
    ).toEqual({
      startTime: 2_000,
      endTime: 8_000,
      lines: songs.answer.lyrics.slice(1, 7),
    });
  });

  test("无效手动片段回退到原来的随机切片", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const { host, guest } = await enterSubmittingPhase(service);
    await execute(service, host, {
      id: "clip-submit-invalid",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer", clip: { startTime: 0, endTime: 1_000 } },
    });
    const auto = createSongLyricClip(
      songs.answer.lyrics,
      5,
      { nextInt: () => 0 },
      songs.answer.durationMs
    );
    expect(
      lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").currentRound?.lyricClip
    ).toEqual(auto);
  });

  test("预览下发建议片段，直接确认时用的就是同一段", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const { host, guest } = await enterSubmittingPhase(service);
    const preview = await execute<{
      song: { suggestedClip?: { startTime: number; endTime: number } };
    }>(service, host, {
      id: "clip-suggested-preview",
      type: "song.music.detail",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    const auto = createSongLyricClip(
      songs.answer.lyrics,
      5,
      { nextInt: () => 0 },
      songs.answer.durationMs
    );
    expect(preview.song.suggestedClip).toEqual({
      startTime: auto.startTime,
      endTime: auto.endTime,
    });

    // 不出题人没改区间直接确认：不传 clip，服务端仍用同一套随机切片。
    await execute(service, host, {
      id: "clip-submit-default",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    expect(
      lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").currentRound?.lyricClip
    ).toEqual(auto);
  });
});
