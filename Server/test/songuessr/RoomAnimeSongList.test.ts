import { describe, expect, test } from "bun:test";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import { BangumiDataProvider } from "../../src/infrastructure/BangumiDataProvider";
import { MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { fakeBangumiProvider } from "../support/Providers";
import {
  ALL_BANGUMI_TRACK_KINDS,
  BangumiMusicTrack,
  BangumiSubjectDetails,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
  SongDetails,
  SongSearchResult,
} from "../../src/shared/Index";
import {
  anime,
  chosenSongId,
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  provider,
  songs,
  wrongAnime,
} from "./Fixtures";

describe("SonGuessrService", () => {
  test("听歌猜番手动出题支持查询匹配歌曲并指定关联曲出题", async () => {
    const multiTrackAnime: BangumiSubjectDetails = {
      ...anime,
      id: "anime-multi",
      name: "双曲番",
      nameCn: "双曲番",
      musicTracks: [
        { title: "答案歌", artist: "测试歌手", kind: "opening" },
        { title: "第二首曲目", artist: "测试歌手", kind: "ending" },
      ],
    };
    const secondSong: SongDetails = {
      ...songs.answer,
      id: "song-second",
      title: "第二首曲目",
      artist: "测试歌手",
      album: "双曲番 ED",
    };
    const customMusicProvider = {
      ...provider,
      search: async (keyword: string) => {
        if (keyword.includes("第二首曲目")) return [secondSong];
        return [songs.answer];
      },
      getSong: async (id: string) => (id === "song-second" ? secondSong : songs.answer),
    };
    const customBangumiProvider = fakeBangumiProvider({
      getSubject: async (id: string) => (id === "anime-multi" ? multiTrackAnime : anime),
      searchSubjects: async () => [multiTrackAnime],
    });

    const service = new SonGuessrService({
      musicProvider: customMusicProvider,
      bangumiProvider: customBangumiProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "玩家2");
    await execute(service, host, {
      id: "settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { questionType: "anime", questionMode: "manual" },
    });
    await execute(service, guest, {
      id: "guest-ready",
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

    // 1. 查询该番剧匹配成功的所有歌曲候选
    const queryResult = await execute<{
      results: Array<{ song: SongSearchResult; track: BangumiMusicTrack }>;
    }>(service, host, {
      id: "query-songs",
      type: "song.bangumi.songs",
      roomId: "1234",
      payload: { subjectId: "anime-multi" },
    });
    expect(queryResult.results).toHaveLength(2);
    expect(queryResult.results.map((r) => r.song.id)).toEqual(["answer", "song-second"]);

    // 2. 出题人自主选择第二首歌作为目标关联曲出题
    await execute(service, host, {
      id: "submit-with-song",
      type: "song.game.submitAnime",
      roomId: "1234",
      payload: { subjectId: "anime-multi", songId: "song-second" },
    });

    const snapshot = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot");
    expect(snapshot.phase).toBe("playing");
    expect(chosenSongId(service, "1234")).toBe(secondSong.id);
  });

  /** 建好房间并查询番剧的关联曲候选列表（手动出题的选曲面板走这条命令）。 */
  const queryAnimeSongs = async (
    musicProvider: MusicProvider,
    bangumiProvider: BangumiDataProvider,
    subjectId: string,
    connectionId: string
  ) => {
    const service = new SonGuessrService({
      musicProvider,
      bangumiProvider,
      random: { nextInt: () => 0 },
    });
    const host = connection(service, connectionId);
    await createRoom(service, host);
    return execute<{ results: Array<{ song: SongSearchResult }> }>(service, host, {
      id: "list",
      type: "song.bangumi.songs",
      roomId: "1234",
      payload: { subjectId },
    });
  };

  test("手动选曲列表同一曲目只显示最高分匹配", async () => {
    // 同一首 OP 在网易云常有原版 / 翻唱 / 现场等多个版本，全部列出会把选曲列表刷成
    // 「好几首一样的 OP」并把翻唱混进来。列表只保留按原版优先分排序后的首名。
    const original: SongSearchResult = {
      ...songs.answer,
      id: "orig",
      title: "答案歌",
      artist: "测试歌手",
      album: "答案歌",
    };
    const cover: SongSearchResult = {
      ...songs.answer,
      id: "cover",
      title: "答案歌 (cover)",
      artist: "翻唱歌手",
      album: "答案歌 翻唱合集",
    };
    const musicProvider: MusicProvider = {
      ...provider,
      // 翻唱版本排在搜索结果更前，验证列表取的是最高分而不是首个结果。
      search: async () => [cover, original],
    };
    const result = await queryAnimeSongs(
      musicProvider,
      fakeBangumiProvider({
        getSubject: async () => anime,
        searchSubjects: async () => [anime],
      }),
      anime.id,
      "anime-list-host"
    );

    expect(result.results.map((entry) => entry.song.id)).toEqual(["orig"]);
  });

  test("同一首歌被多个条目命中时只保留一个代表", async () => {
    // 同一首歌同时挂在两条关联条目下（如「主题歌」与「单曲」）时，只由首条代表；
    // 次条目被跨条目去重挡下后**不得顺延到它的次名候选** —— 那会把翻唱版本重新带回列表。
    const original: SongSearchResult = {
      ...songs.answer,
      id: "orig",
      title: "答案歌",
      artist: "测试歌手",
      album: "答案歌",
    };
    const cover: SongSearchResult = {
      ...songs.answer,
      id: "cover",
      title: "答案歌 (cover)",
      artist: "翻唱歌手",
      album: "答案歌 翻唱合集",
    };
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [cover, original],
    };
    const result = await queryAnimeSongs(
      musicProvider,
      fakeBangumiProvider({
        getSubject: async () => ({
          ...anime,
          musicTracks: [
            { title: "答案歌", artist: "测试歌手", kind: "opening" as const },
            { title: "答案歌", artist: "测试歌手", kind: "ending" as const },
          ],
        }),
        searchSubjects: async () => [anime],
      }),
      anime.id,
      "anime-dedup-host"
    );

    expect(result.results.map((entry) => entry.song.id)).toEqual(["orig"]);
  });

  test("专辑型条目在手动选曲列表保留整张专辑的曲目", async () => {
    // 专辑兜底返回的是整张专辑的**不同曲目**（不是同一首歌的多个版本），
    // 「只保留最高分」的去重规则不适用，应全部保留供出题人挑选。
    const trackA: SongSearchResult = {
      ...songs.answer,
      id: "album-a",
      title: "角色歌 A",
      artist: "声优A",
      album: "角色歌合辑",
    };
    const trackB: SongSearchResult = {
      ...songs.answer,
      id: "album-b",
      title: "角色歌 B",
      artist: "声优B",
      album: "角色歌合辑",
    };
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [],
      searchAlbums: async () => [{ id: "album-1", name: "角色歌合辑", artist: "声优A" }],
      getAlbumSongs: async () => [trackA, trackB],
    };
    const result = await queryAnimeSongs(
      musicProvider,
      fakeBangumiProvider({
        getSubject: async () => ({
          ...anime,
          musicTracks: [{ title: "角色歌合辑", kind: "character" as const }],
        }),
        searchSubjects: async () => [anime],
      }),
      anime.id,
      "anime-album-host"
    );

    expect(result.results.map((entry) => entry.song.id).sort()).toEqual(["album-a", "album-b"]);
  });

  test("听歌猜番自动出题沿用 Bangumi 筛选并跳过无主题曲条目", async () => {
    const noMusicAnime: BangumiSubjectDetails = {
      ...wrongAnime,
      id: "anime-no-music",
      musicTracks: [],
    };
    const requestedFilters: unknown[] = [];
    const bangumiProvider = fakeBangumiProvider({
      searchSubjects: async (_keyword: string, _limit: number, filters: unknown) => {
        requestedFilters.push(filters);
        return [noMusicAnime, anime];
      },
      getSubject: async (subjectId: string) =>
        subjectId === noMusicAnime.id ? noMusicAnime : anime,
    });
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
        animeAutoFilters: {
          startYear: 2020,
          endYear: 2024,
          ranking: "all",
          subjectLimit: 2,
          songMinPopularity: 0,
          trackKinds: ["opening"],
        },
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

    expect(requestedFilters).toEqual([
      {
        startYear: 2020,
        endYear: 2024,
        ranking: "all",
        subjectLimit: 2,
        songMinPopularity: 0,
        trackKinds: ["opening"],
      },
    ]);
    expect(
      lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound?.submitterPlayerId
    ).toBe("");
    expect(
      lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").submittedAnime
    ).toBeUndefined();
  });

  test("听歌猜番年榜在设置年份范围内选择年份查询", async () => {
    const requestedFilters: unknown[] = [];
    const bangumiProvider = fakeBangumiProvider({
      searchSubjects: async (_keyword: string, _limit: number, filters: unknown) => {
        requestedFilters.push(filters);
        return [anime];
      },
      getSubject: async () => anime,
    });
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

    expect(requestedFilters).toEqual([
      {
        startYear: 2022,
        endYear: 2022,
        ranking: "year",
        subjectLimit: 3,
        songMinPopularity: 0,
        trackKinds: [...ALL_BANGUMI_TRACK_KINDS],
      },
    ]);
  });

  test("听歌猜番歌曲热度不达标时优先尝试同作品其它曲目", async () => {
    const low = { ...songs.wrong, id: "low", title: "低热度歌", popularity: 10 };
    const high = { ...songs.answer, id: "high", title: "高热度歌", popularity: 100_000 };
    const bangumiProvider = fakeBangumiProvider({
      searchSubjects: async () => [anime],
      getSubject: async () => ({
        ...anime,
        musicTracks: [
          { title: "低热度歌", artist: "测试歌手", kind: "opening" },
          { title: "高热度歌", artist: "测试歌手", kind: "ending" },
        ],
      }),
    });
    const musicProvider: MusicProvider = {
      ...provider,
      search: async (keyword) => (keyword.includes("低热度歌") ? [low] : [high]),
      getSong: async (id) => (id === "low" ? low : high),
    };
    const service = new SonGuessrService({ musicProvider, bangumiProvider });
    const host = connection(service, "anime-hotness-host");
    const guest = connection(service, "anime-hotness-guest");
    await createRoom(service, host);
    await joinRoom(service, guest, "热度玩家");
    await execute(service, host, {
      id: "settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: {
        questionType: "anime",
        questionMode: "automatic",
        animeAutoFilters: { songMinPopularity: 100_000, trackKinds: ["opening", "ending"] },
      },
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
    expect(chosenSongId(service, "1234")).toBe(high.id);
  });
});
