import { AppError } from "../../src/domain/Errors";
import {
  ANIME_SONG_SEARCH_BUDGET,
  AUTO_ANIME_CANDIDATE_LIMIT,
  isReleaseYearOffTarget,
} from "../../src/application/songuessr/Records";
import { describe, expect, test } from "bun:test";
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
} from "./Fixtures";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import {
  resolveAlbumTrackCandidates,
  resolveAnimeLevelCandidates,
} from "../../src/application/songuessr/AnimeResolution";
import type { SonGuessrServiceInternals } from "../../src/application/songuessr/ServiceInternals";
import {
  buildAlbumQueries,
  isSongTitleMatch,
  isUnplayableAlbumTrack,
} from "../../src/application/songuessr/SongTitleMatching";
import {
  hasAnimeSongEvidence,
  isNonVocalTrack,
} from "../../src/application/songuessr/AnimeSongEvidence";
import {
  SonGuessrPrivateState,
  detectExplicitTrackKind,
  detectTrackKindFromText,
  refineTrackKindByText,
  type BangumiSubjectDetails,
  type SonGuessrRoomSnapshot,
  type SongDetails,
} from "../../src/shared/Index";
import { type BangumiMusicTrack, type SongSearchResult } from "../../src/shared/SonGuessr";
import { type MusicProvider } from "../../src/infrastructure/NeteaseMusicProvider";
import { type BangumiDataProvider } from "../../src/infrastructure/LocalBangumiProvider";

describe("SonGuessr 非歌音轨否决", () => {
  // 实测事故：Bangumi 把整张特典 CD 挂成关联曲目，网易云对应专辑里排在前面的
  // 是台词轨；曲名门禁靠「专辑名 == 条目名」放行，于是题目放出一段对白。
  test("台词 / 广播剧音轨一律否决", () => {
    expect(isNonVocalTrack("ドラマ")).toBe(true);
    expect(isNonVocalTrack("短編ドラマ「戻らない夏の日」 STAGE 0.515 「招かれざる皇子」")).toBe(
      true
    );
    expect(isNonVocalTrack("ボイスドラマ 第1話")).toBe(true);
    expect(isNonVocalTrack("Sound Drama CD Vol.2")).toBe(true);
    // 「ドラマチック / ドラマティック」是正常曲名，不能被误杀。
    expect(isNonVocalTrack("ドラマチック・ナイト")).toBe(false);
    expect(isNonVocalTrack("ドラマティックに恋したい")).toBe(false);
    expect(isNonVocalTrack("君の知らない物語")).toBe(false);
  });

  test("无人声的伴奏 / 纯音乐 / 卡拉 OK 一律否决", () => {
    expect(isNonVocalTrack("ふわふわ時間『StudioMix』(Instrumental)")).toBe(true);
    expect(isNonVocalTrack("desire (off vocal)")).toBe(true);
    expect(isNonVocalTrack("残酷な天使のテーゼ (カラオケ)")).toBe(true);
    expect(isNonVocalTrack("純音楽 version")).toBe(true);
  });

  test("电台谈话分轨一律否决（特典 CD 里塞整期广播节目）", () => {
    // 实测事故：《四月は君の嘘 第8巻 特典CD》整张就是「ラジオ 出張版」第 1~5 回，
    // 五轨全是声优闲聊，专辑路径却把它当歌出了题。
    expect(isNonVocalTrack("「四月」じゃないよ、「君嘘」だよ。ラジオ 出張版 Vol.3 #05")).toBe(true);
    expect(isNonVocalTrack("○○ラジオ 第12回")).toBe(true);
    // 正常歌名里的「ラジオ」不得误杀（只认节目分轨形态）。
    expect(isNonVocalTrack("ラジオ")).toBe(false);
    expect(isNonVocalTrack("深夜ラジオ")).toBe(false);
  });

  test("有人声的版本（现场 / 不插电 / 器乐改编）不在否决范围，交由排序降权", () => {
    expect(isNonVocalTrack("God knows... (Live)")).toBe(false);
    expect(isNonVocalTrack("secret base ~君がくれたもの~ (Acoustic ver.)")).toBe(false);
    expect(isNonVocalTrack("交响组曲「君の名は。」")).toBe(false);
  });

  /** 单人房间自动出题，直接走番剧题库路径，观察最终选中的音频。 */
  const animeSoloRound = async (
    musicProvider: MusicProvider,
    bangumiProvider: BangumiDataProvider
  ) => {
    const service = new SonGuessrService({
      musicProvider,
      bangumiProvider,
      random: { nextInt: () => 0 },
    });
    const solo = connection(service, "anime-nonvocal-solo");
    await createRoom(service, solo, {
      roomId: "8889",
      name: "猜番单人",
      userName: "独狼",
      solo: true,
    });
    await execute(service, solo, {
      id: "anime-nonvocal-settings",
      type: "song.room.updateSettings",
      roomId: "8889",
      payload: { questionType: "anime" },
    });
    await execute(service, solo, {
      id: "start",
      type: "song.game.start",
      roomId: "8889",
      payload: {},
    });
    return lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
  };

  /** Bangumi 把整张特典 CD 挂成关联曲目，CD 里第一条就是台词轨。 */
  const bonusCdProvider = (_results: SongDetails[]) =>
    ({
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "サイコパス2 第5巻 特典CD", kind: "theme" }],
      }),
      searchSubjects: async () => [anime],
    }) as unknown as BangumiDataProvider;

  test("台词轨与正歌同池时，正歌胜出", async () => {
    const drama = {
      ...songs.answer,
      id: "drama",
      title: "ドラマ",
      artist: "V.A.",
      album: "サイコパス2 第5巻 特典CD",
      audioUrl: "https://audio/drama.mp3",
    };
    const real = {
      ...songs.answer,
      id: "real",
      title: "名前のない怪物",
      artist: "EGOIST",
      album: "サイコパス2 第5巻 特典CD",
      audioUrl: "https://audio/real.mp3",
    };
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [drama, real],
      getSong: async (id) => (id === "drama" ? drama : real),
    };
    const snapshot = await animeSoloRound(musicProvider, bonusCdProvider([drama, real]));
    expect(snapshot.currentRound?.audioUrl).toBe("https://audio/real.mp3");
  });

  test("池里只有台词轨时宁可出不了题，也不放一段对白", async () => {
    const drama = {
      ...songs.answer,
      id: "drama-only",
      title: "ドラマ",
      artist: "V.A.",
      album: "サイコパス2 第5巻 特典CD",
      audioUrl: "https://audio/drama.mp3",
    };
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [drama],
      getSong: async () => drama,
    };
    await expect(animeSoloRound(musicProvider, bonusCdProvider([drama]))).rejects.toThrow(
      expect.objectContaining({ code: "BANGUMI_NO_MUSIC" })
    );
  });

  test("原声带里的纯编号轨（M-815 / Track 01）一律否决", () => {
    // 实测事故：《Dragon Ball Z ヒット曲集》被专辑路径匹配到《动画〈龙珠Z〉背景音乐原声带》，
    // 取回的第一轨是钢琴 BGM《M-815》—— 玩家听到的是配乐，不是歌。
    expect(isNonVocalTrack("M-815")).toBe(true);
    expect(isNonVocalTrack("Track 01")).toBe(true);
    expect(isNonVocalTrack("BGM 12")).toBe(true);
    expect(isNonVocalTrack("God knows...")).toBe(false);
    expect(isNonVocalTrack("WE GOTTA POWER")).toBe(false);
  });

  test("专辑路径的粗筛比全路径否决更严，两条否定互不冲突", () => {
    expect(isUnplayableAlbumTrack("ふわふわ時間『StudioMix』(Instrumental)")).toBe(true);
    expect(isUnplayableAlbumTrack("ドラマ")).toBe(true);
    // 现场版在专辑路径被剔除（不是可出的原曲），但在全路径只降权、不出局。
    expect(isUnplayableAlbumTrack("God knows... (Live)")).toBe(true);
    expect(isNonVocalTrack("God knows... (Live)")).toBe(false);
  });
});

