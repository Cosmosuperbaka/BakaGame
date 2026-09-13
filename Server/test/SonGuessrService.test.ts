import { describe, expect, test } from "bun:test";

import {
  ANIME_SONG_LOOKUP_BUDGET,
  AUTO_ANIME_CANDIDATE_LIMIT,
  createSongLyricClip,
  isSongTitleMatch,
  SonGuessrService,
} from "../src/application/SonGuessrService";
import { AppError } from "../src/domain/Errors";
import { ROOM_EMPTY_GRACE_PERIOD_MS, HOST_RECONNECT_TIMEOUT_MS } from "../src/config/Constants";
import type { ConnectionRecord } from "../src/domain/Model";
import type { MusicProvider } from "../src/infrastructure/NeteaseMusicProvider";
import type { BangumiDataProvider } from "../src/infrastructure/LocalBangumiProvider";
import {
  ALL_BANGUMI_TRACK_KINDS,
  SERVER_SHUTDOWN_MESSAGE,
  type BangumiSubjectDetails,

  type SongDetails,
  type SonGuessrClientMessage,
  type SonGuessrPrivateState,
  type SonGuessrRoomSnapshot,
} from "../src/shared/Index";

const makeSong = (id: string, title: string, year: number): SongDetails => ({
  id,
  title,
  artist: "测试歌手",
  album: "测试专辑",
  pictureUrl: `https://img/${id}.jpg`,
  durationMs: 180_000,
  audioUrl: `https://audio/${id}.mp3`,
  lyrics: Array.from({ length: 8 }, (_, index) => ({
    time: (index + 1) * 1_000,
    endTime: (index + 2) * 1_000,
    text: `歌词${index + 1}`,
  })),
  releaseYear: year,
  popularity: id === "answer" ? 90 : 60,
  language: "国语",
  encyclopedia: { summary: "百科", tags: ["流行", id] },
  chorus: { startTime: 50_000, endTime: 90_000 },
});

const songs = {
  answer: makeSong("answer", "答案歌", 2022),
  wrong: makeSong("wrong", "错误歌", 2018),
};

const anime: BangumiSubjectDetails = {
  id: "anime-answer",
  name: "Answer Anime",
  nameCn: "答案番剧",
  imageUrl: "https://img.example/anime.jpg",
  year: 2024,
  rating: 8.8,
  ratingCount: 1200,
  tags: ["奇幻"],
  metaTags: ["动画"],
  summary: "测试番剧简介",
  musicTracks: [{ title: "答案歌", artist: "测试歌手", kind: "opening" }],
};

const wrongAnime: BangumiSubjectDetails = {
  ...anime,
  id: "anime-wrong",
  name: "Wrong Anime",
  nameCn: "错误番剧",
};

const provider: MusicProvider = {
  search: async () => [songs.answer, songs.wrong],
  getSong: async (id) => songs[id as keyof typeof songs],
  getSongMetadata: async (id) => songs[id as keyof typeof songs],
  getLoginStatus: async (cookie) => ({
    cookie,
    account: { nickname: "测试账号", vipStatus: "vip" },
  }),
};

interface TestConnection {
  record: ConnectionRecord;
  sent: Array<{ type?: string; event?: string; payload?: unknown }>;
}

const connection = (service: SonGuessrService, id: string): TestConnection => {
  const sent: TestConnection["sent"] = [];
  const record: ConnectionRecord = {
    id,
    lobbySubscribed: false,
    send: (payload) => sent.push(payload as TestConnection["sent"][number]),
    close: () => {},
  };
  service.registerConnection(record);
  return { record, sent };
};

const execute = (
  service: SonGuessrService,
  client: TestConnection,
  message: SonGuessrClientMessage,
) => service.execute(client.record.id, message);

const lastEvent = <T>(client: TestConnection, event: string): T =>
  client.sent.filter((item) => item.type === "event" && item.event === event).at(-1)!.payload as T;

const createRoom = async (
  service: SonGuessrService,
  host: TestConnection,
  overrides: Partial<Extract<SonGuessrClientMessage, { type: "song.room.create" }>["payload"]> = {},
) => {
  const created = await execute(service, host, {
    id: "create",
    type: "song.room.create",
    payload: {
      roomId: "1234",
      name: "猜歌房",
      visibility: "public",
      allowSpectators: true,
      userName: "房主",
      ...overrides,
    },
  });
  await execute(service, host, {
    id: "host-account",
    type: "song.auth.useCookie",
    roomId: overrides.roomId ?? "1234",
    payload: { cookie: "MUSIC_U=test-host" },
  });
  return created;
};

const joinRoom = async (
  service: SonGuessrService,
  client: TestConnection,
  userName: string,
  roomId = "1234",
  password?: string,
) => {
  await execute(service, client, {
    id: `join-${client.record.id}`,
    type: "song.room.join",
    roomId,
    payload: password ? { userName, password } : { userName },
  });
  return lastEvent<SonGuessrPrivateState>(client, "song.game.privateState");
};

const startRound = async (
  service: SonGuessrService,
  host: TestConnection,
  guest: TestConnection,
  submitterPlayerId: string,
) => {
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
    payload: { playerId: submitterPlayerId },
  });
  await execute(service, host, {
    id: "submit",
    type: "song.game.submitSong",
    roomId: "1234",
    payload: { songId: "answer" },
  });
};

