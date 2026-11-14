import { describe, expect, test } from "bun:test";
import { AppError } from "../../src/domain/Errors";
import {
  ANIME_SONG_SEARCH_BUDGET,
  AUTO_ANIME_CANDIDATE_LIMIT,
} from "../../src/application/songuessr/Records";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  resolveAlbumTrackCandidates,
  resolveAnimeLevelCandidates,
} from "../../src/application/songuessr/AnimeCandidateSearch";
import { buildAlbumQueries } from "../../src/application/songuessr/SongTitleMatching";
import { type BangumiSubjectDetails, type SonGuessrRoomSnapshot } from "../../src/shared/Index";
import {
  anime,
  chosenSongId,
  connection,
  createRoom,
  execute,
  lastEvent,
  makeSong,
  provider,
  songs,
  startAnimeSolo,
} from "./Fixtures";
import { type BangumiDataProvider } from "../../src/infrastructure/BangumiDataProvider";
import { type MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { fakeBangumiProvider } from "../support/Providers";

describe("SonGuessrService 番剧出题回源性能约束", () => {
  // 单人房间默认自动出题，开局即走番剧自动题库路径，省去准备与指定出题人的前置步骤。
  const animeSolo = async (musicProvider: MusicProvider, bangumiProvider: BangumiDataProvider) => {
    const { service, solo } = await startAnimeSolo({
      musicProvider,
      bangumiProvider,
      connectionId: "anime-solo",
      roomId: "8888",
      start: false,
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

    const { service, solo } = await animeSolo(
      slowProvider,
      fakeBangumiProvider({
        getSubject: async () => noArtistAnime,
        searchSubjects: async () => [noArtistAnime],
      })
    );

    await execute(service, solo, {
      id: "start",
      type: "song.game.start",
      roomId: "8888",
      payload: {},
    });

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

    const { service, solo } = await animeSolo(
      missProvider,
      fakeBangumiProvider({
        getSubject: async () => unmatchedAnime,
        searchSubjects: async () => [unmatchedAnime],
      })
    );

    await expect(
      execute(service, solo, { id: "start", type: "song.game.start", roomId: "8888", payload: {} })
    ).rejects.toMatchObject({ code: "BANGUMI_NO_MUSIC" });

    expect(searches).toBe(ANIME_SONG_SEARCH_BUDGET);
    expect(searches).toBeLessThan(24 * 3);
  });

  test("自动番剧出题的候选重试受上界约束", async () => {
    let subjects = 0;
    const silentAnime: BangumiSubjectDetails = { ...anime, musicTracks: [] };

    const { service, solo } = await animeSolo(
      provider,
      fakeBangumiProvider({
        getSubject: async () => {
          subjects += 1;
          return silentAnime;
        },
        // 题库给出 50 个候选，但每个都没有可识别的主题曲。
        searchSubjects: async () =>
          Array.from({ length: 50 }, (_, index) => ({
            id: `subject-${index}`,
            name: `Anime ${index}`,
            nameCn: `番剧${index}`,
            imageUrl: "",
            tags: [],
            metaTags: [],
          })),
      })
    );

    await expect(
      execute(service, solo, { id: "start", type: "song.game.start", roomId: "8888", payload: {} })
    ).rejects.toMatchObject({ code: "BANGUMI_NO_MUSIC" });

    expect(subjects).toBe(AUTO_ANIME_CANDIDATE_LIMIT);
    expect(subjects).toBeLessThan(50);
  });

  test("非会员房间的会员专享候选不再被预先剔除", async () => {
    const vipOnly = { ...makeSong("vip-song", "答案歌", 2020), requiresVip: true };
    const fetched: string[] = [];
    const musicProvider: MusicProvider = {
      ...provider,
      getLoginStatus: async (cookie) => ({
        cookie,
        account: { nickname: "非会员账号", vipStatus: "nonVip" },
      }),
      search: async () => [vipOnly],
      getSong: async (id) => {
        fetched.push(id);
        return vipOnly;
      },
    };

    const { service, solo } = await animeSolo(
      musicProvider,
      fakeBangumiProvider({
        getSubject: async () => ({
          ...anime,
          musicTracks: [{ title: "答案歌", artist: "测试歌手", kind: "opening" }],
        }),
        searchSubjects: async () => [anime],
      })
    );

    await execute(service, solo, {
      id: "start",
      type: "song.game.start",
      roomId: "8888",
      payload: {},
    });

    // 会员专享曲不再因为「账号不是会员」被丢弃：能否出题由 getSong 的解灰结果决定。
    expect(fetched).toEqual(["vip-song"]);
    expect(chosenSongId(service, "8888")).toBe(vipOnly.id);
  });

  test("首个可播放候选命中后不再为被丢弃的同名候选回源详情", async () => {
    const candidates = ["候选一", "候选二", "候选三", "候选四"].map((id) =>
      makeSong(id, "答案歌", 2020)
    );
    const fetched: string[] = [];
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => candidates,
      getSong: async (id) => {
        fetched.push(id);
        return candidates.find((candidate) => candidate.id === id)!;
      },
    };

    const { service, solo } = await animeSolo(
      musicProvider,
      fakeBangumiProvider({
        getSubject: async () => ({
          ...anime,
          musicTracks: [{ title: "答案歌", artist: "测试歌手", kind: "opening" }],
        }),
        searchSubjects: async () => [anime],
      })
    );

    await execute(service, solo, {
      id: "start",
      type: "song.game.start",
      roomId: "8888",
      payload: {},
    });

    // 每次详情回源要拉歌词、音频与百科，并行验证等于把被丢弃候选的成本也付一遍。
    expect(fetched).toEqual(["候选一"]);
    expect(chosenSongId(service, "8888")).toBe(candidates[0].id);
  });
});
describe("SonGuessrService 猜番原版优先", () => {
  const resolveInternals = (musicProvider: MusicProvider) => {
    const service = new SonGuessrService({
      musicProvider,
      bangumiProvider: fakeBangumiProvider(),
      random: { nextInt: () => 0 },
    });
    return service.ctx;
  };

  /**
   * 并发探针：每个上游调用都会卡在闸门上，直到最后一个检索词发出才放行。
   * 并发时「最后一个请求发出」早于「第一个请求返回」；串行则必然相反。
   */
  const expectParallelCalls = async (
    expected: number,
    invoke: (onCall: () => Promise<void>) => Promise<void>
  ) => {
    let started = 0;
    const startedWhenSettled: number[] = [];
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const onCall = async () => {
      started += 1;
      if (started === expected) open();
      await Promise.race([gate, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
      startedWhenSettled.push(started);
    };
    await invoke(onCall);
    expect(started).toBe(expected);
    // 并发：最早返回的那个请求落地时，所有检索词都已发出；串行时它落地才发了第 1 个。
    expect(Math.min(...startedWhenSettled)).toBe(expected);
  };

  test("专辑路径的多个检索词并发回源", async () => {
    // 自动出题是实时链路，专辑路径一次要发 3~6 个检索词（条目名 / 剥壳名 / 番剧名 + 类型词 / 番剧名）。
    // 串行会把出题等待按检索词数量线性放大，玩家开局要干等好几轮网络往返。
    const albumTrack = { title: "角色歌合辑", kind: "character" as const };
    const queries = buildAlbumQueries(albumTrack, anime);
    expect(queries.length).toBeGreaterThan(1);

    await expectParallelCalls(queries.length, async (onCall) => {
      const musicProvider: MusicProvider = {
        ...provider,
        searchAlbums: async () => {
          await onCall();
          return [];
        },
        getAlbumSongs: async () => [],
      };
      await resolveAlbumTrackCandidates(
        resolveInternals(musicProvider),
        musicProvider,
        albumTrack,
        anime,
        undefined,
        { search: 20 }
      );
    });
  });

  test("番剧级兜底的番剧原名与中文名并发回源", async () => {
    let probe: () => Promise<void> = async () => {};
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => {
        await probe();
        return [];
      },
    };
    await expectParallelCalls(2, async (onCall) => {
      probe = onCall;
      await resolveAnimeLevelCandidates(
        resolveInternals(musicProvider),
        musicProvider,
        anime,
        undefined,
        { search: 20 }
      );
    });
  });
});
test("猜番取歌时凭据被判死：整段解析的租约按失败归还并摘号", async () => {
  const musicProvider: MusicProvider = {
    ...provider,
    getLoginStatus: async (cookie: string) => ({
      cookie,
      account: { platform: "netease" as const, nickname: "号主", vipStatus: "vip" as const },
    }),
    search: async () => {
      throw new AppError("MUSIC_SESSION_INVALID", "登录状态已失效");
    },
  };
  const bangumiProvider = fakeBangumiProvider({
    getSubject: async () => ({
      ...anime,
      musicTracks: [{ title: "片头曲", kind: "opening" as const }],
    }),
    searchSubjects: async () => [anime],
  });
  const service = new SonGuessrService({ musicProvider, bangumiProvider });
  const solo = connection(service, "anime-dead-account");
  await createRoom(service, solo, {
    roomId: "8887",
    name: "猜番判死",
    userName: "独狼",
    solo: true,
  });
  await execute(service, solo, {
    id: "anime-dead-auth",
    type: "song.auth.useCookie",
    roomId: "8887",
    payload: { cookie: "MUSIC_U=dead-token", platform: "netease" },
  });
  await execute(service, solo, {
    id: "anime-dead-settings",
    type: "song.room.updateSettings",
    roomId: "8887",
    payload: { questionType: "anime" },
  });

  await expect(
    execute(service, solo, {
      id: "anime-dead-start",
      type: "song.game.start",
      roomId: "8887",
      payload: {},
    })
  ).rejects.toMatchObject({ code: "MUSIC_SESSION_INVALID" });
  await execute(service, solo, {
    id: "anime-dead-sync",
    type: "song.room.requestSync",
    roomId: "8887",
    payload: {},
  });

  expect(
    lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot").musicPool?.find(
      (entry) => entry.platform === "netease"
    )
  ).toMatchObject({ enabled: false, recentOk: 0 });
});