describe("SonGuessr 番剧级兜底归属证据", () => {
  const soloRound = async (musicProvider: MusicProvider, bangumiProvider: BangumiDataProvider) => {
    const service = new SonGuessrService({
      musicProvider,
      bangumiProvider,
      random: { nextInt: () => 0 },
    });
    const solo = connection(service, "anime-level-solo");
    await createRoom(service, solo, {
      roomId: "8890",
      name: "猜番单人",
      userName: "独狼",
      solo: true,
    });
    await execute(service, solo, {
      id: "anime-level-settings",
      type: "song.room.updateSettings",
      roomId: "8890",
      payload: { questionType: "anime" },
    });
    await execute(service, solo, {
      id: "start",
      type: "song.game.start",
      roomId: "8890",
      payload: {},
    });
    return lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
  };
  /** 曲目名在网易云根本不存在，逼着走到番剧级兜底。 */
  const unreachableTrack = {
    getSubject: async () => ({
      ...anime,
      musicTracks: [{ title: "无此曲XYZ", artist: "未知歌手", kind: "theme" }],
    }),
    searchSubjects: async () => [anime],
  } as unknown as BangumiDataProvider;
  const sameNameSong = (album: string) => ({
    ...songs.answer,
    id: "same-name",
    title: "Rebirth",
    artist: "AMAST&MEDEM",
    album,
    audioUrl: "https://audio/same-name.mp3",
  });

  test("专辑名只是番剧名、没有任何发行上下文时不认归属", async () => {
    // 动画《Rebirth》(2020) 的主题歌是《Reバース GO!》，按番剧名检索却召回了同名的
    // 《Rebirth》(AMAST&MEDEM)—— 它的专辑名就叫《Rebirth》，撞的是番剧名本身。
    // 《爱丽丝梦游仙境》(1983) 同理被 2013 年的粤语同名歌顶掉。
    const song = sameNameSong("答案番剧");
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [song],
      getSong: async () => song,
    };
    await expect(soloRound(musicProvider, unreachableTrack)).rejects.toThrow(
      expect.objectContaining({ code: "BANGUMI_NO_MUSIC" })
    );
  });

  test("专辑名带动画发行上下文时照旧认归属", async () => {
    const song = sameNameSong("答案番剧 オリジナルサウンドトラック");
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [song],
      getSong: async () => song,
    };
    const snapshot = await soloRound(musicProvider, unreachableTrack);
    expect(snapshot.currentRound?.audioUrl).toBe("https://audio/same-name.mp3");
  });

  test("番剧级兜底不再放宽年代：同名却差了一代的歌不得出题", async () => {
    // 《あした天気になあれ》(1984) 被 2026 年的 CeVIO 合成音同名曲顶掉：
    // 「标题命中该番另一条目」+「年份错配兜底」两道放宽叠在一起才放过它。
    // 兜底路径已经放宽了「哪首歌」，不能再放宽「年代」。
    const song = { ...sameNameSong("答案番剧 オリジナルサウンドトラック"), releaseYear: 1980 };
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [song],
      getSong: async () => song,
    };
    await expect(soloRound(musicProvider, unreachableTrack)).rejects.toThrow(
      expect.objectContaining({ code: "BANGUMI_NO_MUSIC" })
    );
  });
});