describe("SonGuessrService", () => {

  test("听歌猜番提交后只向出题人公开答案，并按 subject ID 完成猜测结算", async () => {
    const bangumiProvider = {
      getSubject: async (subjectId: string) => subjectId === anime.id ? anime : wrongAnime,
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;
    const service = new SonGuessrService({ musicProvider: provider, bangumiProvider });
    const host = connection(service, "anime-host");
    const guest = connection(service, "anime-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "猜番玩家");
    await execute(service, host, {
      id: "anime-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { questionType: "anime" },
    });
    await execute(service, guest, {
      id: "anime-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "anime-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "anime-choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "anime-submit",
      type: "song.game.submitAnime",
      roomId: "1234",
      payload: { subjectId: anime.id },
    });

    expect(lastEvent<SonGuessrPrivateState>(host, "song.game.privateState").submittedAnime?.id).toBe(anime.id);
    expect(lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").submittedAnime).toBeUndefined();
    await execute(service, guest, {
      id: "anime-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    await expect(execute(service, guest, {
      id: "anime-wrong-guess",
      type: "song.game.guessAnime",
      roomId: "1234",
      payload: { subjectId: wrongAnime.id },
    })).resolves.toMatchObject({ attempt: { result: "wrong", guessedAnime: { id: wrongAnime.id } } });
    await execute(service, guest, {
      id: "anime-correct-guess",
      type: "song.game.guessAnime",
      roomId: "1234",
      payload: { subjectId: anime.id },
    });
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(snapshot.phase).toBe("roundResult");
    expect(snapshot.roundSummary?.anime?.id).toBe(anime.id);
    expect(snapshot.roundSummary?.animeTrack).toEqual({ title: "答案歌", artist: "测试歌手", kind: "opening" });
    expect(snapshot.roundSummary?.song.title).toBe("答案歌");
    expect(snapshot.roundSummary?.attempts.map((attempt) => attempt.guessedAnime?.id)).toEqual([wrongAnime.id, anime.id]);
  });

  test("听歌猜番自动出题沿用 Bangumi 筛选并跳过无主题曲条目", async () => {
    const noMusicAnime: BangumiSubjectDetails = { ...wrongAnime, id: "anime-no-music", musicTracks: [] };
    const requestedFilters: unknown[] = [];
    const bangumiProvider = {
      searchSubjects: async (_keyword: string, _limit: number, filters: unknown) => {
        requestedFilters.push(filters);
        return [noMusicAnime, anime];
      },
      getSubject: async (subjectId: string) => subjectId === noMusicAnime.id ? noMusicAnime : anime,
    } as unknown as BangumiDataProvider;
    const service = new SonGuessrService({
      musicProvider: provider,
      bangumiProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "anime-auto-host");
    const guest = connection(service, "anime-auto-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "自动猜番玩家");
    await execute(service, host, {
      id: "anime-auto-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionType: "anime",
        questionMode: "automatic",
        animeAutoFilters: { startYear: 2020, endYear: 2024, ranking: "all", subjectLimit: 2, songMinPopularity: 0, trackKinds: ["opening"] },
      },
    });
    await execute(service, guest, {
      id: "anime-auto-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "anime-auto-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });

    expect(requestedFilters).toEqual([{ startYear: 2020, endYear: 2024, ranking: "all", subjectLimit: 2, songMinPopularity: 0, trackKinds: ["opening"] }]);
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound?.submitterPlayerId).toBe("");
    expect(lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").submittedAnime).toBeUndefined();
  });

  test("听歌猜番年榜在设置年份范围内选择年份查询", async () => {
    const requestedFilters: unknown[] = [];
    const bangumiProvider = {
      searchSubjects: async (_keyword: string, _limit: number, filters: unknown) => {
        requestedFilters.push(filters);
        return [anime];
      },
      getSubject: async () => anime,
    } as unknown as BangumiDataProvider;
    const service = new SonGuessrService({
      musicProvider: provider,
      bangumiProvider,
      random: { nextInt: (max: number) => Math.max(0, max - 1) },
    });
    const host = connection(service, "anime-year-host");
    const guest = connection(service, "anime-year-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "年榜玩家");
    await execute(service, host, {
      id: "year-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionType: "anime",
        questionMode: "automatic",
        animeAutoFilters: { startYear: 2020, endYear: 2022, ranking: "year", subjectLimit: 3 },
      },
    });
    await execute(service, guest, {
      id: "year-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "year-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });

    expect(requestedFilters).toEqual([{
      startYear: 2022,
      endYear: 2022,
      ranking: "year",
      subjectLimit: 3,
      songMinPopularity: 0,
      trackKinds: [...ALL_BANGUMI_TRACK_KINDS],
    }]);
  });

  test("听歌猜番歌曲热度不达标时优先尝试同作品其它曲目", async () => {
    const low = { ...songs.wrong, id: "low", title: "低热度歌", popularity: 10 };
    const high = { ...songs.answer, id: "high", title: "高热度歌", popularity: 100_000 };
    const bangumiProvider = {
      searchSubjects: async () => [anime],
      getSubject: async () => ({ ...anime, musicTracks: [
        { title: "低热度歌", artist: "测试歌手", kind: "opening" },
        { title: "高热度歌", artist: "测试歌手", kind: "ending" },
      ] }),
    } as unknown as BangumiDataProvider;
    const musicProvider: MusicProvider = {
      ...provider,
      search: async (keyword) => keyword.includes("低热度歌") ? [low] : [high],
      getSong: async (id) => id === "low" ? low : high,
    };
    const service = new SonGuessrService({ musicProvider, bangumiProvider });
    const host = connection(service, "anime-hotness-host");
    const guest = connection(service, "anime-hotness-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "热度玩家");
    await execute(service, host, { id: "settings", type: "song.room.updateSettings", roomId: "1234", payload: {
      questionType: "anime", questionMode: "automatic", animeAutoFilters: { songMinPopularity: 100_000, trackKinds: ["opening", "ending"] },
    } });
    await execute(service, guest, { id: "ready", type: "song.player.setReady", roomId: "1234", payload: { ready: true } });
    await execute(service, host, { id: "start", type: "song.game.start", roomId: "1234", payload: {} });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound?.audioUrl).toBe(high.audioUrl);
  });

  test("歌名匹配度门禁精准识别兼容版本并拒绝无关歌曲", () => {
    expect(isSongTitleMatch("答案歌", "答案歌")).toBe(true);
    expect(isSongTitleMatch("Cagayake!GIRLS [5人Ver.]", "Cagayake!GIRLS")).toBe(true);
    expect(isSongTitleMatch("だんご大家族", "メグメル／だんご大家族")).toBe(true);
    expect(isSongTitleMatch("TAKE ME HIGHER (コロムビア・カヴァー・ヴァージョン)", "石原立也")).toBe(false);
    expect(isSongTitleMatch("战斗! 原始回归", "轻音少女")).toBe(false);
    expect(isSongTitleMatch("A", "B")).toBe(false);
  });

  test("听歌猜番拒绝歌名与曲目不匹配的异形歌曲", async () => {
    const unrelated = { ...songs.wrong, id: "unrelated", title: "TAKE ME HIGHER" };
    const matched = { ...songs.answer, id: "matched", title: "答案歌" };
    const bangumiProvider = {
      searchSubjects: async () => [anime],
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "答案歌", artist: "测试歌手", kind: "opening" }],
      }),
    } as unknown as BangumiDataProvider;

    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [unrelated, matched], // 异形歌排第一，匹配歌排第二
      getSong: async (id) => id === "unrelated" ? unrelated : matched,
    };

    const service = new SonGuessrService({ musicProvider, bangumiProvider });
    const host = connection(service, "anime-mismatch-host");
    const guest = connection(service, "anime-mismatch-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "猜番玩家");
    await execute(service, host, {
      id: "settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { questionType: "anime", questionMode: "automatic" },
    });
    await execute(service, guest, { id: "ready", type: "song.player.setReady", roomId: "1234", payload: { ready: true } });
    await execute(service, host, { id: "start", type: "song.game.start", roomId: "1234", payload: {} });

    // 必须跳过排在第一的 TAKE ME HIGHER，精准选出匹配的答案歌
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound?.audioUrl).toBe(matched.audioUrl);
  });

  test("自动猜番多轮之间优先避开最近出过的番剧与歌曲", async () => {
    const anime1 = { ...anime, id: "anime-1", name: "番剧一" };
    const anime2 = { ...anime, id: "anime-2", name: "番剧二" };
    const song1 = { ...songs.answer, id: "song-1", title: "歌曲一" };
    const song2 = { ...songs.answer, id: "song-2", title: "歌曲二" };

    const bangumiProvider = {
      searchSubjects: async () => [anime1, anime2],
      getSubject: async (id: string) => id === "anime-1"
        ? { ...anime1, musicTracks: [{ title: "歌曲一", kind: "opening" }] }
        : { ...anime2, musicTracks: [{ title: "歌曲二", kind: "opening" }] },
    } as unknown as BangumiDataProvider;

    const musicProvider: MusicProvider = {
      ...provider,
      search: async (query) => query.includes("歌曲一") ? [song1] : [song2],
      getSong: async (id) => id === "song-1" ? song1 : song2,
    };

    const service = new SonGuessrService({
      musicProvider,
      bangumiProvider,
      random: { nextInt: () => 0 }, // 永远尝试第0个
    });

    const host = connection(service, "anime-dedup-host");
    const guest = connection(service, "anime-dedup-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "防重玩家");
    await execute(service, host, {
      id: "settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { questionType: "anime", questionMode: "automatic" },
    });
    await execute(service, guest, { id: "ready", type: "song.player.setReady", roomId: "1234", payload: { ready: true } });

    // 第 1 轮开始
    await execute(service, host, { id: "start-1", type: "song.game.start", roomId: "1234", payload: {} });
    const round1 = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound;
    expect(round1?.audioUrl).toBe(song1.audioUrl);

    // 音频就绪并猜对结束第 1 轮
    await execute(service, guest, { id: "audio-1", type: "song.game.audioReady", roomId: "1234", payload: { roundNumber: 1 } });
    await execute(service, guest, {
      id: "guess-1",
      type: "song.game.guessAnime",
      roomId: "1234",
      payload: { subjectId: "anime-1" },
    });
    await execute(service, host, { id: "giveup-1", type: "song.game.giveUp", roomId: "1234", payload: {} });
    const summary1 = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").roundSummary;
    expect(summary1?.anime?.id).toBe("anime-1");
    expect(summary1?.song.id).toBe("song-1");

    // 开始第 2 轮
    await execute(service, host, { id: "next-2", type: "song.game.nextRound", roomId: "1234", payload: {} });
    const round2 = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound;

    // 第 2 轮必须优先避让 anime-1，选择 anime-2 和 song-2
    expect(round2?.audioUrl).toBe(song2.audioUrl);

    await execute(service, guest, { id: "audio-2", type: "song.game.audioReady", roomId: "1234", payload: { roundNumber: 2 } });
    await execute(service, guest, {
      id: "guess-2",
      type: "song.game.guessAnime",
      roomId: "1234",
      payload: { subjectId: "anime-2" },
    });
    await execute(service, host, { id: "giveup-2", type: "song.game.giveUp", roomId: "1234", payload: {} });
    const summary2 = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").roundSummary;
    expect(summary2?.anime?.id).toBe("anime-2");
    expect(summary2?.song.id).toBe("song-2");
  });

  test("歌词不足或歌词跨度过长时降级为固定时长随机片段", () => {
    const fallback = createSongLyricClip([], 5, { nextInt: () => 12_345 }, 180_000);
    expect(fallback).toEqual({ startTime: 12_345, endTime: 42_345, lines: [] });

    const insufficient = createSongLyricClip([
      { time: 10_000, endTime: 14_000, text: "仅有一句" },
    ], 5, { nextInt: () => 7_000 }, 180_000);
    expect(insufficient).toEqual({ startTime: 7_000, endTime: 37_000, lines: [] });

    const longLineFallback = createSongLyricClip([
      { time: 10_000, endTime: 30_001, text: "跨度过长" },
    ], 1, { nextInt: () => 5_000 }, 60_000);
    expect(longLineFallback).toEqual({ startTime: 5_000, endTime: 11_000, lines: [] });

    const shortSong = createSongLyricClip([], 5, { nextInt: () => 0 }, 12_000);
    expect(shortSong).toEqual({ startTime: 0, endTime: 12_000, lines: [] });
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
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").players)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: guestState.playerId })]));
    await expect(execute(service, guest, {
      id: "chat-after-kick",
      type: "song.chat.send",
      payload: { text: "还在吗" },
    })).rejects.toMatchObject({ code: "PLAYER_NOT_IN_ROOM" });
  });

  test("等待阶段房主也可以按 Whoisfaker 规则切换旁观和玩家席位", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");

    await execute(service, host, {
      id: "host-watch",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").players)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: hostState.playerId, membership: "spectator", isHost: true }),
      ]));

    await execute(service, host, {
      id: "host-play",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: false },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").players)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: hostState.playerId, membership: "active", isHost: true }),
      ]));
  });

  test("断线后的空房间在宽限期后由 housekeeping 自动清理", async () => {
    let now = 0;
    const service = new SonGuessrService({ musicProvider: provider, now: () => now });
    const host = connection(service, "host");
    await createRoom(service, host);

    await service.unregisterConnection(host.record.id);
    expect(service.getRoomSummaries()).toHaveLength(1);
    await service.runHousekeeping();
    expect(service.getRoomSummaries()).toHaveLength(1);
    now += ROOM_EMPTY_GRACE_PERIOD_MS + 1;
    await service.runHousekeeping();
    expect(service.getRoomSummaries()).toHaveLength(0);
  });

  test("房主显式离开才立即清理音乐会话，房主转移保留房间会话", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "session-host");
    const guest = connection(service, "session-guest");
    await createRoom(service, host);
    const guestState = await joinRoom(service, guest, "玩家");
    await execute(service, host, {
      id: "session-transfer",
      type: "song.room.transferHost",
      roomId: "1234",
      payload: { playerId: guestState.playerId },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").musicAccountReady).toBe(true);
    await execute(service, guest, { id: "session-clear", type: "song.auth.clear", roomId: "1234", payload: {} });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").musicAccountReady).toBe(false);
  });

  test("私密房间保留在大厅列表并要求密码加入", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host, {
      visibility: "private",
      password: "secret",
      name: "私密猜歌房",
    });

    expect(service.getRoomSummaries()).toEqual([
      expect.objectContaining({ roomId: "1234", visibility: "private", hasPassword: true }),
    ]);
    await expect(joinRoom(service, guest, "玩家")).rejects.toMatchObject({ code: "PASSWORD_INCORRECT" });
    await joinRoom(service, guest, "玩家", "1234", "secret");
  });

  test("房主 Cookie 只存在房间内存、供全房请求使用并在房主离开时销毁", async () => {
    const usedCookies: Array<string | undefined> = [];
    const authProvider: MusicProvider = {
      ...provider,
      search: async (_keyword, _limit, cookie) => {
        usedCookies.push(cookie);
        return [];
      },
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { userId: "guest-account", nickname: "新房主账号" },
      }),
    };
    const service = new SonGuessrService({ musicProvider: authProvider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "玩家");

    await expect(execute(service, guest, {
      id: "guest-cannot-load-cookie",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=forbidden" },
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const login = await execute(service, host, {
      id: "cookie-login",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=host-cookie" },
    }) as {
      cookie: string;
      account: { userId?: string; nickname: string; avatarUrl?: string };
    };
    expect(login).toHaveProperty("account");
    const readySnapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(readySnapshot.musicAccountReady).toBe(true);
    expect(JSON.stringify(readySnapshot)).not.toContain("MUSIC_U=host-cookie");
    expect(JSON.stringify(guest.sent)).not.toContain("MUSIC_U=host-cookie");

    await execute(service, guest, {
      id: "search-with-host-cookie",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "测试" },
    });
    expect(usedCookies.at(-1)).toBe("MUSIC_U=host-cookie");

    await execute(service, host, {
      id: "transfer-host",
      type: "song.room.transferHost",
      roomId: "1234",
      payload: { playerId: guestState.playerId },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").musicAccountReady).toBe(true);

    await execute(service, guest, {
      id: "load-new-host-cookie",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=guest-cookie" },
    });
    await execute(service, host, {
      id: "search-with-guest-cookie",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "测试" },
    });
    expect(usedCookies.at(-1)).toBe("MUSIC_U=guest-cookie");

    await execute(service, guest, {
      id: "owner-leaves",
      type: "song.room.leave",
      roomId: "1234",
      payload: {},
    });
    const afterLeave = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(afterLeave.hostPlayerId).toBe(hostState.playerId);
    expect(afterLeave.musicAccountReady).toBe(false);
    await execute(service, host, {
      id: "search-after-owner-left",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "测试" },
    });
    expect(usedCookies.at(-1)).toBeUndefined();
  });

  test("房主连接断开时保留 Cookie，宽限期后转移房主", async () => {
    const authProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { nickname: "断线账号" },
      }),
    };
    let now = 0;
    const service = new SonGuessrService({ musicProvider: authProvider, now: () => now });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const guestState = await joinRoom(service, guest, "玩家");
    await execute(service, host, {
      id: "load-cookie-before-disconnect",
      type: "song.auth.useCookie",
      roomId: "1234",
      payload: { cookie: "MUSIC_U=disconnect-cookie" },
    });

    await service.unregisterConnection(host.record.id);
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    expect(snapshot.hostPlayerId).toBe(hostState.playerId);
    expect(snapshot.musicAccountReady).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("disconnect-cookie");
    now += HOST_RECONNECT_TIMEOUT_MS + 1;
    await service.runHousekeeping();
    const transferred = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(transferred.hostPlayerId).toBe(guestState.playerId);
    expect(transferred.musicAccountReady).toBe(true);
  });

  test("房主断线宽限期内新玩家加入不会接管房主或音乐会话", async () => {
    let now = 0;
    const service = new SonGuessrService({ musicProvider: provider, now: () => now });
    const host = connection(service, "grace-host");
    const guest = connection(service, "grace-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");

    await service.unregisterConnection(host.record.id);
    now += HOST_RECONNECT_TIMEOUT_MS - 1;
    await joinRoom(service, guest, "宽限期玩家");

    const snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(snapshot.hostPlayerId).toBe(hostState.playerId);
    expect(snapshot.musicAccountReady).toBe(true);
  });

  test("未登录网易云账号时不能开始游戏", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    await execute(service, host, {
      id: "clear-account-before-start",
      type: "song.auth.clear",
      roomId: "1234",
      payload: {},
    });
    await joinRoom(service, guest, "玩家");
    await execute(service, guest, {
      id: "ready-before-login-check",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });

    await expect(execute(service, host, {
      id: "start-without-login",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    })).rejects.toMatchObject({
      code: "MUSIC_LOGIN_REQUIRED",
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("waiting");
  });

  test("开始游戏前会重新校验 Cookie，失效后清除房间账号状态", async () => {
    let statusCalls = 0;
    const expiringProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => {
        statusCalls += 1;
        if (statusCalls > 1) throw new AppError("MUSIC_SESSION_INVALID", "登录状态已失效");
        return { cookie, account: { nickname: "即将失效", vipStatus: "vip" } };
      },
    };
    const service = new SonGuessrService({ musicProvider: expiringProvider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "玩家");
    await execute(service, guest, {
      id: "ready-before-expiry",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });

    await expect(execute(service, host, {
      id: "start-after-expiry",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    })).rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });
    expect(statusCalls).toBe(2);
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").musicAccountReady).toBe(false);
  });

  test("开始游戏校验遇到限流时透传上游错误且保留账号状态", async () => {
    let statusCalls = 0;
    const rateLimitedProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => {
        statusCalls += 1;
        if (statusCalls > 1) {
          throw new AppError("MUSIC_API_RATE_LIMITED", "操作频繁，请稍候再试");
        }
        return { cookie, account: { nickname: "限流账号", vipStatus: "vip" } };
      },
    };
    const service = new SonGuessrService({ musicProvider: rateLimitedProvider });
    const host = connection(service, "rate-limit-host");
    const guest = connection(service, "rate-limit-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "玩家");
    await execute(service, guest, {
      id: "ready-before-rate-limit",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });

    await expect(execute(service, host, {
      id: "start-during-rate-limit",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    })).rejects.toMatchObject({
      code: "MUSIC_API_RATE_LIMITED",
      message: "操作频繁，请稍候再试",
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").musicAccountReady).toBe(true);
  });

  test("非会员不能提交会员专享歌曲", async () => {
    const nonVipProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { nickname: "普通账号", vipStatus: "nonVip" },
      }),
      getSong: async (id) => ({ ...songs[id as keyof typeof songs], requiresVip: true }),
    };
    const service = new SonGuessrService({ musicProvider: nonVipProvider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "玩家");
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await execute(service, guest, {
      id: "ready-before-vip-check",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "start-before-vip-check",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "choose-before-vip-check",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });

    await expect(execute(service, host, {
      id: "submit-vip-song-without-vip",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    })).rejects.toMatchObject({
      code: "MUSIC_VIP_REQUIRED",
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase)
      .toBe("submittingSong");
  });

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
    expect(lastEvent<SonGuessrRoomSnapshot>(replacement, "song.room.snapshot").hostPlayerId)
      .toBe(replacementState.playerId);

    await execute(service, replacement, {
      id: "remove-bot",
      type: "song.test.removeBot",
      roomId: "Oblivionis",
      payload: { count: 1 },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(replacement, "song.room.snapshot").players
      .filter((player) => player.isBot)).toHaveLength(1);
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
    const botId = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").players
      .find((player) => player.isBot)!.id;

    await service.unregisterConnection(host.record.id);
    const refreshed = connection(service, "host-refreshed");
    await execute(service, refreshed, {
      id: "reconnect-after-refresh",
      type: "song.room.reconnect",
      payload: { roomId: "Oblivionis", sessionToken: hostState.sessionToken },
    });

    expect(lastEvent<SonGuessrRoomSnapshot>(refreshed, "song.room.snapshot").hostPlayerId)
      .toBe(hostState.playerId);
    await expect(execute(service, refreshed, {
      id: "kick-after-refresh",
      type: "song.room.kick",
      roomId: "Oblivionis",
      payload: { playerId: botId },
    })).resolves.toEqual({ kicked: true });
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

    const wrong = await execute(service, host, {
      id: "self-wrong-guess",
      type: "song.game.guess",
      roomId: "Oblivionis",
      payload: { songId: "wrong" },
    }) as { attempt: { result: string } };
    expect(wrong.attempt.result).toBe("wrong");
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").phase).toBe("playing");

    const correct = await execute(service, host, {
      id: "self-correct-guess",
      type: "song.game.guess",
      roomId: "Oblivionis",
      payload: { songId: "answer" },
    }) as { attempt: { result: string } };
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
    await expect(execute(service, host, {
      id: "normal-submitter-cannot-guess",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "wrong" },
    })).rejects.toMatchObject({ code: "SUBMITTER_CANNOT_GUESS" });

    await execute(service, guest, {
      id: "audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    const wrong = await execute(service, guest, {
      id: "wrong",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "wrong" },
    }) as { attempt: { feedback: { releaseYearDirection: string } } };
    expect(wrong.attempt.feedback.releaseYearDirection).toBe("higher");
    expect(lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").visibleAttempts)
      .toEqual([
        expect.objectContaining({
          playerName: "玩家",
          guessedSong: expect.objectContaining({ title: "错误歌" }),
        }),
      ]);
    expect(lastEvent<SonGuessrPrivateState>(host, "song.game.privateState").visibleAttempts)
      .toEqual([
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
    expect(result.roundSummary?.scores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ playerName: "玩家", score: 1, delta: 1 }),
        expect.objectContaining({ playerName: "房主", score: 3, delta: 3 }),
      ]),
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
    const service = new SonGuessrService({ musicProvider: refreshProvider, random: { nextInt: () => 0 } });
    const host = connection(service, "refresh-host");
    const guest = connection(service, "refresh-guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    const guestState = await joinRoom(service, guest, "刷新玩家");
    await startRound(service, host, guest, hostState.playerId);
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound?.audioUrl)
      .toBe("https://audio/refresh-1.mp3");

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
    expect(lastEvent<SonGuessrPrivateState>(refreshed, "song.game.privateState").canGiveUp).toBe(true);
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

    await expect(execute(service, guest, {
      id: "stale-ready-after-result",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    })).resolves.toEqual({ ignored: true });
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
      getSongPopularity: async (songId) => songId === "answer" ? 12_345 : 999,
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
    await expect(execute(service, host, {
      id: "playlist-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    })).resolves.toMatchObject({ started: true });
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
    const service = new SonGuessrService({ musicProvider: defaultProvider, random: { nextInt: () => 0 } });
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
    await execute(service, host, { id: "default-start", type: "song.game.start", roomId: "1234", payload: {} });
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
    const service = new SonGuessrService({ musicProvider: soloProvider, random: { nextInt: () => 0 } });
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
    expect(lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot").settings.questionMode).toBe("automatic");

    await expect(execute(service, stranger, {
      id: "solo-join",
      type: "song.room.join",
      roomId: "7777",
      payload: { userName: "路人" },
    })).rejects.toMatchObject({ code: "SOLO_ROOM_FORBIDDEN" });

    // 单人房间无需准备与指定出题人，开局后直接进入作答。
    await execute(service, solo, { id: "solo-start", type: "song.game.start", roomId: "7777", payload: {} });
    const playing = lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
    expect(playing.phase).toBe("playing");
    expect(playing.currentRound?.submitterPlayerId).toBe("");

    await execute(service, solo, { id: "solo-audio", type: "song.game.audioReady", roomId: "7777", payload: { roundNumber: 1 } });
    await execute(service, solo, { id: "solo-guess", type: "song.game.guess", roomId: "7777", payload: { songId: "answer" } });
    const settled = lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
    expect(settled.phase).toBe("roundResult");
    expect(settled.roundSummary?.correctPlayerIds).toEqual([playerId]);
    expect(settled.roundSummary?.scores).toEqual([
      { playerId, playerName: "独狼", score: 1, delta: 1, correctGuesses: 1, totalGuesses: 1 },
    ]);

    await execute(service, solo, { id: "solo-next", type: "song.game.nextRound", roomId: "7777", payload: {} });
    const nextRound = lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
    expect(nextRound.phase).toBe("playing");
    expect(nextRound.roundNumber).toBe(2);

    // 猜测次数按整局累计，不随回合重置。
    await execute(service, solo, { id: "solo-audio-2", type: "song.game.audioReady", roomId: "7777", payload: { roundNumber: 2 } });
    await execute(service, solo, { id: "solo-guess-2", type: "song.game.guess", roomId: "7777", payload: { songId: "answer" } });
    const settled2 = lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
    expect(settled2.roundSummary?.scores).toEqual([
      { playerId, playerName: "独狼", score: 2, delta: 1, correctGuesses: 2, totalGuesses: 2 },
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
    const service = new SonGuessrService({ musicProvider: autoProvider, random: { nextInt: () => 0 } });
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
    await expect(execute(service, host, {
      id: "double-start-second",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    })).rejects.toMatchObject({ code: "INVALID_PHASE" });

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
    for (const [client, id] of [[host, "host"], [guest, "guest"]] as const) {
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
    const service = new SonGuessrService({ musicProvider: failingNextProvider, random: { nextInt: () => 0 } });
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
    await execute(service, host, { id: "failed-next-start", type: "song.game.start", roomId: "1234", payload: {} });
    for (const [client, id] of [[host, "host"], [guest, "guest"]] as const) {
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

    await expect(execute(service, host, {
      id: "failed-next-command",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    })).rejects.toMatchObject({ code: "MUSIC_API_FAILED" });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot")).toMatchObject({
      phase: "roundResult",
      roundNumber: 1,
      roundSummary: summary,
    });
  });

  test("血战模式首位按正式玩家数计分且不会在首位答对后提前结算", async () => {
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
    for (const [client, id] of [[first, "first"], [second, "second"], [third, "third"]] as const) {
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
    for (const [client, id] of [[first, "first"], [second, "second"], [third, "third"]] as const) {
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
    expect(snapshot.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstState.playerId, score: 4 }),
    ]));

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
    expect(snapshot.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstState.playerId, score: 4 }),
      expect.objectContaining({ id: secondState.playerId, score: 3 }),
      expect.objectContaining({ id: thirdState.playerId, score: 2 }),
      expect.objectContaining({ name: "旁观者", score: 0, membership: "spectator" }),
    ]));
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
    const ready = await execute(service, guest, {
      id: "no-timer-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    }) as { deadlineAt?: number };
    expect(ready.deadlineAt).toBeUndefined();
    expect(lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").guessDeadlineAt)
      .toBeUndefined();
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
    expect(waiting.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "房主", score: 3, isReady: true }),
      expect.objectContaining({ name: "玩家", score: 1, isReady: false }),
    ]));

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
    expect(restarted.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "房主", score: 3 }),
      expect.objectContaining({ name: "玩家", score: 1 }),
    ]));
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
    expect(lastEvent<SonGuessrRoomSnapshot>(lateJoiner, "song.room.snapshot").players)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: lateState.playerId, membership: "spectator" }),
      ]));
    await expect(execute(service, lateJoiner, {
      id: "join-next-round",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: false },
    })).resolves.toEqual({ spectator: false, queued: true });
    expect(lastEvent<SonGuessrRoomSnapshot>(lateJoiner, "song.room.snapshot").players)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: lateState.playerId,
          membership: "spectator",
          nextRoundMembership: "active",
        }),
      ]));
    expect(lastEvent<SonGuessrPrivateState>(lateJoiner, "song.game.privateState").canGuess).toBe(false);
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
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").players)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: lateState.playerId, membership: "active" }),
      ]));
    await execute(service, host, {
      id: "choose-observer",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: observerState.playerId },
    });
    expect(lastEvent<SonGuessrPrivateState>(observer, "song.game.privateState").canSubmitSong).toBe(true);
    await execute(service, observer, {
      id: "observer-submits",
      type: "song.game.submitSong",
      roomId: "1234",
      payload: { songId: "answer" },
    });
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound)
      .toMatchObject({ submitterPlayerId: observerState.playerId });
    expect(lastEvent<SonGuessrPrivateState>(lateJoiner, "song.game.privateState").canGiveUp).toBe(true);
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
    expect(nextRound.players).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: lateState.playerId,
        membership: "spectator",
        nextRoundMembership: "active",
        online: false,
      }),
    ]));
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
    expect(snapshot.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: hostState.playerId, membership: "spectator", isHost: true }),
      expect.objectContaining({ id: guestState.playerId, membership: "spectator" }),
    ]));
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
    const service = new SonGuessrService({ musicProvider: autoProvider, random: { nextInt: () => 0 } });
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
    const firstDeadline = lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").guessDeadlineAt;
    expect(firstDeadline).toBe(now + 60_000);

    await expect(execute(service, host, {
      id: "settings-during-round",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { maxGuessesPerRound: 1, guessDurationSeconds: 10, lyricsLineCount: 3 },
    })).rejects.toMatchObject({ code: "INVALID_PHASE" });
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
    expect(lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").currentRound?.lyricClip.lines)
      .toHaveLength(5);
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

    await expect(execute(service, guest, {
      id: "search-lyric",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "歌词1" },
    })).resolves.toMatchObject({ results: expect.any(Array) });
    await expect(execute(service, guest, {
      id: "search-normal",
      type: "song.music.search",
      roomId: "1234",
      payload: { keyword: "测试歌手" },
    })).resolves.toMatchObject({ results: expect.any(Array) });
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
    const service = new SonGuessrService({ musicProvider: matchingProvider, random: { nextInt: () => 0 } });
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
    const result = await execute(service, guest, {
      id: "matching-guess",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "different-id" },
    }) as { attempt: { result: string } };
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
      const service = new SonGuessrService({ musicProvider: matchingProvider, random: { nextInt: () => 0 } });
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
      const result = await execute(service, guest, {
        id: `variant-guess-${answerTitle}`,
        type: "song.game.guess",
        roomId: "1234",
        payload: { songId: "different-id" },
      }) as { attempt: { result: string } };
      expect(result.attempt.result).toBe("correct");
    }
  });

  test("不含版本关键词的符号后缀仍属于歌名", async () => {
    const matchingProvider: MusicProvider = {
      ...provider,
      getSong: async () => ({ ...songs.answer, title: "答案歌 -- 第二章", artist: "歌手乙" }),
      getSongMetadata: async () => ({ ...songs.wrong, title: "答案歌", artist: "歌手乙" }),
    };
    const service = new SonGuessrService({ musicProvider: matchingProvider, random: { nextInt: () => 0 } });
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
    const result = await execute(service, guest, {
      id: "subtitle-guess",
      type: "song.game.guess",
      roomId: "1234",
      payload: { songId: "different-id" },
    }) as { attempt: { result: string } };
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
    expect(lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").canSubmitSong).toBe(true);
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
    await execute(service, guest, { id: "ready", type: "song.player.setReady", roomId: "1234", payload: { ready: true } });
    await execute(service, host, {
      id: "settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { maxGuessesPerRound: 1, guessDurationSeconds: 10 },
    });
    await execute(service, host, { id: "start", type: "song.game.start", roomId: "1234", payload: {} });
    await execute(service, host, { id: "choose", type: "song.game.chooseSubmitter", roomId: "1234", payload: { playerId: hostPlayerId } });
    await execute(service, host, { id: "song", type: "song.game.submitSong", roomId: "1234", payload: { songId: "answer" } });
    await execute(service, guest, { id: "audio", type: "song.game.audioReady", roomId: "1234", payload: { roundNumber: 1 } });
    const originalDeadline = lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").guessDeadlineAt;
    now += 5_000;
    await execute(service, guest, { id: "audio-again", type: "song.game.audioReady", roomId: "1234", payload: { roundNumber: 1 } });
    expect(lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").guessDeadlineAt)
      .toBe(originalDeadline);

    now += 5_000;
    await service.runHousekeeping();
    const result = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(result.phase).toBe("roundResult");
    expect(result.roundSummary?.attempts[0]).toMatchObject({ result: "timeout", playerName: "玩家" });
    expect(result.roundSummary?.scores).toEqual(
      expect.arrayContaining([expect.objectContaining({ playerName: "房主", score: 5 })]),
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
    await execute(service, guest1, { id: "ready-1", type: "song.player.setReady", roomId: "1234", payload: { ready: true } });
    await execute(service, guest2, { id: "ready-2", type: "song.player.setReady", roomId: "1234", payload: { ready: true } });

    await execute(service, host, { id: "start", type: "song.game.start", roomId: "1234", payload: {} });
    await execute(service, host, { id: "choose", type: "song.game.chooseSubmitter", roomId: "1234", payload: { playerId: hostState.playerId } });
    await execute(service, host, { id: "song", type: "song.game.submitSong", roomId: "1234", payload: { songId: "answer" } });

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
    await execute(service, guest1, { id: "give-up-1", type: "song.game.giveUp", roomId: "1234", payload: {} });
    await execute(service, guest2, { id: "give-up-2", type: "song.game.giveUp", roomId: "1234", payload: {} });

    await execute(service, host, { id: "next-round", type: "song.game.nextRound", roomId: "1234", payload: {} });

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
    expect(snapshot.players.find((p) => p.id === guestState.playerId)?.nextRoundMembership).toBe("spectator");

    // 玩家第二次点击下轮加入旁观：撤销预约
    await execute(service, guest, {
      id: "cancel-queue-spec",
      type: "song.player.setSpectator",
      roomId: "1234",
      payload: { spectator: true },
    });
    snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(snapshot.players.find((p) => p.id === guestState.playerId)?.nextRoundMembership).toBeUndefined();
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
      payload: { autoFilters: { playlist: { id: "https://music.163.com/playlist?id=12345678&userid=999" }, artists: [], minPopularity: 0 } },
    });
    snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.settings.autoFilters.playlist?.id).toBe("12345678");

    // 3. SPA Hash 路由 URL
    await execute(service, host, {
      id: "filter-hash",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { autoFilters: { playlist: { id: "https://music.163.com/#/playlist?id=87654321" }, artists: [], minPopularity: 0 } },
    });
    snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.settings.autoFilters.playlist?.id).toBe("87654321");
  });

  test("并发猜歌时前置占锁与配额保护，禁止突破猜测上限", async () => {
    let metadataCalls = 0;
    const slowProvider: MusicProvider = {
      ...provider,
      getSongMetadata: async (id) => {
        metadataCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return songs[id as keyof typeof songs] ?? songs.wrong;
      },
    };
    const service = new SonGuessrService({ musicProvider: slowProvider, random: { nextInt: () => 0 } });
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

    // 时间前移 85 秒（超过 80 秒的回合全局硬超时 hardDeadlineAt）
    mockTime += 85_000;
    await service.runHousekeeping();

    const finalSnapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(finalSnapshot.phase).toBe("roundResult");
    expect(finalSnapshot.roundSummary).toBeDefined();
  });

  test("创建、加入与重连指令直接返回完整快照与私有状态，杜绝客户端加载悬挂", async () => {
    const service = new SonGuessrService({ musicProvider: provider, random: { nextInt: () => 0 } });
    const host = connection(service, "host-ack");
    const guest = connection(service, "guest-ack");

    const created = (await createRoom(service, host, { roomId: "9876", userName: "房主Ack" })) as any;
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
      SERVER_SHUTDOWN_MESSAGE,
    );
  });
});

