import { describe, expect, test } from "bun:test";
import {
  songs,
  provider,
  connection,
  execute,
  lastEvent,
  createRoom,
  joinRoom,
  startRound,
} from "./Fixtures";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  type SongDetails,
  type SonGuessrPrivateState,
  type SonGuessrRoomSnapshot,
} from "../../src/shared/Index";
import { AppError } from "../../src/domain/Errors";
import { type GameRoundRecord } from "../../src/domain/GameRecord";
import { type SongSearchResult } from "../../src/shared/SonGuessr";
import { type MusicProvider } from "../../src/infrastructure/NeteaseMusicProvider";

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

  test("Oblivionis 测试房支持人机并不会进入大厅或被空房清理", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    await createRoom(service, host, { roomId: "Oblivionis", name: "测试房" });

    await execute(service, host, {
      id: "add-bots",
      type: "song.test.addBot",
      roomId: "Oblivionis",
      payload: { count: 2 },
    });
    const withBots = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(withBots.testMode).toBe(true);
    expect(withBots.players.filter((player) => player.isBot)).toHaveLength(2);
    expect(service.getRoomSummaries()).toHaveLength(0);

    await service.unregisterConnection(host.record.id);
    await service.runHousekeeping();
    const replacement = connection(service, "replacement");
    const replacementState = await joinRoom(service, replacement, "新房主", "Oblivionis");
    expect(lastEvent<SonGuessrRoomSnapshot>(replacement, "song.room.snapshot").hostPlayerId).toBe(
      replacementState.playerId
    );

    await execute(service, replacement, {
      id: "remove-bot",
      type: "song.test.removeBot",
      roomId: "Oblivionis",
      payload: { count: 1 },
    });
    expect(
      lastEvent<SonGuessrRoomSnapshot>(replacement, "song.room.snapshot").players.filter(
        (player) => player.isBot
      )
    ).toHaveLength(1);
  });

  test("Oblivionis 测试房刷新重连后保留房主权限", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    await createRoom(service, host, { roomId: "Oblivionis", name: "测试房" });
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await execute(service, host, {
      id: "add-bot-before-refresh",
      type: "song.test.addBot",
      roomId: "Oblivionis",
      payload: { count: 1 },
    });
    const botId = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").players.find(
      (player) => player.isBot
    )!.id;

    await service.unregisterConnection(host.record.id);
    const refreshed = connection(service, "host-refreshed");
    await execute(service, refreshed, {
      id: "reconnect-after-refresh",
      type: "song.room.reconnect",
      payload: { roomId: "Oblivionis", sessionToken: hostState.sessionToken },
    });

    expect(lastEvent<SonGuessrRoomSnapshot>(refreshed, "song.room.snapshot").hostPlayerId).toBe(
      hostState.playerId
    );
    await expect(
      execute(service, refreshed, {
        id: "kick-after-refresh",
        type: "song.room.kick",
        roomId: "Oblivionis",
        payload: { playerId: botId },
      })
    ).resolves.toEqual({ kicked: true });
  });

  test("Oblivionis 测试房允许出题人自己猜且提交歌曲不会被误判为猜对", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "host");
    await createRoom(service, host, { roomId: "Oblivionis", name: "测试房" });
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");

    await execute(service, host, {
      id: "add-bot",
      type: "song.test.addBot",
      roomId: "Oblivionis",
      payload: { count: 1 },
    });
    await execute(service, host, {
      id: "start",
      type: "song.game.start",
      roomId: "Oblivionis",
      payload: {},
    });
    await execute(service, host, {
      id: "choose-self",
      type: "song.game.chooseSubmitter",
      roomId: "Oblivionis",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "submit-answer",
      type: "song.game.submitSong",
      roomId: "Oblivionis",
      payload: { songId: "answer" },
    });

    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
    expect(lastEvent<SonGuessrPrivateState>(host, "song.game.privateState")).toMatchObject({
      isSubmitter: true,
      canGuess: false,
      canGiveUp: true,
      visibleAttempts: [],
    });

    await execute(service, host, {
      id: "self-audio-ready",
      type: "song.game.audioReady",
      roomId: "Oblivionis",
      payload: { roundNumber: 1 },
    });
    expect(lastEvent<SonGuessrPrivateState>(host, "song.game.privateState").canGuess).toBe(true);

    const wrong = (await execute(service, host, {
      id: "self-wrong-guess",
      type: "song.game.guess",
      roomId: "Oblivionis",
      payload: { songId: "wrong" },
    })) as { attempt: { result: string } };
    expect(wrong.attempt.result).toBe("wrong");
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");

    const correct = (await execute(service, host, {
      id: "self-correct-guess",
      type: "song.game.guess",
      roomId: "Oblivionis",
      payload: { songId: "answer" },
    })) as { attempt: { result: string } };
    expect(correct.attempt.result).toBe("correct");
    const result = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(result.phase).toBe("roundResult");
    expect(result.roundSummary?.correctPlayerIds).toContain(hostState.playerId);
    expect(result.roundSummary?.song.audioUrl).toBe("https://audio/answer.mp3");
    expect(result.roundSummary?.song.chorus).toEqual({ startTime: 50_000, endTime: 90_000 });
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
    expect(playing.currentRound?.audioUrl).toBe("https://audio/answer.mp3");
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
    expect(
      lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound?.audioUrl
    ).toBe("https://audio/refresh-1.mp3");

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
      currentRound: {
        roundNumber: 1,
        audioUrl: "https://audio/refresh-2.mp3",
      },
    });
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

  test("自动出题按歌单与歌手交集随机选择歌曲且所有正式玩家都可猜", async () => {
    const autoProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "测试歌单", songCount: 2 },
        songs: [songs.answer, songs.wrong],
      }),
      getArtistSongs: async () => [songs.answer],
      getSongPopularity: async (songId) => (songId === "answer" ? 12_345 : 999),
    };
    const service = new SonGuessrService({
      musicProvider: autoProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "auto-host");
    const guest = connection(service, "auto-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "自动玩家");
    await execute(service, host, {
      id: "auto-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionMode: "automatic",
        autoFilters: {
          playlist: { id: "42", name: "测试歌单", songCount: 2 },
          artists: [{ id: "7", name: "测试歌手" }],
          minPopularity: 1_000,
        },
      },
    });
    await execute(service, guest, {
      id: "auto-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "auto-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(snapshot.phase).toBe("playing");
    expect(snapshot.currentRound?.submitterPlayerId).toBe("");
    expect(snapshot.settings.questionMode).toBe("automatic");
    await execute(service, guest, {
      id: "auto-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    expect(lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").canGuess).toBe(true);
  });

  test("自动出题使用 QQ 歌单或歌手时要求房间有 QQ 账号", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "qq-auto-host");
    const guest = connection(service, "qq-auto-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "自动玩家");
    await execute(service, host, {
      id: "qq-auto-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionMode: "automatic",
        autoFilters: {
          playlist: { id: "qq:42", name: "QQ 歌单", songCount: 1 },
          artists: [],
          minPopularity: 0,
        },
      },
    });
    await execute(service, guest, {
      id: "qq-auto-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    const error = await execute(service, host, {
      id: "qq-auto-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("MUSIC_LOGIN_REQUIRED");
  });

  test("歌单与歌手分属不同平台时按同名歌手补齐交集", async () => {
    const neteaseTrack: SongSearchResult = {
      ...songs.answer,
      id: "netease:track",
      title: "交集曲",
      artist: "测试歌手",
    };
    const crossProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie, platform) => ({
        cookie,
        account: {
          platform: platform === "qq" ? "qq" : "netease",
          nickname: platform === "qq" ? "QQ用户" : "网易云用户",
          vipStatus: "nonVip",
        },
      }),
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "网易云歌单", songCount: 1 },
        songs: [neteaseTrack],
      }),
      searchArtists: async () => [
        { id: "netease:artist-netease", name: "测试歌手" },
        { id: "qq:artist-qq", name: "测试歌手" },
      ],
      getArtistSongs: async (artistId) =>
        artistId === "netease:artist-netease"
          ? [neteaseTrack]
          : [{ ...neteaseTrack, id: "qq:track" }],
      getSong: async (id) => ({ ...songs.answer, id, audioUrl: `https://audio/${id}.mp3` }),
    };
    const service = new SonGuessrService({
      musicProvider: crossProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "cross-host");
    const guest = connection(service, "cross-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "QQ 号主");
    await execute(service, guest, {
      id: "cross-qq",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "qm_keyst=qq-cookie", platform: "qq" },
    });
    await execute(service, host, {
      id: "cross-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionMode: "automatic",
        autoFilters: {
          playlist: { id: "42", name: "网易云歌单", songCount: 1 },
          artists: [{ id: "qq:artist-qq", name: "测试歌手" }],
          minPopularity: 0,
        },
      },
    });
    await execute(service, guest, {
      id: "cross-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "cross-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").phase).toBe("playing");
  });

  test("自动选曲把可播曲排在前面，非会员 QQ 号不会先撞会员专享曲", async () => {
    const songCalls: string[] = [];
    const vipTrack: SongSearchResult = {
      ...songs.answer,
      id: "qq:vip",
      title: "会员曲",
      requiresVip: true,
    };
    const freeTrack: SongSearchResult = {
      ...songs.answer,
      id: "qq:free",
      title: "免费曲",
      requiresVip: false,
    };
    const autoProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie, platform) => ({
        cookie,
        account: {
          platform: platform === "qq" ? "qq" : "netease",
          nickname: platform === "qq" ? "QQ用户" : "网易云用户",
          vipStatus: "nonVip",
        },
      }),
      getPlaylistSongs: async () => ({
        info: { id: "qq:42", name: "QQ 歌单", songCount: 2 },
        songs: [vipTrack, freeTrack],
      }),
      getSong: async (id) => {
        songCalls.push(id);
        return { ...songs.answer, id, audioUrl: `https://audio/${id}.mp3` };
      },
    };
    const service = new SonGuessrService({
      musicProvider: autoProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "playable-first-host");
    const guest = connection(service, "playable-first-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "QQ 号主");
    await execute(service, guest, {
      id: "playable-first-qq",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "qm_keyst=qq-cookie", platform: "qq" },
    });
    await execute(service, host, {
      id: "playable-first-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionMode: "automatic",
        autoFilters: {
          playlist: { id: "qq:42", name: "QQ 歌单", songCount: 2 },
          artists: [],
          minPopularity: 0,
        },
      },
    });
    await execute(service, guest, {
      id: "playable-first-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "playable-first-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });

    expect(lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").phase).toBe("playing");
    expect(songCalls).toEqual(["qq:free"]);
  });

  test("自动题库热度筛选对大歌单限制单轮上游查询数量", async () => {
    let popularityCalls = 0;
    const largePlaylist = Array.from({ length: 1_000 }, (_, index) => ({
      ...songs.wrong,
      id: `large-${index}`,
      popularity: undefined,
    }));
    const autoProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "大歌单", songCount: largePlaylist.length },
        songs: largePlaylist,
      }),
      getSongPopularity: async () => {
        popularityCalls += 1;
        return 2_000;
      },
      getSong: async (id) => ({ ...songs.answer, id }),
    };
    const service = new SonGuessrService({
      musicProvider: autoProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "large-auto-host");
    const guest = connection(service, "large-auto-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "大歌单玩家");
    await execute(service, host, {
      id: "large-auto-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionMode: "automatic",
        autoFilters: {
          playlist: { id: "42", name: "大歌单", songCount: largePlaylist.length },
          artists: [],
          minPopularity: 1_000,
        },
      },
    });
    await execute(service, guest, {
      id: "large-auto-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });

    await execute(service, host, {
      id: "large-auto-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });

    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
    expect(popularityCalls).toBeLessThanOrEqual(24);
  });

  test("自动出题只配置歌单时也可以开始", async () => {
    const playlistOnlyProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "测试歌单", songCount: 1 },
        songs: [songs.answer],
      }),
    };
    const service = new SonGuessrService({
      musicProvider: playlistOnlyProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "playlist-host");
    const guest = connection(service, "playlist-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "歌单玩家");
    await execute(service, host, {
      id: "playlist-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionMode: "automatic",
        autoFilters: {
          playlist: { id: "42", name: "测试歌单", songCount: 1 },
          artists: [],
          minPopularity: 0,
        },
      },
    });
    await execute(service, guest, {
      id: "playlist-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await expect(
      execute(service, host, {
        id: "playlist-start",
        type: "song.game.start",
        roomId: "1234",
        payload: {},
      })
    ).resolves.toMatchObject({ started: true });
  });

  test("自动出题不配置筛选时使用默认热歌榜题库", async () => {
    let sourceId = "";
    const defaultProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async (playlistId) => {
        sourceId = playlistId;
        return { info: { id: playlistId, name: "默认题库", songCount: 1 }, songs: [songs.answer] };
      },
    };
    const service = new SonGuessrService({
      musicProvider: defaultProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "default-host");
    const guest = connection(service, "default-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "默认题库玩家");
    await execute(service, host, {
      id: "default-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { questionMode: "automatic", autoFilters: { artists: [], minPopularity: 0 } },
    });
    await execute(service, guest, {
      id: "default-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "default-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    expect(sourceId).toBe("3778678");
  });

  test("单人房间自动出题、拒绝他人加入、不进大厅列表且可连续开局", async () => {
    const soloProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "3778678", name: "默认题库", songCount: 1 },
        songs: [songs.answer],
      }),
    };
    const service = new SonGuessrService({
      musicProvider: soloProvider,
      random: { nextInt: () => 0 },
    });
    const solo = connection(service, "solo-player");
    const stranger = connection(service, "solo-stranger");
    await createRoom(service, solo, {
      roomId: "7777",
      name: "单人模式",
      allowSpectators: false,
      userName: "独狼",
      solo: true,
    });
    const playerId = lastEvent<SonGuessrPrivateState>(solo, "song.game.privateState").playerId;
    const waiting = lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
    expect(waiting.solo).toBe(true);
    expect(waiting.settings.questionMode).toBe("automatic");
    expect(service.getRoomSummaries()).toEqual([]);

    await execute(service, solo, {
      id: "solo-manual",
      type: "song.room.updateSettings",
      roomId: "7777",
      payload: { questionMode: "manual" },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot").settings.questionMode).toBe(
      "automatic"
    );

    await expect(
      execute(service, stranger, {
        id: "solo-join",
        type: "song.room.join",
        roomId: "7777",
        payload: { userName: "路人" },
      })
    ).rejects.toMatchObject({ code: "SOLO_ROOM_FORBIDDEN" });

    // 单人房间无需准备与指定出题人，开局后直接进入作答。
    await execute(service, solo, {
      id: "solo-start",
      type: "song.game.start",
      roomId: "7777",
      payload: {},
    });
    const playing = lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
    expect(playing.phase).toBe("playing");
    expect(playing.currentRound?.submitterPlayerId).toBe("");

    await execute(service, solo, {
      id: "solo-audio",
      type: "song.game.audioReady",
      roomId: "7777",
      payload: { roundNumber: 1 },
    });
    await execute(service, solo, {
      id: "solo-guess",
      type: "song.game.guess",
      roomId: "7777",
      payload: { songId: "answer" },
    });
    const settled = lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
    expect(settled.phase).toBe("roundResult");
    expect(settled.roundSummary?.correctPlayerIds).toEqual([playerId]);
    expect(settled.roundSummary?.scores).toEqual([
      { playerId, playerName: "独狼", score: 12, delta: 12, correctGuesses: 1, totalGuesses: 1 },
    ]);

    await execute(service, solo, {
      id: "solo-next",
      type: "song.game.nextRound",
      roomId: "7777",
      payload: {},
    });
    const nextRound = lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
    expect(nextRound.phase).toBe("playing");
    expect(nextRound.roundNumber).toBe(2);

    // 猜测次数按整局累计，不随回合重置。
    await execute(service, solo, {
      id: "solo-audio-2",
      type: "song.game.audioReady",
      roomId: "7777",
      payload: { roundNumber: 2 },
    });
    await execute(service, solo, {
      id: "solo-guess-2",
      type: "song.game.guess",
      roomId: "7777",
      payload: { songId: "answer" },
    });
    const settled2 = lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
    expect(settled2.roundSummary?.scores).toEqual([
      { playerId, playerName: "独狼", score: 24, delta: 12, correctGuesses: 2, totalGuesses: 2 },
    ]);
    expect(settled2.players.find((candidate) => candidate.id === playerId)?.totalGuesses).toBe(2);
  });

  test("自动开局的重复请求会被加载锁拦截", async () => {
    let delayStatus = false;
    let releaseStatus!: () => void;
    const pendingStatus = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const autoProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => {
        if (delayStatus) await pendingStatus;
        return { cookie, account: { nickname: "测试账号", vipStatus: "vip" } };
      },
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "测试歌单", songCount: 1 },
        songs: [songs.answer],
      }),
    };
    const service = new SonGuessrService({
      musicProvider: autoProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "double-start-host");
    const guest = connection(service, "double-start-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "重复开局玩家");
    await execute(service, host, {
      id: "double-start-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { questionMode: "automatic", autoFilters: { artists: [], minPopularity: 0 } },
    });
    await execute(service, guest, {
      id: "double-start-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });

    delayStatus = true;
    const firstStart = execute(service, host, {
      id: "double-start-first",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await expect(
      execute(service, host, {
        id: "double-start-second",
        type: "song.game.start",
        roomId: "1234",
        payload: {},
      })
    ).rejects.toMatchObject({ code: "INVALID_PHASE" });

    releaseStatus();
    await expect(firstStart).resolves.toEqual({ started: true });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");
  });

  test("自动模式全员超时结算后可以正常进入第二轮", async () => {
    let now = 10_000;
    const autoProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "测试歌单", songCount: 1 },
        songs: [songs.answer],
      }),
    };
    const service = new SonGuessrService({
      musicProvider: autoProvider,
      random: { nextInt: () => 0 },
      now: () => now,
    });
    const host = connection(service, "timeout-auto-host");
    const guest = connection(service, "timeout-auto-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "自动玩家");
    await execute(service, host, {
      id: "timeout-auto-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionMode: "automatic",
        maxGuessesPerRound: 1,
        guessDurationSeconds: 10,
        autoFilters: {
          playlist: { id: "42", name: "测试歌单", songCount: 1 },
          artists: [],
          minPopularity: 0,
        },
      },
    });
    await execute(service, guest, {
      id: "timeout-auto-ready-guest",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "timeout-auto-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    for (const [client, id] of [
      [host, "host"],
      [guest, "guest"],
    ] as const) {
      await execute(service, client, {
        id: `timeout-auto-audio-${id}`,
        type: "song.game.audioReady",
        roomId: "1234",
        payload: { roundNumber: 1 },
      });
    }

    now += 10_001;
    await service.runHousekeeping();
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot")).toMatchObject({
      phase: "roundResult",
      roundNumber: 1,
    });

    await execute(service, host, {
      id: "timeout-auto-next",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot")).toMatchObject({
      phase: "playing",
      roundNumber: 2,
      currentRound: { roundNumber: 2 },
    });
  });

  test("自动下一轮取题失败时保留上一轮答案页", async () => {
    let playlistCalls = 0;
    const failingNextProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => {
        playlistCalls += 1;
        if (playlistCalls > 1) throw new AppError("MUSIC_API_FAILED", "题库暂时不可用");
        return { info: { id: "42", name: "测试歌单", songCount: 1 }, songs: [songs.answer] };
      },
    };
    const service = new SonGuessrService({
      musicProvider: failingNextProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "failed-next-host");
    const guest = connection(service, "failed-next-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "玩家");
    await execute(service, host, {
      id: "failed-next-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionMode: "automatic",
        autoFilters: {
          playlist: { id: "42", name: "测试歌单", songCount: 1 },
          artists: [],
          minPopularity: 0,
        },
      },
    });
    await execute(service, guest, {
      id: "failed-next-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "failed-next-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    for (const [client, id] of [
      [host, "host"],
      [guest, "guest"],
    ] as const) {
      await execute(service, client, {
        id: `failed-next-audio-${id}`,
        type: "song.game.audioReady",
        roomId: "1234",
        payload: { roundNumber: 1 },
      });
      await execute(service, client, {
        id: `failed-next-give-up-${id}`,
        type: "song.game.giveUp",
        roomId: "1234",
        payload: {},
      });
    }
    const summary = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").roundSummary;

    await expect(
      execute(service, host, {
        id: "failed-next-command",
        type: "song.game.nextRound",
        roomId: "1234",
        payload: {},
      })
    ).rejects.toMatchObject({ code: "MUSIC_API_FAILED" });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot")).toMatchObject({
      phase: "roundResult",
      roundNumber: 1,
      roundSummary: summary,
    });
  });
});