describe("SonGuessr 曲名门禁与截断门槛一致性", () => {
  const track = (title: string, artist = ""): BangumiMusicTrack =>
    ({ title, artist, kind: "opening" }) as BangumiMusicTrack;
  const candidate = (title: string, artist = "", album = ""): SongSearchResult =>
    ({ id: "cand", title, artist, album }) as unknown as SongSearchResult;

  test("候选名只是长条目名里的一小截时，不给准入分", () => {
    // 实测事故：Bangumi 把《TVアニメ Free! キャラクターソング・デュエットシングル Vol.1》
    // 挂成关联曲目，网易云在「Free! + 角色歌」的检索里召回毫不相关的外文歌《Free》(Bling047)。
    // 它靠「被包含」拿 1 分 + 番剧上下文命中凑够证据 —— 两处口径必须都用同一道截断门槛。
    const cd = track("TVアニメ Free! キャラクターソング・デュエットシングル Vol.1", "島崎信長");
    expect(isSongTitleMatch("Free", cd.title)).toBe(false);
    expect(
      hasAnimeSongEvidence(candidate("Free", "Bling047", "Free"), cd, { animeScoped: true })
    ).toBe(false);
  });

  test("双 A 面单曲拆段命中仍然准入", () => {
    const single = track("メグメル／だんご大家族", "茶太");
    expect(hasAnimeSongEvidence(candidate("だんご大家族", "茶太"), single)).toBe(true);
  });

  test("曲名全等与「曲名 - 番剧名」这类更长的候选照旧准入", () => {
    const theme = track("ここにいたこと", "AKB48");
    expect(hasAnimeSongEvidence(candidate("ここにいたこと"), theme)).toBe(true);
    expect(hasAnimeSongEvidence(candidate("ここにいたこと (TV Size)"), theme)).toBe(true);
  });

  test("只有「番剧上下文命中」不足以锚定截断命中的候选", () => {
    // 实测事故：Princess Principal 的角色歌单曲条目《5 Moving Shadows》召回了
    // 《Moving Shadows》(Lessovsky / Max Vertigo，专辑《5 (Five Years of Kiez Beats)》)。
    // 「出现在带番剧名的检索结果里」对短名几乎恒真，不能单独充当准入证据。
    const characterSong = track("5 Moving Shadows", "アンジェ(今村彩夏) / プリンセス(関根明良)");
    const animeNames = ["プリンセス・プリンシパル", "Princess Principal"];
    expect(
      hasAnimeSongEvidence(
        candidate("Moving Shadows", "Lessovsky / Max Vertigo", "5 (Five Years of Kiez Beats)"),
        characterSong,
        { animeScoped: true, animeNames }
      )
    ).toBe(false);
    // 专辑名指向本条目的专辑（官方盘 / 自建上传常直接以曲名命名专辑）→ 照旧准入。
    expect(
      hasAnimeSongEvidence(
        candidate("Moving Shadows", "某自建上传", "5 Moving Shadows"),
        characterSong,
        { animeNames }
      )
    ).toBe(true);
    // 歌手与 Bangumi 记录对得上 → 准入。
    expect(
      hasAnimeSongEvidence(
        candidate("Moving Shadows", "アンジェ(今村彩夏)", "5 (Five Years of Kiez Beats)"),
        characterSong,
        { animeNames }
      )
    ).toBe(true);
  });
});

describe("SonGuessrService 番剧出题回源性能约束", () => {
  // 单人房间默认自动出题，开局即走番剧自动题库路径，省去准备与指定出题人的前置步骤。
  const animeSolo = async (musicProvider: MusicProvider, bangumiProvider: BangumiDataProvider) => {
    const service = new SonGuessrService({
      musicProvider,
      bangumiProvider,
      random: { nextInt: () => 0 },
    });
    const solo = connection(service, "anime-solo");
    await createRoom(service, solo, {
      roomId: "8888",
      name: "猜番单人",
      userName: "独狼",
      solo: true,
    });
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

    const { service, solo } = await animeSolo(missProvider, {
      getSubject: async () => unmatchedAnime,
      searchSubjects: async () => [unmatchedAnime],
    } as unknown as BangumiDataProvider);

    await expect(
      execute(service, solo, { id: "start", type: "song.game.start", roomId: "8888", payload: {} })
    ).rejects.toMatchObject({ code: "BANGUMI_NO_MUSIC" });

    expect(searches).toBe(ANIME_SONG_SEARCH_BUDGET);
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
      searchSubjects: async () =>
        Array.from({ length: 50 }, (_, index) => ({
          id: `subject-${index}`,
          name: `Anime ${index}`,
          nameCn: `番剧${index}`,
          imageUrl: "",
        })),
    } as unknown as BangumiDataProvider);

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

    const { service, solo } = await animeSolo(musicProvider, {
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "答案歌", artist: "测试歌手", kind: "opening" }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider);

    await execute(service, solo, {
      id: "start",
      type: "song.game.start",
      roomId: "8888",
      payload: {},
    });

    // 会员专享曲不再因为「账号不是会员」被丢弃：能否出题由 getSong 的解灰结果决定。
    expect(fetched).toEqual(["vip-song"]);
    expect(
      lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot").currentRound?.audioUrl
    ).toBe(vipOnly.audioUrl);
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

    const { service, solo } = await animeSolo(musicProvider, {
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "答案歌", artist: "测试歌手", kind: "opening" }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider);

    await execute(service, solo, {
      id: "start",
      type: "song.game.start",
      roomId: "8888",
      payload: {},
    });

    // 每次详情回源要拉歌词、音频与百科，并行验证等于把被丢弃候选的成本也付一遍。
    expect(fetched).toEqual(["候选一"]);
    expect(
      lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot").currentRound?.audioUrl
    ).toBe(candidates[0].audioUrl);
  });
});