describe("SonGuessrService 番剧出题回源性能约束", () => {
  // 单人房间默认自动出题，开局即走番剧自动题库路径，省去准备与指定出题人的前置步骤。
  const animeSolo = async (musicProvider: MusicProvider, bangumiProvider: BangumiDataProvider) => {
    const service = new SonGuessrService({ musicProvider, bangumiProvider, random: { nextInt: () => 0 } });
    const solo = connection(service, "anime-solo");
    await createRoom(service, solo, { roomId: "8888", name: "猜番单人", userName: "独狼", solo: true });
    await execute(service, solo, {
      id: "anime-solo-settings",
      type: "song.room.updateSettings",
      roomId: "8888",
      payload: { questionType: "anime" },
    });
    return { service, solo };
  };

  test("同一曲目的多个检索词并行回源，不逐个串行等待", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const noArtistAnime: BangumiSubjectDetails = {
      ...anime,
      musicTracks: [{ title: "答案歌", kind: "opening" }],
    };
    const slowProvider = {
      ...provider,
      search: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return [songs.answer];
      },
    } as unknown as MusicProvider;

    const { service, solo } = await animeSolo(slowProvider, {
      getSubject: async () => noArtistAnime,
      searchSubjects: async () => [noArtistAnime],
    } as unknown as BangumiDataProvider);

    await execute(service, solo, { id: "start", type: "song.game.start", roomId: "8888", payload: {} });

    // 无 artist 的曲目会派生「曲名+原名」「曲名+中文名」「曲名」三个检索词。
    expect(maxInFlight).toBe(3);
    expect(lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot").phase).toBe("playing");
  });

  test("检索词无命中时上游调用受预算约束，不会遍历完所有曲目", async () => {
    let searches = 0;
    const unmatchedAnime: BangumiSubjectDetails = {
      ...anime,
      musicTracks: Array.from({ length: 24 }, (_, index) => ({
        title: `未收录曲目${index}`,
        kind: "opening" as const,
      })),
    };
    const missProvider = {
      ...provider,
      search: async () => {
        searches += 1;
        return [songs.wrong];
      },
      getSong: async () => {
        throw new Error("标题未命中时不应回源歌曲详情");
      },
    } as unknown as MusicProvider;

    const { service, solo } = await animeSolo(missProvider, {
      getSubject: async () => unmatchedAnime,
      searchSubjects: async () => [unmatchedAnime],
    } as unknown as BangumiDataProvider);

    await expect(execute(service, solo, { id: "start", type: "song.game.start", roomId: "8888", payload: {} }))
      .rejects.toMatchObject({ code: "BANGUMI_NO_MUSIC" });

    expect(searches).toBe(ANIME_SONG_LOOKUP_BUDGET);
    expect(searches).toBeLessThan(24 * 3);
  });

  test("自动番剧出题的候选重试受上界约束", async () => {
    let subjects = 0;
    const silentAnime: BangumiSubjectDetails = { ...anime, musicTracks: [] };

    const { service, solo } = await animeSolo(provider, {
      getSubject: async () => {
        subjects += 1;
        return silentAnime;
      },
      // 题库给出 50 个候选，但每个都没有可识别的主题曲。
      searchSubjects: async () => Array.from({ length: 50 }, (_, index) => ({
        id: `subject-${index}`,
        name: `Anime ${index}`,
        nameCn: `番剧${index}`,
        imageUrl: "",
      })),
    } as unknown as BangumiDataProvider);

    await expect(execute(service, solo, { id: "start", type: "song.game.start", roomId: "8888", payload: {} }))
      .rejects.toMatchObject({ code: "BANGUMI_NO_MUSIC" });

    expect(subjects).toBe(AUTO_ANIME_CANDIDATE_LIMIT);
    expect(subjects).toBeLessThan(50);
  });
});

