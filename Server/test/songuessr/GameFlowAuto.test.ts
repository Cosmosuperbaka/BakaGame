import { AppError } from "../../src/domain/Errors";
import { afterEach, describe, expect, test } from "bun:test";
import {
  connection,
  createRoom,
  deferredServiceResult,
  execute,
  joinRoom,
  lastEvent,
  makeSong,
  provider,
  songs,
} from "./Fixtures";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import { type SonGuessrPrivateState, type SonGuessrRoomSnapshot } from "../../src/shared/Index";
import { type SongSearchResult } from "../../src/shared/SonGuessr";
import { type MusicProvider } from "../../src/infrastructure/music/MusicProvider";

describe("SonGuessrService", () => {
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

  test("自动出题取歌期间房间被关闭，候选循环不再继续回源", async () => {
    const gate = deferredServiceResult<void>();
    const calls: string[] = [];
    // 曲名各不相同：同名的候选会被并成一首，循环就只有一个候选了。
    const candidates = ["c1", "c2", "c3"].map((id) => makeSong(id, `候选${id}`, 2020));
    const autoProvider: MusicProvider = {
      ...provider,
      getPlaylistSongs: async () => ({
        info: { id: "42", name: "测试歌单", songCount: 3 },
        songs: candidates,
      }),
      getSong: async (id) => {
        calls.push(id);
        if (calls.length === 1) await gate.promise;
        throw new AppError("SONG_UNAVAILABLE", "歌曲暂时无法播放");
      },
    };
    const service = new SonGuessrService({
      musicProvider: autoProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "dead-loop-host");
    const guest = connection(service, "dead-loop-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "客人");
    await execute(service, host, {
      id: "dead-loop-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { questionMode: "automatic", autoFilters: { artists: [], minPopularity: 0 } },
    });
    await execute(service, guest, {
      id: "dead-loop-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    const starting = execute(service, host, {
      id: "dead-loop-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    const outcome = starting.then(
      () => "started",
      (error: unknown) => (error as { code?: string }).code
    );
    for (let spin = 0; spin < 200 && calls.length === 0; spin += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(calls).toHaveLength(1);
    await service.adminCloseRoom("1234");
    gate.resolve();
    await outcome;
    // 房间已经没了：剩余候选不该再逐个回源，白白消耗匿名出口额度。
    expect(calls).toHaveLength(1);
  });

  describe("开局加载期间的并发与设置", () => {
    // 断言失败时也要放行卡住的开局，否则悬着的 Promise 会拖住整个测试进程。
    let releaseGate: (() => void) | undefined;
    afterEach(() => releaseGate?.());
    /** 开局复核卡在 getLoginStatus：此时阶段仍是 waiting，但房间已经在开局。 */
    const setupStarting = async (questionMode: "manual" | "automatic", startNow = true) => {
      const gate = deferredServiceResult<void>();
      let hold = false;
      const slowProvider: MusicProvider = {
        ...provider,
        getLoginStatus: async (cookie) => {
          if (hold) await gate.promise;
          return { cookie, account: { nickname: "测试账号", vipStatus: "vip" } };
        },
        getPlaylistSongs: async () => ({
          info: { id: "42", name: "测试歌单", songCount: 1 },
          songs: [songs.answer],
        }),
      };
      const service = new SonGuessrService({
        musicProvider: slowProvider,
        random: { nextInt: () => 0 },
      });
      const host = connection(service, "starting-host");
      const guest = connection(service, "starting-guest");
      await createRoom(service, host);
      await joinRoom(service, guest, "客人");
      const send = (id: string, type: string, payload: unknown) =>
        execute(service, host, { id, type, roomId: "1234", payload } as never);
      await send("starting-settings", "song.room.updateSettings", {
        questionMode,
        autoFilters: { artists: [], minPopularity: 0 },
      });
      await execute(service, guest, {
        id: "starting-ready",
        type: "song.player.setReady",
        roomId: "1234",
        payload: { ready: true },
      });
      hold = true;
      releaseGate = () => gate.resolve();
      const begin = () => send("starting-first", "song.game.start", {});
      return {
        service,
        host,
        send,
        begin,
        first: startNow ? begin() : undefined!,
        release: () => gate.resolve(),
        snapshot: () => lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot"),
      };
    };

    test("自动开局加载期间改题型被拒，回合设置仍是猜歌", async () => {
      const ctx = await setupStarting("automatic");
      await expect(
        ctx.send("starting-type", "song.room.updateSettings", { questionType: "anime" })
      ).rejects.toMatchObject({ code: "INVALID_PHASE" });
      ctx.release();
      await expect(ctx.first).resolves.toEqual({ started: true });
      expect(ctx.snapshot().settings.questionType).toBe("song");
    });

    test("手动开局复核期间不能改成自动再开第二局，回合不被吞", async () => {
      const ctx = await setupStarting("manual");
      await expect(
        ctx.send("starting-mode", "song.room.updateSettings", { questionMode: "automatic" })
      ).rejects.toMatchObject({ code: "INVALID_PHASE" });
      await expect(ctx.send("starting-second", "song.game.start", {})).rejects.toMatchObject({
        code: "INVALID_PHASE",
      });
      ctx.release();
      await expect(ctx.first).resolves.toEqual({ started: true });
      expect(ctx.snapshot()).toMatchObject({ phase: "choosingSubmitter", roundNumber: 0 });
      expect(ctx.snapshot().settings.questionMode).toBe("manual");
    });

    test("改口令的哈希计算期间开局，回来后设置更新被拒且不覆盖房间", async () => {
      const ctx = await setupStarting("automatic", false);
      // 先发设置更新：它停在口令摘要的 await 上，此时入口检查已经通过。
      const update = ctx.send("starting-password", "song.room.updateSettings", {
        name: "改名",
        visibility: "private",
        password: "secret-1",
      });
      const first = ctx.begin();
      await expect(update).rejects.toMatchObject({ code: "INVALID_PHASE" });
      ctx.release();
      await expect(first).resolves.toEqual({ started: true });
      expect(ctx.snapshot()).toMatchObject({ name: "猜歌房", visibility: "public" });
    });
  });
});
