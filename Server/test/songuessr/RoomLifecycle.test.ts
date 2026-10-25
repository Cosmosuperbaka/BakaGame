import { SongLyricLine } from "../../src/shared/SonGuessr";
import { LOBBY_MERGE_WINDOW_MS } from "../../src/application/LobbyFanout";
import { createSongLyricClip } from "../../src/application/songuessr/LyricClip";
import {
  albumNameScore,
  buildAlbumQueries,
  isSongTitleMatch,
} from "../../src/application/songuessr/SongTitleMatching";
import { MusicProvider } from "../../src/infrastructure/NeteaseMusicProvider";
import { BangumiDataProvider } from "../../src/infrastructure/LocalBangumiProvider";
import {
  ALL_BANGUMI_TRACK_KINDS,
  BangumiMusicTrack,
  BangumiSubjectDetails,
  SonGuessrClientMessage,
  SonGuessrPrivateState,
  SonGuessrRoomSnapshot,
  SongDetails,
  SongSearchResult,
} from "../../src/shared/Index";
import { describe, expect, test } from "bun:test";
import {
  TestConnection,
  anime,
  connection,
  createRoom,
  execute,
  joinRoom,
  lastEvent,
  provider,
  songs,
  wrongAnime,
} from "./Fixtures";
import { SonGuessrService } from "../../src/application/SonGuessrService";