describe("SonGuessrService 猜番原版优先", () => {
  /** 单人房间自动出题，直接用番剧题库路径验证选歌结果。 */
  const animeSoloRound = async (musicProvider: MusicProvider, bangumiProvider: BangumiDataProvider) => {
    const service = new SonGuessrService({ musicProvider, bangumiProvider, random: { nextInt: () => 0 } });
    const solo = connection(service, "anime-original-solo");
    await createRoom(service, solo, { roomId: "8888", name: "猜番单人", userName: "独狼", solo: true });
    await execute(service, solo, {
      id: "anime-original-settings",
      type: "song.room.updateSettings",
      roomId: "8888",
      payload: { questionType: "anime" },
    });
    await execute(service, solo, { id: "start", type: "song.game.start", roomId: "8888", payload: {} });
    return lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
  };

  test("原版与翻唱同时存在时优先选中原版", async () => {
    const original = {
      ...songs.answer,
      id: "original",
      title: "secret base ~君がくれたもの~",
      artist: "ZONE",
      album: "secret base ~君がくれたもの~",
    };
    const cover = {
      ...songs.answer,
      id: "cover",
      title: "secret base ~君がくれたもの~ (secret base ~你所赠予之物~)",
      artist: "先生と牛 / 银子 / 悼子Qrel",
      album: "secret base ~君がくれたもの~ 翻唱合集",
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "secret base ~君がくれたもの~", artist: "ZONE", kind: "insert" }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;
    // 翻唱版排在搜索结果首位，模拟网易云把翻唱混排在原版之前。
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [cover, original],
      getSong: async (id) => id === "cover" ? cover : original,
    };

    const snapshot = await animeSoloRound(musicProvider, bangumiProvider);
    expect(snapshot.currentRound?.audioUrl).toBe(original.audioUrl);
  });

  test("仅能召回翻唱版时仍可出题，不因缺少原版而失败", async () => {
    const cover = {
      ...songs.answer,
      id: "cover-only",
      title: "答案歌 (翻唱)",
      artist: "翻唱歌手",
      album: "翻唱专辑",
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "答案歌", artist: "原唱歌手", kind: "opening" }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [cover],
      getSong: async () => cover,
    };

    const snapshot = await animeSoloRound(musicProvider, bangumiProvider);
    expect(snapshot.currentRound?.audioUrl).toBe(cover.audioUrl);
  });

  test("歌手名不一致时通过番剧名宽检索召回原版", async () => {
    const original = {
      ...songs.answer,
      id: "original-broad",
      title: "答案歌",
      artist: "ZONE",
      album: "答案歌",
    };
    const cover = {
      ...songs.answer,
      id: "cover-broad",
      title: "答案歌 (Cover)",
      artist: "某翻唱者",
      album: "翻唱合集",
    };
    // 只按「曲名+番剧名」能召回原版，按「曲名+Bangumi 歌手名」只能召回翻唱。
    const musicProvider: MusicProvider = {
      ...provider,
      search: async (keyword) => keyword.includes("Answer Anime") ? [original] : [cover],
      getSong: async (id) => id === "original-broad" ? original : cover,
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "答案歌", artist: "不存在的歌手名", kind: "opening" }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;

    const snapshot = await animeSoloRound(musicProvider, bangumiProvider);
    expect(snapshot.currentRound?.audioUrl).toBe(original.audioUrl);
  });
});