describe("SonGuessrService 猜番原版优先", () => {
  /** 单人房间自动出题，直接用番剧题库路径验证选歌结果。 */
  const animeSoloRound = async (
    musicProvider: MusicProvider,
    bangumiProvider: BangumiDataProvider
  ) => {
    const service = new SonGuessrService({
      musicProvider,
      bangumiProvider,
      random: { nextInt: () => 0 },
    });
    const solo = connection(service, "anime-original-solo");
    await createRoom(service, solo, {
      roomId: "8888",
      name: "猜番单人",
      userName: "独狼",
      solo: true,
    });
    await execute(service, solo, {
      id: "anime-original-settings",
      type: "song.room.updateSettings",
      roomId: "8888",
      payload: { questionType: "anime" },
    });
    await execute(service, solo, {
      id: "start",
      type: "song.game.start",
      roomId: "8888",
      payload: {},
    });
    return lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
  };

  test("原版与翻唱同时存在时优先选中原版", async () => {
    const original = {
      ...songs.answer,
      id: "original",
      title: "secret base ~君がくれたもの~",
      artist: "ZONE",
      album: "secret base ~君がくれたもの~",
      audioUrl: "https://audio/original.mp3",
    };
    const cover = {
      ...songs.answer,
      id: "cover",
      title: "secret base ~君がくれたもの~ (secret base ~你所赠予之物~)",
      artist: "先生と牛 / 银子 / 悼子Qrel",
      album: "secret base ~君がくれたもの~ 翻唱合集",
      audioUrl: "https://audio/cover.mp3",
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
      getSong: async (id) => (id === "cover" ? cover : original),
    };

    const snapshot = await animeSoloRound(musicProvider, bangumiProvider);
    expect(snapshot.currentRound?.audioUrl).toBe(original.audioUrl);
  });

  test("年份容差边界：十年内放行，超出即视为同名不同曲", () => {
    expect(isReleaseYearOffTarget(2002, 2002)).toBe(false);
    // 恰好 10 年：KOTOKO 的 2012 特典盘与 2002 原版是同一录音，必须放行
    expect(isReleaseYearOffTarget(2012, 2002)).toBe(false);
    expect(isReleaseYearOffTarget(2013, 2002)).toBe(true);
    // 早得离谱同样剔除（同名老歌错配），容差是对称的
    expect(isReleaseYearOffTarget(1991, 2002)).toBe(true);
    // 任一端年份未知时不拿未知当否定
    expect(isReleaseYearOffTarget(undefined, 2002)).toBe(false);
    expect(isReleaseYearOffTarget(2023, undefined)).toBe(false);
  });

  test("同名不同曲：与番剧差一代的同名新歌让位给原版", async () => {
    // 实测 TV 动画《拜托了老师》(2002) 的 OP `Shooting Star` 被 2023 年 XG 的同名
    // 《SHOOTING STAR》顶掉：两者曲名与专辑名完全相同、打分并列（各 4 分），
    // 热门新歌靠检索顺序胜出，玩家听到的是一首完全无关的歌。
    // 发行年只在歌曲详情里返回，因此只能在候选验证阶段剔除。
    const unrelated = {
      ...songs.answer,
      id: "xg-shooting-star",
      title: "SHOOTING STAR",
      artist: "XG",
      album: "SHOOTING STAR",
      audioUrl: "https://audio/xg-shooting-star.mp3",
      releaseYear: 2023,
    };
    const original = {
      ...songs.answer,
      id: "kotoko-shooting-star",
      title: "Shooting Star",
      artist: "KOTOKO",
      album: "おねがい☆ティーチャー - Shooting Star / 空の森で",
      audioUrl: "https://audio/kotoko-shooting-star.mp3",
      releaseYear: 2002,
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        year: 2002,
        musicTracks: [{ title: "Shooting Star", kind: "opening" }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;
    const musicProvider: MusicProvider = {
      ...provider,
      // 同名新歌排在原版之前，模拟网易云的检索顺序
      search: async () => [unrelated, original],
      getSong: async (id) => (id === "xg-shooting-star" ? unrelated : original),
    };

    const snapshot = await animeSoloRound(musicProvider, bangumiProvider);
    expect(snapshot.currentRound?.audioUrl).toBe("https://audio/kotoko-shooting-star.mp3");
  });

  test("同名歌发行年未知时，靠番剧上下文命中胜出", async () => {
    // 年份校验的盲区：同名歌的详情里可能根本没有发行年（实测 GX.MARK 的
    // `releaseYear` 为 undefined），此时「未知放行」会让它顶掉原版。
    // 兜底信号是「候选是否出现在『曲名 + 番剧名』的检索结果里」——别人家的同名
    // 原创只在裸曲名检索里出现，而番剧原版总跟着番剧名一起被召回。
    const unrelated = {
      ...songs.answer,
      id: "same-name-unknown-year",
      title: "Shooting Star",
      artist: "GX.MARK",
      album: "Shooting Star",
      audioUrl: "https://audio/unrelated.mp3",
      releaseYear: undefined,
    };
    const original = {
      ...songs.answer,
      id: "kotoko-original",
      title: "Shooting Star",
      artist: "KOTOKO",
      album: "おねがい☆ティーチャー - Shooting Star / 空の森で",
      audioUrl: "https://audio/kotoko.mp3",
      releaseYear: 2002,
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        year: 2002,
        musicTracks: [{ title: "Shooting Star", kind: "opening" }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;
    const musicProvider: MusicProvider = {
      ...provider,
      // 带番剧名的检索只召回原版（真实场景里别人家的同名原创不会跟着番剧名出现）；
      // 裸曲名检索才把同名歌混进来，且排在原版之前。
      search: async (keyword) =>
        keyword.includes(anime.name) || keyword.includes(anime.nameCn)
          ? [original]
          : [unrelated, original],
      getSong: async (id) => (id === "kotoko-original" ? original : unrelated),
    };

    const snapshot = await animeSoloRound(musicProvider, bangumiProvider);
    expect(snapshot.currentRound?.audioUrl).toBe("https://audio/kotoko.mp3");
  });

  test("仅能召回翻唱版时仍可出题，不因缺少原版而失败", async () => {
    const cover = {
      ...songs.answer,
      id: "cover-only",
      title: "答案歌 (翻唱)",
      artist: "翻唱歌手",
      album: "翻唱专辑",
      audioUrl: "https://audio/cover-only.mp3",
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
      audioUrl: "https://audio/original-broad.mp3",
    };
    const cover = {
      ...songs.answer,
      id: "cover-broad",
      title: "答案歌 (Cover)",
      artist: "某翻唱者",
      album: "翻唱合集",
      audioUrl: "https://audio/cover-broad.mp3",
    };
    // 只按「曲名+番剧名」能召回原版，按「曲名+Bangumi 歌手名」只能召回翻唱。
    const musicProvider: MusicProvider = {
      ...provider,
      search: async (keyword) => (keyword.includes("Answer Anime") ? [original] : [cover]),
      getSong: async (id) => (id === "original-broad" ? original : cover),
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

  test("原声带条目按专辑名召回官方原版，而非同名器乐改编", async () => {
    // Bangumi 会把整张原声带挂成一条关联曲目（曲目名 = 专辑名，如《君の名は。》）。
    // 官方原版的曲名与曲目名完全不同，只有专辑名能命中；同名器乐改编反过来只能靠
    // 曲名命中，实测会顶掉官方原版（帝玖管弦乐团《交响组曲「君の名は。」》）。
    const arrangement = {
      ...songs.answer,
      id: "arrangement",
      title: "答案歌 交响组曲",
      artist: "某管弦乐团",
      album: "管弦乐企划",
      audioUrl: "https://audio/arrangement.mp3",
    };
    const official = {
      ...songs.answer,
      id: "official-album",
      title: "完全不同的曲名",
      artist: "原唱乐队",
      album: "答案歌",
      audioUrl: "https://audio/official-album.mp3",
    };
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [arrangement, official],
      getSong: async (id) => (id === "official-album" ? official : arrangement),
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "答案歌", kind: "ost" as const }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;

    const snapshot = await animeSoloRound(musicProvider, bangumiProvider);
    expect(snapshot.currentRound?.audioUrl).toBe(official.audioUrl);
  });

  test("翻唱即使曲名与专辑完全照抄也让位给原版", async () => {
    // 翻唱常把曲名与专辑名照抄原曲（实测《裸の勇者》：Vaundy 原版与柯奇翻版的
    // 曲名、专辑名一字不差），文本维度全部并列，只有 `originCoverType` 能认出来。
    const cover = {
      ...songs.answer,
      id: "identical-cover",
      title: "答案歌",
      artist: "同一位歌手",
      album: "答案歌",
      audioUrl: "https://audio/identical-cover.mp3",
      originCoverType: 2,
    };
    const original = {
      ...songs.answer,
      id: "identical-original",
      title: "答案歌",
      artist: "同一位歌手",
      album: "答案歌",
      audioUrl: "https://audio/identical-original.mp3",
      originCoverType: 1,
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "答案歌", artist: "同一位歌手", kind: "opening" }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;
    const musicProvider: MusicProvider = {
      ...provider,
      // 翻唱排在前面，且两者打分完全相同，只能靠版本标记区分。
      search: async () => [cover, original],
      getSong: async (id) => (id === "identical-cover" ? cover : original),
    };

    const snapshot = await animeSoloRound(musicProvider, bangumiProvider);
    expect(snapshot.currentRound?.audioUrl).toBe(original.audioUrl);
  });

  test("原版未进候选池时凭翻唱自带的原曲 ID 拉回原版", async () => {
    // 实测《你所不知道的故事》：Bangumi 存的是中文译名，按译名检索只召回到中文重填词的
    // 翻唱，日文原版《君の知らない物語》压根进不了候选池。翻唱详情里带着
    // `originSongSimpleData.songId` 直接指向原曲，必须据此把原版拉回来。
    const cover = {
      ...songs.answer,
      id: "cover-translated",
      title: "你所不知道的故事",
      artist: "某翻唱者",
      album: "你所不知道的故事",
      audioUrl: "https://audio/cover-translated.mp3",
      originCoverType: 2,
      originSongId: "original-bakemonogatari",
    };
    const original = {
      ...songs.answer,
      id: "original-bakemonogatari",
      title: "君の知らない物語",
      artist: "supercell",
      album: "君の知らない物語",
      audioUrl: "https://audio/original-bakemonogatari.mp3",
      originCoverType: 1,
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "你所不知道的故事", artist: "supercell", kind: "ending" }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;
    const musicProvider: MusicProvider = {
      ...provider,
      // 检索只能召回到翻唱；原版只能靠翻唱自带的原曲 ID 取回。
      search: async () => [cover],
      getSong: async (id) => (id === "original-bakemonogatari" ? original : cover),
    };

    const snapshot = await animeSoloRound(musicProvider, bangumiProvider);
    expect(snapshot.currentRound?.audioUrl).toBe(original.audioUrl);
  });

  test("曲名只部分命中且无任何其它证据的弱候选不再出题", async () => {
    // 实测《夢を信じて》（勇者斗恶龙）的原版就在网易云，前 5 名却全是翻唱 / 加速改编版，
    // 它们只靠曲名部分命中就拿到了出题资格。这类候选必须被准入证据挡掉：
    // 宁可这一首出不了题（上层会换下一首），也不能让玩家听到一首无关的歌。
    const weak = {
      ...songs.answer,
      id: "weak-partial",
      title: "夢を信じて (アニメ「ドラゴンクエスト」より)",
      artist: "某翻唱者",
      album: "アニメトランスBEST",
      audioUrl: "https://audio/weak-partial.mp3",
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "夢を信じて", artist: "徳永英明", kind: "ending" }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;
    const musicProvider: MusicProvider = {
      ...provider,
      // 带番剧名的检索召不回任何东西，因此弱候选拿不到「番剧上下文命中」这条证据。
      search: async (keyword) =>
        keyword.includes(anime.name) || keyword.includes(anime.nameCn) ? [] : [weak],
      getSong: async () => weak,
    };

    await expect(animeSoloRound(musicProvider, bangumiProvider)).rejects.toThrow(
      expect.objectContaining({ code: "BANGUMI_NO_MUSIC" })
    );
  });

  test("专辑型关联条目改走「搜专辑 → 取专辑曲目」", async () => {
    // Bangumi 把角色歌合辑 / OST 挂成整张专辑条目，条目名就是专辑名，拿它当歌名检索
    // 必然一无所获（实测小众番剧抽样里 character / image / theme 三类 30 条全部零候选）。
    const albumTrack = {
      ...songs.answer,
      id: "album-track",
      title: "角色歌 A",
      artist: "角色声优",
      album: "角色歌合辑",
      audioUrl: "https://audio/album-track.mp3",
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "角色歌合辑", kind: "character" as const }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;
    const musicProvider: MusicProvider = {
      ...provider,
      // 单曲检索按专辑名一无所获；专辑检索能命中同名专辑，再取回专辑曲目。
      search: async () => [],
      searchAlbums: async () => [{ id: "album-1", name: "角色歌合辑", artist: "角色声优" }],
      getAlbumSongs: async () => [albumTrack],
      getSong: async () => albumTrack,
    };

    const snapshot = await animeSoloRound(musicProvider, bangumiProvider);
    expect(snapshot.currentRound?.audioUrl).toBe(albumTrack.audioUrl);
  });

  test("专辑路径回落到条目名不符的其它专辑时不出题", async () => {
    // 网易云的专辑检索很宽松（副标题里的关键词都能命中），必须要求专辑名与条目名
    // 对得上，否则「搜 OST」会滑到另一部番的 OST，把别家的歌出成题。
    const otherAlbumTrack = {
      ...songs.answer,
      id: "other-album-track",
      title: "别家的歌",
      artist: "别的歌手",
      album: "另一部番 OST",
      audioUrl: "https://audio/other-album-track.mp3",
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "角色歌合辑", kind: "character" as const }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [],
      searchAlbums: async () => [{ id: "album-other", name: "另一部番 OST" }],
      getAlbumSongs: async () => [otherAlbumTrack],
      getSong: async () => otherAlbumTrack,
    };

    await expect(animeSoloRound(musicProvider, bangumiProvider)).rejects.toThrow(
      expect.objectContaining({ code: "BANGUMI_NO_MUSIC" })
    );
  });

  test("专辑路径的子串命中在歌手对不上时须有番剧归属，同名无关专辑被拒", async () => {
    // 实测事故：条目《TVアニメ Summer Pockets "leave a mark"》（角色歌集，艺人是
    // 本作 CV）被 LUREKS 2026 年的无关同名专辑《Leave a Mark》以「专辑名 ⊂ 条目名」
    // 的 60 分顶替出题。歌手对不上时，子串命中必须补番剧名 + 发行上下文。
    const foreignTrack = {
      ...songs.answer,
      id: "foreign-track",
      title: "Leave a Mark",
      artist: "LUREKS",
      album: "Leave a Mark",
      audioUrl: "https://audio/foreign-track.mp3",
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        musicTracks: [
          {
            title: 'TVアニメ Answer Anime "leave a mark"',
            artist: "加藤うみ(CV.田中あいみ)、空門蒼(CV.高森奈津美)",
            kind: "character" as const,
          },
        ],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [],
      searchAlbums: async () => [{ id: "album-foreign", name: "Leave a Mark", artist: "LUREKS" }],
      getAlbumSongs: async () => [foreignTrack],
      getSong: async () => foreignTrack,
    };

    await expect(animeSoloRound(musicProvider, bangumiProvider)).rejects.toThrow(
      expect.objectContaining({ code: "BANGUMI_NO_MUSIC" })
    );
  });

  test("专辑路径的子串命中在专辑名自带番剧归属时放行", async () => {
    // 网易云的正版盘经常与 Bangumi 条目名对不齐（多/少副标题），但只要专辑名
    // 含番剧名 + 发行上下文（OST / 角色歌 / テーマ…），就是确实属于本番的证据。
    const legitTrack = {
      ...songs.answer,
      id: "legit-track",
      title: "Answer Anime Main Theme",
      artist: "测试歌手",
      album: "「Answer Anime」オリジナルサウンドトラック",
      audioUrl: "https://audio/legit-track.mp3",
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "Answer Anime Original SoundTrack", kind: "ost" as const }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [],
      searchAlbums: async () => [
        {
          id: "album-ost",
          name: "「Answer Anime」オリジナルサウンドトラック",
          artist: "V.A.",
        },
      ],
      getAlbumSongs: async () => [legitTrack],
      getSong: async () => legitTrack,
    };

    const snapshot = await animeSoloRound(musicProvider, bangumiProvider);
    expect(snapshot.currentRound?.audioUrl).toBe("https://audio/legit-track.mp3");
  });

  test("专辑路径优先出原版分轨，Remix / TV Size 排后", async () => {
    // 专辑取回的曲目原本是纯 shuffle，Remix 与原版等概率被出 —— 实测
    // 《TVアニメ 『Summer Pockets』 "leave a mark"》6 轨里 3 轨是 Remix，
    // 一半概率直接出 Remix 而不是原版。版本分轨只降级不剔除。
    const remixTrack = {
      ...songs.answer,
      id: "remix-track",
      title: "答案歌 -KAIRUI Remix-",
      artist: "测试歌手",
      album: "「Answer Anime」キャラクターソング集",
      audioUrl: "https://audio/remix-track.mp3",
    };
    const originalTrack = {
      ...songs.answer,
      id: "original-track",
      title: "答案歌",
      artist: "测试歌手",
      album: "「Answer Anime」キャラクターソング集",
      audioUrl: "https://audio/original-track.mp3",
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        musicTracks: [
          { title: "「Answer Anime」キャラクターソング集", kind: "character" as const },
        ],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [],
      searchAlbums: async () => [
        { id: "album-chara", name: "「Answer Anime」キャラクターソング集", artist: "V.A." },
      ],
      getAlbumSongs: async () => [remixTrack, originalTrack],
      getSong: async (id) => (id === "remix-track" ? remixTrack : originalTrack),
    };

    const snapshot = await animeSoloRound(musicProvider, bangumiProvider);
    expect(snapshot.currentRound?.audioUrl).toBe("https://audio/original-track.mp3");
  });

  const resolveInternals = (musicProvider: MusicProvider) => {
    const service = new SonGuessrService({
      musicProvider,
      bangumiProvider: {} as BangumiDataProvider,
      random: { nextInt: () => 0 },
    });
    return service as unknown as SonGuessrServiceInternals;
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

describe("SonGuessrService 猜番出题等概率", () => {
  /**
   * 单人番剧自动出题。检索 mock 返回「与曲目同名」的歌曲，因此音频地址可反查
   * 实际选中的曲目，唯一变量就是曲目遍历顺序。
   */
  const startAnimeRound = async (
    musicProvider: MusicProvider,
    bangumiProvider: BangumiDataProvider,
    random: { nextInt: (maxExclusive: number) => number }
  ) => {
    const service = new SonGuessrService({ musicProvider, bangumiProvider, random });
    const solo = connection(service, `anime-fair-${Math.random().toString(36).slice(2, 8)}`);
    await createRoom(service, solo, {
      roomId: "8888",
      name: "猜番单人",
      userName: "独狼",
      solo: true,
    });
    await execute(service, solo, {
      id: "anime-fair-settings",
      type: "song.room.updateSettings",
      roomId: "8888",
      payload: { questionType: "anime" },
    });
    await execute(service, solo, {
      id: "anime-fair-start",
      type: "song.game.start",
      roomId: "8888",
      payload: {},
    });
    return lastEvent<SonGuessrRoomSnapshot>(solo, "song.room.snapshot");
  };

  test("关联曲目顺序不再决定选曲：所有通过筛选的曲目等概率", async () => {
    // 数据集里曲目按「片头曲优先」固定排序，改动前永远只会出第一条。
    const titles = ["第一首曲目", "第二首曲目", "第三首曲目"];
    const musicProvider: MusicProvider = {
      ...provider,
      search: async (keyword) => {
        const title = keyword.split(" ")[0];
        return [makeSong(title, title, 2020)];
      },
      getSong: async (id) => makeSong(id, id, 2020),
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        musicTracks: titles.map((title) => ({ title, kind: "opening" as const })),
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;

    // 线性同余伪随机源：取值始终落在 [0, maxExclusive) 内，既驱动洗牌也不越界。
    const seededRandom = (seed: number) => {
      let state = seed;
      return {
        nextInt: (maxExclusive: number) => {
          state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
          return state % Math.max(1, maxExclusive);
        },
      };
    };

    const chosen = new Set<string>();
    for (let seed = 1; seed <= 8; seed += 1) {
      const snapshot = await startAnimeRound(musicProvider, bangumiProvider, seededRandom(seed));
      const audioUrl = snapshot.currentRound?.audioUrl;
      expect(audioUrl).toBeDefined();
      chosen.add(audioUrl!);
    }

    // 不同随机源必须落到不同曲目上——否则说明「顺序取首位」的旧行为还在。
    expect(chosen.size).toBeGreaterThan(1);
    for (const audioUrl of chosen) {
      expect(titles.some((title) => audioUrl === `https://audio/${title}.mp3`)).toBe(true);
    }
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
  const bangumiProvider = {
    getSubject: async () => ({
      ...anime,
      musicTracks: [{ title: "片头曲", kind: "opening" as const }],
    }),
    searchSubjects: async () => [anime],
  } as unknown as BangumiDataProvider;
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

describe("SonGuessrService 猜番曲目类型校准", () => {
  /**
   * 手动出题后推进到回合结算，返回包含关联歌曲详情的结算摘要。
   * 曲目类型只在结算摘要里公开（出题阶段的快照只带音频地址）。
   */
  const animeRoundSummary = async (
    musicProvider: MusicProvider,
    bangumiProvider: BangumiDataProvider,
    guessedSubjectId: string
  ) => {
    const service = new SonGuessrService({ musicProvider, bangumiProvider });
    const host = connection(service, `anime-kind-host-${Math.random().toString(36).slice(2, 8)}`);
    const guest = connection(service, `anime-kind-guest-${Math.random().toString(36).slice(2, 8)}`);
    await createRoom(service, host);
    const hostState = lastEvent<SonGuessrPrivateState>(host, "song.game.privateState");
    await joinRoom(service, guest, "类型玩家");
    await execute(service, host, {
      id: "anime-kind-settings",
      type: "song.room.updateSettings",
      roomId: "1234",
      payload: { questionType: "anime" },
    });
    await execute(service, guest, {
      id: "anime-kind-ready",
      type: "song.player.setReady",
      roomId: "1234",
      payload: { ready: true },
    });
    await execute(service, host, {
      id: "anime-kind-start",
      type: "song.game.start",
      roomId: "1234",
      payload: {},
    });
    await execute(service, host, {
      id: "anime-kind-choose",
      type: "song.game.chooseSubmitter",
      roomId: "1234",
      payload: { playerId: hostState.playerId },
    });
    await execute(service, host, {
      id: "anime-kind-submit",
      type: "song.game.submitAnime",
      roomId: "1234",
      payload: { subjectId: anime.id },
    });
    await execute(service, guest, {
      id: "anime-kind-audio",
      type: "song.game.audioReady",
      roomId: "1234",
      payload: { roundNumber: 1 },
    });
    await execute(service, guest, {
      id: "anime-kind-guess",
      type: "song.game.guessAnime",
      roomId: "1234",
      payload: { subjectId: guessedSubjectId },
    });
    const snapshot = lastEvent<SonGuessrRoomSnapshot>(guest, "song.room.snapshot");
    if (snapshot.phase !== "roundResult" || !snapshot.roundSummary) {
      throw new AppError("BANGUMI_NO_MUSIC", `回合未结算：${snapshot.phase}`);
    }
    return snapshot.roundSummary;
  };

  /** 直接校验歌曲元数据到曲目类型的映射，避免依赖出题随机性。 */
  test("歌曲元数据明确标注片尾曲时覆盖 Bangumi 的插曲分类", () => {
    const song = {
      ...songs.answer,
      title: "喜劇《SPY×FAMILY》TV动画片尾曲)",
      album: "《间谍过家家》片尾曲ED",
    };
    expect(detectExplicitTrackKind(`${song.title} ${song.album}`)).toBe("ending");
  });

  test("片头曲与插入歌的中日文标注均可识别", () => {
    expect(
      detectExplicitTrackKind("ミックスナッツ (TVアニメ『SPY×FAMILY』オープニングテーマ)")
    ).toBe("opening");
    expect(detectExplicitTrackKind("片头曲「ミックスナッツ」")).toBe("opening");
    expect(detectExplicitTrackKind("第5话插入歌「TBD」")).toBe("insert");
    expect(detectExplicitTrackKind("劇中歌「TBD」")).toBe("insert");
  });

  test("普通歌名不会因出现 in 或 ed 片段被误判成插入歌或片尾曲", () => {
    expect(detectExplicitTrackKind("Dreaming")).toBeUndefined();
    expect(detectExplicitTrackKind("Inside Out")).toBeUndefined();
    expect(detectExplicitTrackKind("Redo")).toBeUndefined();
    expect(detectExplicitTrackKind("This Game")).toBeUndefined();
  });

  test("附带显式片尾曲标注的歌曲覆盖 Bangumi 的插曲类型", async () => {
    // 模拟 Bangumi 把片尾曲的专辑条目挂在「插入歌」下：不校准就会出现
    // 「片尾曲的歌配着插曲徽章」。
    const edSong = {
      ...songs.answer,
      id: "ed-song",
      title: "答案歌《答案番剧》TV动画片尾曲)",
      album: "《答案番剧》片尾曲ED",
    };
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [edSong],
      getSong: async () => edSong,
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "答案歌", artist: "测试歌手", kind: "insert" }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;

    const summary = await animeRoundSummary(musicProvider, bangumiProvider, anime.id);
    expect(summary.song.title).toBe(edSong.title);
    expect(summary.animeTrack?.kind).toBe("ending");
  });

  test("歌曲元数据无显式主题曲标注时保留 Bangumi 的原分类", async () => {
    const plainSong = { ...songs.answer, id: "plain-song", title: "答案歌", album: "答案专辑" };
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [plainSong],
      getSong: async () => plainSong,
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "答案歌", artist: "测试歌手", kind: "insert" }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;

    const summary = await animeRoundSummary(musicProvider, bangumiProvider, anime.id);
    expect(summary.animeTrack?.kind).toBe("insert");
  });

  test("番剧级兜底拿回的歌按歌曲自身推类型，不沿用条目的电台分类", async () => {
    // 条目是电台 CD（条目级检索必然落空），兜底按番剧名拿回的却是 OST 专辑里的曲目 ——
    // 类型跟条目走会显示成 Radio（实测《四月は君の嘘 第8巻 特典CD》就是这样）。
    const fallbackSong = {
      ...songs.answer,
      id: "fallback-ost",
      title: "答案歌",
      artist: "测试歌手",
      album: "答案番剧 オリジナルサウンドトラック",
      audioUrl: "https://audio/fallback-ost.mp3",
    };
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [fallbackSong],
      getSong: async () => fallbackSong,
    };
    const bangumiProvider = {
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "ラジオCD 出張版 Vol.1", artist: "测试歌手", kind: "radio" }],
      }),
      searchSubjects: async () => [anime],
    } as unknown as BangumiDataProvider;

    const summary = await animeRoundSummary(musicProvider, bangumiProvider, anime.id);
    expect(summary.animeTrack?.kind).toBe("ost");
  });
});

describe("SonGuessr 曲目类型细化：主题曲桶不得吞掉原声带与特典 CD", () => {
  test("带空格的 SOUND TRACK、特典 CD 不再标成主题曲", () => {
    // 用户截图反馈的三条：K-ON!! OST 的校歌、四月是你的谎言特典 CD 的 アゲイン、
    // 以及番剧级兜底召回的同名曲 —— 一律被标成「主题曲」。
    expect(
      refineTrackKindByText(
        "theme",
        "桜が丘女子高等学校校歌 百石元 K-ON!! ORIGINAL SOUND TRACK Vol.2"
      )
    ).toBe("ost");
    expect(refineTrackKindByText("theme", "アゲイン 横山克 四月は君の嘘 第3巻 特典CD")).toBe(
      "special"
    );
    expect(
      refineTrackKindByText(
        "theme",
        "不可思議のカルテ (桜島麻衣ソロVer.) 瀬戸麻沙美 青春ブタ野郎はバニーガール先輩の夢を見ない 1 Special CD"
      )
    ).toBe("special");
    // 真正的主题歌仍是主题曲。
    expect(refineTrackKindByText("theme", "残酷な天使のテーゼ")).toBe("theme");
    // 关系码已经给出具体类型时不被文本覆盖（片头 / 片尾 / 角色歌…）。
    expect(refineTrackKindByText("opening", "君のせい the peggies")).toBe("opening");
    expect(refineTrackKindByText("character", "キャラクターソング Vol.1")).toBe("character");
    // 显式标注优先于 Bangumi 的粗分类（既有语义：片尾曲的歌不能配插曲徽章）。
    expect(refineTrackKindByText("insert", "答案歌《答案番剧》TV动画片尾曲")).toBe("ending");
  });

  test("条目名里的广播剧 / 电台形态要分出来", () => {
    // 旧规则只认拉丁 `drama` / `radio`，满篇 `ドラマCD`「ラジオCD」全落进主题曲桶。
    expect(detectTrackKindFromText("ちょびっツ ドラマCD chapter.1")).toBe("drama");
    expect(detectTrackKindFromText("CLANNAD ラジオCD 渚と早苗のおまえにレインボー Vol.1")).toBe(
      "radio"
    );
    // 「ドラマチック」是正常曲名，不得误判成广播剧。
    expect(detectTrackKindFromText("ドラマチック")).toBeUndefined();
    // 原声带的关键词必须覆盖连写与带空格两种写法。
    expect(detectTrackKindFromText("君の名は。オリジナルサウンドトラック")).toBe("ost");
    expect(detectTrackKindFromText("K-ON!! ORIGINAL SOUND TRACK Vol.2")).toBe("ost");
    // 英文形态的广播剧 / 电台盘同样要分出来（CHAOS;CHILD 整条关联都是这类盘）。
    expect(detectTrackKindFromText("CHAOS;CHILD AUDIO DRAMA & RADIO DIGEST VOL.1")).toBe("drama");
    expect(detectTrackKindFromText("○○ RADIO DIGEST Vol.2")).toBe("radio");
  });
});
