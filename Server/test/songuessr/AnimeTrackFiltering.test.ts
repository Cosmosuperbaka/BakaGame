import { describe, expect, test } from "bun:test";
import {
  hasAnimeSongEvidence,
  isBelowMinPopularity,
  isNonVocalTrack,
} from "../../src/application/songuessr/AnimeSongEvidence";
import {
  isSongTitleMatch,
  isUnplayableAlbumTrack,
} from "../../src/application/songuessr/SongTitleMatching";
import { type SongDetails } from "../../src/shared/Index";
import { type BangumiMusicTrack, type SongSearchResult } from "../../src/shared/SonGuessr";
import { anime, makeSong, provider, songs, startAnimeSolo } from "./Fixtures";
import { type BangumiDataProvider } from "../../src/infrastructure/BangumiDataProvider";
import { type MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { fakeBangumiProvider } from "../support/Providers";

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
    const { chosenId } = await startAnimeSolo({
      musicProvider,
      bangumiProvider,
      connectionId: "anime-nonvocal-solo",
      roomId: "8889",
    });
    return chosenId;
  };

  /** Bangumi 把整张特典 CD 挂成关联曲目，CD 里第一条就是台词轨。 */
  const bonusCdProvider = (_results: SongDetails[]) =>
    fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "サイコパス2 第5巻 特典CD", kind: "theme" }],
      }),
      searchSubjects: async () => [anime],
    });

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
    const chosenId = await animeSoloRound(musicProvider, bonusCdProvider([drama, real]));
    expect(chosenId).toBe("real");
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
describe("猜番歌曲的热度门槛", () => {
  const withPopularity = (id: string, popularity?: number) => {
    const song = makeSong(id, "歌", 2020);
    return { ...song, popularity };
  };

  test("网易云热度缺失或低于门槛都不达标，达标放行，门槛为零不筛", () => {
    expect(isBelowMinPopularity(withPopularity("netease:1"), 1_000)).toBe(true);
    expect(isBelowMinPopularity(withPopularity("netease:1", 500), 1_000)).toBe(true);
    expect(isBelowMinPopularity(withPopularity("netease:1", 5_000), 1_000)).toBe(false);
    expect(isBelowMinPopularity(withPopularity("netease:1"), 0)).toBe(false);
  });

  test("QQ 没有热度来源：缺热度不因此否决，带了热度的照常比较", () => {
    expect(isBelowMinPopularity(withPopularity("qq:1"), 1_000)).toBe(false);
    expect(isBelowMinPopularity(withPopularity("qq:1", 500), 1_000)).toBe(true);
  });
});