describe("SonGuessrService", () => {
  test("猜歌大厅订阅只回给自己，窗口内的多次建房并为一次下发", async () => {
    let now = Date.UTC(2026, 3, 10);
    let pendingFlush: { at: number; flush: () => void } | undefined;
    const service = new SonGuessrService({
      musicProvider: provider,
      now: () => now,
      random: { nextInt: () => 0 },
      lobbyFanoutSchedule: (flush, delayMs) => {
        pendingFlush = { at: now + delayMs, flush };
      },
    });
    const advance = (ms: number) => {
      now += ms;
      if (pendingFlush && pendingFlush.at <= now) {
        const timer = pendingFlush;
        pendingFlush = undefined;
        timer.flush();
      }
    };
    const frames = (client: TestConnection) =>
      client.sent.filter((item) => item.event === "song.lobby.rooms");
    const create = async (roomId: string) =>
      execute(service, connection(service, `song-host-${roomId}`), {
        id: `create-${roomId}`,
        type: "song.room.create",
        payload: {
          roomId,
          name: `${roomId}房`,
          visibility: "public",
          allowSpectators: true,
          userName: "房主",
        },
      } as SonGuessrClientMessage);

    const first = connection(service, "song-lobby-a");
    const second = connection(service, "song-lobby-b");
    for (const client of [first, second]) {
      await execute(service, client, {
        id: `sub-${client.record.id}`,
        type: "song.lobby.subscribeRooms",
        payload: {},
      });
    }
    expect(frames(first)).toHaveLength(1);
    expect(frames(second)).toHaveLength(1);

    await create("7001");
    await create("7002");
    await create("7003");
    expect(frames(first)).toHaveLength(2);
    expect(frames(second)).toHaveLength(2);

    // 尾沿按注入时钟收敛：两次变更之间不需要新事件，整段突发一次带出。
    advance(LOBBY_MERGE_WINDOW_MS);
    expect(frames(first)).toHaveLength(3);
    const listed = (frames(first).at(-1)!.payload as Array<{ roomId: string }>)
      .map((room) => room.roomId)
      .sort();
    expect(listed).toEqual(["7001", "7002", "7003"]);
  });

  test("听歌猜番提交后只向出题人公开答案，并按 subject ID 完成猜测结算", async () => {
    const bangumiProvider = {
      getSubject: async (subjectId: string) => (subjectId === anime.id ? anime : wrongAnime),
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

    expect(
      lastEvent<SonGuessrPrivateState>(host, "song.game.privateState").submittedAnime?.id
    ).toBe(anime.id);
    expect(
      lastEvent<SonGuessrPrivateState>(guest, "song.game.privateState").submittedAnime
    ).toBeUndefined();
    await execute(service, guest, {
      id: "anime-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    await expect(
      execute(service, guest, {
        id: "anime-wrong-guess",
        type: "song.game.guessAnime",
        roomId: "1234",
        payload: { subjectId: wrongAnime.id },
      })
    ).resolves.toMatchObject({ attempt: { result: "wrong", guessedAnime: { id: wrongAnime.id } } });
    await execute(service, guest, {
      id: "anime-correct-guess",
      type: "song.game.guessAnime",
      roomId: "1234",
      payload: { subjectId: anime.id },
    });
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    expect(snapshot.phase).toBe("roundResult");
    // 本轮作答结果：猜中的人拿到一枚 correct；出题人不作答，因此不带结果。
    const marked = snapshot.players.filter((p) => p.roundMarks.length > 0);
    expect(marked.map((p) => p.roundMarks)).toEqual([["correct"]]);
    expect(
      snapshot.players.find((p) => p.id === snapshot.roundSummary?.submitterPlayerId)?.roundMarks
    ).toEqual([]);
    expect(snapshot.roundSummary?.anime?.id).toBe(anime.id);
    expect(snapshot.roundSummary?.animeTrack).toEqual({
      title: "答案歌",
      artist: "测试歌手",
      kind: "opening",
    });
    expect(snapshot.roundSummary?.song.title).toBe("答案歌");
    expect(snapshot.roundSummary?.attempts.map((attempt) => attempt.guessedAnime?.id)).toEqual([
      wrongAnime.id,
      anime.id,
    ]);
  });

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
    } as unknown as MusicProvider;
    const customBangumiProvider = {
      getSubject: async (id: string) => (id === "anime-multi" ? multiTrackAnime : anime),
      searchSubjects: async () => [multiTrackAnime],
    } as unknown as BangumiDataProvider;

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
    expect(snapshot.currentRound?.audioUrl).toBe(secondSong.audioUrl);
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
      {
        getSubject: async () => anime,
        searchSubjects: async () => [anime],
      } as unknown as BangumiDataProvider,
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
      {
        getSubject: async () => ({
          ...anime,
          musicTracks: [
            { title: "答案歌", artist: "测试歌手", kind: "opening" as const },
            { title: "答案歌", artist: "测试歌手", kind: "ending" as const },
          ],
        }),
        searchSubjects: async () => [anime],
      } as unknown as BangumiDataProvider,
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
      {
        getSubject: async () => ({
          ...anime,
          musicTracks: [{ title: "角色歌合辑", kind: "character" as const }],
        }),
        searchSubjects: async () => [anime],
      } as unknown as BangumiDataProvider,
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
    const bangumiProvider = {
      searchSubjects: async (_keyword: string, _limit: number, filters: unknown) => {
        requestedFilters.push(filters);
        return [noMusicAnime, anime];
      },
      getSubject: async (subjectId: string) =>
        subjectId === noMusicAnime.id ? noMusicAnime : anime,
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
    const bangumiProvider = {
      searchSubjects: async () => [anime],
      getSubject: async () => ({
        ...anime,
        musicTracks: [
          { title: "低热度歌", artist: "测试歌手", kind: "opening" },
          { title: "高热度歌", artist: "测试歌手", kind: "ending" },
        ],
      }),
    } as unknown as BangumiDataProvider;
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
    expect(
      lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound?.audioUrl
    ).toBe(high.audioUrl);
  });

  test("歌名匹配度门禁精准识别兼容版本并拒绝无关歌曲", () => {
    expect(isSongTitleMatch("答案歌", "答案歌")).toBe(true);
    expect(isSongTitleMatch("Cagayake!GIRLS [5人Ver.]", "Cagayake!GIRLS")).toBe(true);
    expect(isSongTitleMatch("だんご大家族", "メグメル／だんご大家族")).toBe(true);
    expect(
      isSongTitleMatch("TAKE ME HIGHER (コロムビア・カヴァー・ヴァージョン)", "石原立也")
    ).toBe(false);
    expect(isSongTitleMatch("战斗! 原始回归", "轻音少女")).toBe(false);
    expect(isSongTitleMatch("A", "B")).toBe(false);
    // 反向子串（候选是原名的截断）必须收紧：实测《いつだってYELL》匹配上 2026 年
    // 无关的《Yell》、《ぼくらは小さな悪魔》匹配上《ぼくら》，都因此把无关歌出了题。
    expect(isSongTitleMatch("Yell", "いつだってYELL")).toBe(false);
    expect(isSongTitleMatch("ぼくら", "ぼくらは小さな悪魔")).toBe(false);
    // 反向子串里「截断得不多」的仍要放行，避免误伤版本后缀差异。
    expect(isSongTitleMatch("Shooting Star", "Shooting Star 完整版")).toBe(true);
  });

  test("条目名内部的标点不构成「多曲并列」", () => {
    // 实测事故：条目 `CHAOS;CHILD AUDIO DRAMA & RADIO DIGEST VOL.1` 被 `;` / `&` 拆段后
    // 「chaos」成了一个合法段，毫不相关的《Chaos》(Parry Music) 靠这段匹配过了门禁 ——
    // 该番只有广播剧，本来就不该出题。
    expect(isSongTitleMatch("Chaos", "CHAOS;CHILD AUDIO DRAMA & RADIO DIGEST VOL.1")).toBe(false);
    expect(
      isSongTitleMatch("Chaos", "CHAOS;CHILD ドラマCD 〜拓留と世莉架は力士シールの夢を見るか?〜")
    ).toBe(false);
    // 真正的多曲并列（双 A 面 / 合作曲）仍必须放行。
    expect(isSongTitleMatch("だんご大家族", "メグメル／だんご大家族")).toBe(true);
    expect(isSongTitleMatch("ごはんはおかず", "ごはんはおかず/U&I")).toBe(true);
  });

  test("专辑名相似度认命名差异，但不认同番的其它专辑", () => {
    const animeNames = ["ひみつのアイプリ", "秘密的偶像公主"];
    const trackTitle =
      "TVアニメ『ひみつのアイプリ』キャラクターソングミニアルバム VERSE IN SONG 03";
    // 网易云的命名：少「キャラクターソングミニアルバム」、多「リング編」、「VERSEIN」还没空格。
    // 实测按条目名搜专辑返回 0 张，必须靠「番剧名 + 特征词」认出来（否则该条目永远零候选）。
    const sameSeries = "TVアニメ『ひみつのアイプリ リング編』VERSEIN SONG 03";
    expect(albumNameScore(sameSeries, trackTitle, animeNames)).toBeGreaterThan(0);
    // 同系列只差一个序号的邻张，分数必须更低 —— 否则会抽到隔壁那张的歌。
    const sibling =
      "TVアニメ『ひみつのアイプリ リング編』キャラクターソングミニアルバム VERSE IN SONG 02";
    expect(albumNameScore(sibling, trackTitle, animeNames)).toBeLessThan(
      albumNameScore(sameSeries, trackTitle, animeNames)
    );
    // 全等最高，互相包含次之（原有宽松档保留）。
    expect(albumNameScore("勇者", "勇者")).toBe(100);
    expect(albumNameScore("君の名は。 オリジナルサウンドトラック", "君の名は。")).toBeGreaterThan(
      0
    );
    // 番剧名对不上的其它作品专辑：只共享「キャラクターソング集」这种通用词也不算。
    expect(
      albumNameScore(
        "TVアニメ『别部番』キャラクターソング集",
        "TVアニメ『本番』キャラクターソング集",
        ["本番"]
      )
    ).toBe(0);
    // 不含番剧名的同名短专辑不该被认（旧的长度比例判据会误判）。
    expect(albumNameScore("另一部番 OST", "角色歌合辑", animeNames)).toBe(0);
  });

  test("专辑名恰好等于番剧名时不给分：同名撞车的「互相包含」是结构性必然", () => {
    // 实测事故：网易云用户自建的《青春ブタ野郎はバニーガール先輩の夢を見ない》（梁神，
    // 一首同名说唱）在专辑检索里靠「互相包含」拿到 60 分，压过官方《… 4 Special CD》
    // （35 分），被当成特典 CD 的曲目出了题。番剧名与条目名互为前缀时这条证据恒真。
    const entry = "青春ブタ野郎はバニーガール先輩の夢を見ない 特典CD Vol.4";
    const animeNames = [
      "青春ブタ野郎はバニーガール先輩の夢を見ない",
      "青春猪头少年不会梦到兔女郎学姐",
    ];
    expect(albumNameScore("青春ブタ野郎はバニーガール先輩の夢を見ない", entry, animeNames)).toBe(0);
    // 歌手与条目记录对得上时仍认：官方同名盘不能被这条规则连坐。
    expect(
      albumNameScore("青春ブタ野郎はバニーガール先輩の夢を見ない", entry, animeNames, true)
    ).toBeGreaterThan(0);
    // 带发行上下文（特典 CD / 原声带 / アニメ…）的同名盘照旧认。
    expect(
      albumNameScore("青春ブタ野郎はバニーガール先輩の夢を見ない 特典CD", entry, animeNames)
    ).toBeGreaterThan(0);
    // 条目名与专辑名全等时不受影响（官方盘点名就是作品名，如《君の名は。》）。
    expect(albumNameScore("君の名は。", "君の名は。", ["君の名は。"])).toBe(100);
  });

  test("专辑型条目的检索词覆盖番剧名与类型关键词", () => {
    const anime = { name: "ひみつのアイプリ", nameCn: "秘密的偶像公主" } as BangumiSubjectDetails;
    const queries = buildAlbumQueries(
      {
        title: "TVアニメ『ひみつのアイプリ』キャラクターソングミニアルバム VERSE IN SONG 03",
        kind: "character",
      },
      anime
    );
    // 条目名原样
    expect(queries).toContain(
      "TVアニメ『ひみつのアイプリ』キャラクターソングミニアルバム VERSE IN SONG 03"
    );
    // 剥掉番剧名包裹后的余部（网易云的专辑名多接近这一形态）
    expect(queries).toContain("キャラクターソングミニアルバム VERSE IN SONG 03");
    // 番剧名 + 类型关键词、以及裸番剧名（实测只有它能搜到该系列专辑）
    expect(queries).toContain("ひみつのアイプリ キャラクターソング");
    expect(queries).toContain("ひみつのアイプリ");
    expect(queries).toContain("秘密的偶像公主");

    const cluster = buildAlbumQueries(
      { title: "「クラスターエッジ」キャラクターコレクション", kind: "character" },
      { name: "CLUSTER EDGE", nameCn: "克拉斯特学院" } as BangumiSubjectDetails
    );
    // 番剧的日文片假名搜不到任何东西，但原名 / 中文名能搜出该番的歌
    expect(cluster).toContain("CLUSTER EDGE");
    expect(cluster).toContain("克拉斯特学院");
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
      getSong: async (id) => (id === "unrelated" ? unrelated : matched),
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

    // 必须跳过排在第一的 TAKE ME HIGHER，精准选出匹配的答案歌
    expect(
      lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound?.audioUrl
    ).toBe(matched.audioUrl);
  });

  test("自动猜番多轮之间优先避开最近出过的番剧与歌曲", async () => {
    const anime1 = { ...anime, id: "anime-1", name: "番剧一" };
    const anime2 = { ...anime, id: "anime-2", name: "番剧二" };
    const song1 = { ...songs.answer, id: "song-1", title: "歌曲一" };
    const song2 = { ...songs.answer, id: "song-2", title: "歌曲二" };

    const bangumiProvider = {
      searchSubjects: async () => [anime1, anime2],
      getSubject: async (id: string) =>
        id === "anime-1"
          ? { ...anime1, musicTracks: [{ title: "歌曲一", kind: "opening" }] }
          : { ...anime2, musicTracks: [{ title: "歌曲二", kind: "opening" }] },
    } as unknown as BangumiDataProvider;

    const musicProvider: MusicProvider = {
      ...provider,
      search: async (query) => (query.includes("歌曲一") ? [song1] : [song2]),
      getSong: async (id) => (id === "song-1" ? song1 : song2),
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
    await execute(service, guest, {
      id: "ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });

    // 第 1 轮开始
    await execute(service, host, {
      id: "start-1",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    const round1 = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound;
    expect(round1?.audioUrl).toBe(song1.audioUrl);

    // 音频就绪并猜对：关掉血战时一名玩家猜对即结束第 1 轮，无需再有人投降
    await execute(service, guest, {
      id: "audio-1",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    await execute(service, guest, {
      id: "guess-1",
      type: "song.game.guessAnime",
      roomId: "1234",
      payload: { subjectId: "anime-1" },
    });
    const summary1 = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").roundSummary;
    expect(summary1?.anime?.id).toBe("anime-1");
    expect(summary1?.song.id).toBe("song-1");

    // 开始第 2 轮
    await execute(service, host, {
      id: "next-2",
      type: "song.game.nextRound",
      roomId: "1234",
      payload: {},
    });
    const round2 = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").currentRound;

    // 第 2 轮必须优先避让 anime-1，选择 anime-2 和 song-2
    expect(round2?.audioUrl).toBe(song2.audioUrl);

    await execute(service, guest, {
      id: "audio-2",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 2 },
    });
    await execute(service, guest, {
      id: "guess-2",
      type: "song.game.guessAnime",
      roomId: "1234",
      payload: { subjectId: "anime-2" },
    });
    const summary2 = lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").roundSummary;
    expect(summary2?.anime?.id).toBe("anime-2");
    expect(summary2?.song.id).toBe("song-2");
  });

  test("歌词不足或歌词跨度过长时降级为固定时长随机片段", () => {
    const fallback = createSongLyricClip([], 5, { nextInt: () => 12_345 }, 180_000);
    expect(fallback).toEqual({ startTime: 12_345, endTime: 42_345, lines: [] });

    const insufficient = createSongLyricClip(
      [{ time: 10_000, endTime: 14_000, text: "仅有一句" }],
      5,
      { nextInt: () => 7_000 },
      180_000
    );
    expect(insufficient).toEqual({ startTime: 7_000, endTime: 37_000, lines: [] });

    const longLineFallback = createSongLyricClip(
      [{ time: 10_000, endTime: 30_001, text: "跨度过长" }],
      1,
      { nextInt: () => 5_000 },
      60_000
    );
    expect(longLineFallback).toEqual({ startTime: 5_000, endTime: 11_000, lines: [] });

    const shortSong = createSongLyricClip([], 5, { nextInt: () => 0 }, 12_000);
    expect(shortSong).toEqual({ startTime: 0, endTime: 12_000, lines: [] });
  });

  test("间奏造成的长行只会收缩歌词窗口，不会让整首歌丢失歌词", () => {
    // JANE DOE（米津玄師 / 宇多田ヒカル）实测：第 6 句之后有 15 秒间奏，
    // 该行跨度 14.81s 超过窗口上限。设定 7 行以上时**任何**窗口都会包含它，
    // 旧实现直接退回 lines=[]，把一首有 12 句歌词的歌显示成「纯音乐或无歌词」。
    const lines = [
      { time: 15_620, endTime: 23_010, text: "句一" },
      { time: 23_010, endTime: 30_870, text: "句二" },
      { time: 30_870, endTime: 38_240, text: "句三" },
      { time: 38_240, endTime: 45_650, text: "句四" },
      { time: 45_650, endTime: 53_040, text: "句五" },
      { time: 53_040, endTime: 67_850, text: "句六" },
      { time: 67_850, endTime: 75_230, text: "句七" },
      { time: 75_230, endTime: 82_640, text: "句八" },
      { time: 82_640, endTime: 90_020, text: "句九" },
      { time: 90_020, endTime: 93_710, text: "句十" },
      { time: 93_710, endTime: 97_420, text: "句十一" },
      { time: 97_420, endTime: 102_420, text: "句十二" },
    ];

    // 设定 7~10 行时收缩到 6 行，取间奏之后的紧凑段。
    // 提前量 700ms：上一句是行级歌词（没有逐字结束时间戳），按更短的固定提前量留渐入空间。
    for (const configured of [7, 8, 9, 10]) {
      const clip = createSongLyricClip(lines, configured, { nextInt: () => 0 }, 236_007);
      expect(clip.lines).toHaveLength(6);
      expect(clip.lines[0].text).toBe("句七");
      expect(clip.startTime).toBe(67_150);
      expect(clip.endTime).toBe(103_420);
    }

    // 设定行数本身可行时不受影响，仍按设定取满。
    const exact = createSongLyricClip(lines, 5, { nextInt: () => 0 }, 236_007);
    expect(exact.lines).toHaveLength(5);
    expect(exact.lines[0].text).toBe("句一");

    // 收缩下限为 2 行：只有单句歌词时仍判定为不可出题（保持既有语义）。
    const single = createSongLyricClip(lines.slice(0, 1), 5, { nextInt: () => 7_000 }, 180_000);
    expect(single).toEqual({ startTime: 7_000, endTime: 37_000, lines: [] });
  });

  test("跨越超过 6 秒间奏的两句歌词不会被拼入同一个出题窗口", () => {
    // 模拟《一样的月光》：第 2 句与第 3 句之间存在 54 秒超长大间奏
    const linesWithLongInterlude = [
      { time: 126_620, endTime: 130_390, text: "不再殷切 需要" },
      { time: 131_400, endTime: 136_590, text: "太多理智的世界" },
      // 54 秒长间奏
      { time: 190_700, endTime: 194_340, text: "其实看得我越来越心慌" },
      { time: 194_680, endTime: 198_530, text: "怎么你留下最真实的回忆" },
      { time: 198_700, endTime: 202_350, text: "都是提醒我失去的声音" },
    ];

    // 当设定 4 行时，由于跨间奏窗口被拒绝，算法自动收缩到 3 行并在间奏之后取连续段
    const clip = createSongLyricClip(linesWithLongInterlude, 4, { nextInt: () => 0 }, 240_000);
    expect(clip.lines).toHaveLength(3);
    expect(clip.lines[0].text).toBe("其实看得我越来越心慌");
    expect(clip.lines[1].text).toBe("怎么你留下最真实的回忆");
    expect(clip.lines[2].text).toBe("都是提醒我失去的声音");

    // 无论怎么随机挑选窗口，都绝对不会出现跨越间奏的 [太多理智的世界, 其实看得我越来越心慌] 组合
    for (let i = 0; i < 10; i++) {
      const randomClip = createSongLyricClip(
        linesWithLongInterlude,
        2,
        { nextInt: (max) => i % max },
        240_000
      );
      const texts = randomClip.lines.map((l) => l.text);
      const hasCrossInterlude =
        texts.includes("太多理智的世界") && texts.includes("其实看得我越来越心慌");
      expect(hasCrossInterlude).toBe(false);
    }
  });

  test("和声背景歌词（isBG）不会作为出题开头，也不充抵出题行数，播放时完整保留", () => {
    const linesWithBackgroundVocals = [
      { time: 10_000, endTime: 15_000, text: "第一句主歌词" },
      { time: 12_000, endTime: 14_000, text: "和声小字A (Ah~)", isBG: true },
      { time: 16_000, endTime: 20_000, text: "第二句主歌词" },
      { time: 18_000, endTime: 19_500, text: "和声小字B (Yeah~)", isBG: true },
      { time: 21_000, endTime: 25_000, text: "第三句主歌词" },
    ];

    // 设定取 2 行：应该取到两句完整主歌词，而不是主歌词+和声小字
    const clip = createSongLyricClip(linesWithBackgroundVocals, 2, { nextInt: () => 0 }, 180_000);
    // 第一行必定不是和声歌词
    expect(clip.lines[0].text).toBe("第一句主歌词");
    expect(clip.lines[0].isBG).toBeFalsy();

    // 音频结束时间必须能覆盖到第二句主歌词（20000），而不是被第一句中间的和声（14000）提早切断
    expect(clip.endTime).toBeGreaterThanOrEqual(19_750);

    // 包含两句主歌词以及随行的和声歌词供播放时演出
    const texts = clip.lines.map((l) => l.text);
    expect(texts).toContain("第一句主歌词");
    expect(texts).toContain("和声小字A (Ah~)");
    expect(texts).toContain("第二句主歌词");
  });

  test("出题窗口的提前量不越过上一句歌词的结尾", () => {
    const words = (time: number, endTime: number, text: string) => [
      { startTime: time, endTime, word: text },
    ];
    const previous: SongLyricLine = {
      time: 10_000,
      endTime: 19_700,
      text: "上一句",
      words: words(10_000, 19_700, "上一句"),
    };
    const windowLines: SongLyricLine[] = [
      { time: 20_000, endTime: 23_000, text: "题目一", words: words(20_000, 23_000, "题目一") },
      { time: 23_200, endTime: 26_000, text: "题目二", words: words(23_200, 26_000, "题目二") },
    ];
    // 窗口候选为 [上一句, 题目一] 与 [题目一, 题目二]，`nextInt` 取 1 即选中后者
    const clipOf = (prev: SongLyricLine) =>
      createSongLyricClip([prev, ...windowLines], 2, { nextInt: () => 1 }, 60_000);

    // 逐字上一句 19.7s 唱完，只剩 300ms 空隙：提前量收到 300ms，绝不听见上一句
    expect(clipOf(previous).startTime).toBe(19_700);
    // 上一句一直唱到窗口起点：不留提前量
    expect(clipOf({ ...previous, endTime: 20_000 }).startTime).toBe(20_000);
    // 空隙足够长：用满 1 秒渐入缓冲
    expect(clipOf({ ...previous, endTime: 15_000 }).startTime).toBe(19_000);
    // 行级歌词没有逐字结束时间戳（endTime 是清洗时补算的）：退回更短的固定提前量
    const { words: _words, ...lineLevelPrevious } = previous;
    expect(clipOf(lineLevelPrevious).startTime).toBe(19_300);
    // 后延缓冲不受这条规则影响
    expect(clipOf(previous).endTime).toBe(27_000);

    // 窗口就是第一句时前面只有前奏，仍留满 1 秒
    const firstWindow = createSongLyricClip(
      [previous, ...windowLines],
      2,
      { nextInt: () => 0 },
      60_000
    );
    expect(firstWindow.lines[0].text).toBe("上一句");
    expect(firstWindow.startTime).toBe(9_000);

    // 窗口前最近的一句是和声歌词：同样按它的结尾收提前量
    const withLateHarmony = createSongLyricClip(
      [
        {
          time: 19_000,
          endTime: 19_900,
          text: "和声",
          isBG: true,
          words: words(19_000, 19_900, "和声"),
        },
        ...windowLines,
      ],
      2,
      { nextInt: () => 0 },
      60_000
    );
    expect(withLateHarmony.lines[0].text).toBe("题目一");
    expect(withLateHarmony.startTime).toBe(19_900);
  });

  test("后台控制口：列出隐藏房，移走房主后重选房主，关房通知全员", async () => {
    const service = new SonGuessrService({ musicProvider: provider });
    const host = connection(service, "host");
    const guest = connection(service, "guest");
    await createRoom(service, host);
    const guestState = await joinRoom(service, guest, "玩家");
    const hostId = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState").playerId;

    const [room] = service.adminListRooms();
    expect(room).toMatchObject({
      game: "song",
      roomId: "1234",
      name: "猜歌房",
      hidden: false,
      visibility: "public",
    });
    expect(room!.players.map((player) => [player.name, player.host])).toEqual([
      ["房主", true],
      ["玩家", false],
    ]);

    await service.adminKickPlayer("1234", hostId);
    expect(lastEvent<{ roomId: string }>(host, "song.room.kicked")).toEqual({ roomId: "1234" });
    expect(lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot").hostPlayerId).toBe(
      guestState.playerId
    );
    expect(service.adminListRooms()[0]!.players.map((player) => player.name)).toEqual(["玩家"]);
    await expect(service.adminKickPlayer("1234", hostId)).rejects.toMatchObject({
      code: "PLAYER_NOT_FOUND",
    });

    await service.adminCloseRoom("1234");
    expect(lastEvent<{ reason: string }>(guest, "song.room.closed")).toMatchObject({
      reason: "admin_closed",
    });
    expect(service.adminListRooms()).toEqual([]);
    await expect(service.adminCloseRoom("1234")).rejects.toMatchObject({ code: "ROOM_NOT_FOUND" });
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
    expect(lastEvent<SonGuessrRoomSnapshot>(host, "song.room.snapshot").players).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: guestState.playerId })])
    );
    await expect(
      execute(service, guest, {
        id: "chat-after-kick",
        type: "song.chat.send",
        payload: { text: "还在吗" },
      })
    ).rejects.toMatchObject({ code: "PLAYER_NOT_IN_ROOM" });
  });
});
