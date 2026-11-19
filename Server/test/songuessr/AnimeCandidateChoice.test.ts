import { describe, expect, test } from "bun:test";
import { isReleaseYearOffTarget } from "../../src/application/songuessr/Records";
import { anime, makeSong, provider, songs, startAnimeSolo } from "./Fixtures";
import { type BangumiDataProvider } from "../../src/infrastructure/BangumiDataProvider";
import { type MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { fakeBangumiProvider } from "../support/Providers";

describe("SonGuessrService 猜番原版优先", () => {
  /** 单人房间自动出题，直接用番剧题库路径验证选歌结果。 */
  const animeSoloRound = async (
    musicProvider: MusicProvider,
    bangumiProvider: BangumiDataProvider
  ) => {
    const { chosenId } = await startAnimeSolo({
      musicProvider,
      bangumiProvider,
      connectionId: "anime-original-solo",
      roomId: "8888",
    });
    return chosenId;
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
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "secret base ~君がくれたもの~", artist: "ZONE", kind: "insert" }],
      }),
      searchSubjects: async () => [anime],
    });
    // 翻唱版排在搜索结果首位，模拟网易云把翻唱混排在原版之前。
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [cover, original],
      getSong: async (id) => (id === "cover" ? cover : original),
    };

    const chosenId = await animeSoloRound(musicProvider, bangumiProvider);
    expect(chosenId).toBe(original.id);
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
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        year: 2002,
        musicTracks: [{ title: "Shooting Star", kind: "opening" }],
      }),
      searchSubjects: async () => [anime],
    });
    const musicProvider: MusicProvider = {
      ...provider,
      // 同名新歌排在原版之前，模拟网易云的检索顺序
      search: async () => [unrelated, original],
      getSong: async (id) => (id === "xg-shooting-star" ? unrelated : original),
    };

    const chosenId = await animeSoloRound(musicProvider, bangumiProvider);
    expect(chosenId).toBe("kotoko-shooting-star");
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
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        year: 2002,
        musicTracks: [{ title: "Shooting Star", kind: "opening" }],
      }),
      searchSubjects: async () => [anime],
    });
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

    const chosenId = await animeSoloRound(musicProvider, bangumiProvider);
    expect(chosenId).toBe("kotoko-original");
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
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "答案歌", artist: "原唱歌手", kind: "opening" }],
      }),
      searchSubjects: async () => [anime],
    });
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [cover],
      getSong: async () => cover,
    };

    const chosenId = await animeSoloRound(musicProvider, bangumiProvider);
    expect(chosenId).toBe(cover.id);
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
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "答案歌", artist: "不存在的歌手名", kind: "opening" }],
      }),
      searchSubjects: async () => [anime],
    });

    const chosenId = await animeSoloRound(musicProvider, bangumiProvider);
    expect(chosenId).toBe(original.id);
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
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "答案歌", artist: "同一位歌手", kind: "opening" }],
      }),
      searchSubjects: async () => [anime],
    });
    const musicProvider: MusicProvider = {
      ...provider,
      // 翻唱排在前面，且两者打分完全相同，只能靠版本标记区分。
      search: async () => [cover, original],
      getSong: async (id) => (id === "identical-cover" ? cover : original),
    };

    const chosenId = await animeSoloRound(musicProvider, bangumiProvider);
    expect(chosenId).toBe(original.id);
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
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "你所不知道的故事", artist: "supercell", kind: "ending" }],
      }),
      searchSubjects: async () => [anime],
    });
    const musicProvider: MusicProvider = {
      ...provider,
      // 检索只能召回到翻唱；原版只能靠翻唱自带的原曲 ID 取回。
      search: async () => [cover],
      getSong: async (id) => (id === "original-bakemonogatari" ? original : cover),
    };

    const chosenId = await animeSoloRound(musicProvider, bangumiProvider);
    expect(chosenId).toBe(original.id);
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
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "夢を信じて", artist: "徳永英明", kind: "ending" }],
      }),
      searchSubjects: async () => [anime],
    });
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
    const { chosenId } = await startAnimeSolo({
      musicProvider,
      bangumiProvider,
      connectionId: `anime-fair-${Math.random().toString(36).slice(2, 8)}`,
      roomId: "8888",
      random,
    });
    return chosenId;
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
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        musicTracks: titles.map((title) => ({ title, kind: "opening" as const })),
      }),
      searchSubjects: async () => [anime],
    });

    // mulberry32：取值落在 [0, maxExclusive) 内。不用最小线性同余——它的低位与洗牌的
    // 两次取号强相关，固定种子下会整整一批抽不到同一个位置，冤枉被测的洗牌。
    const seededRandom = (seed: number) => {
      let state = seed >>> 0;
      return {
        nextInt: (maxExclusive: number) => {
          state = (state + 0x6d2b79f5) >>> 0;
          let t = state;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) % Math.max(1, maxExclusive);
        },
      };
    };

    const picks = new Map<string, number>();
    for (let seed = 1; seed <= 30; seed += 1) {
      const songId = await startAnimeRound(musicProvider, bangumiProvider, seededRandom(seed));
      expect(songId).toBeDefined();
      picks.set(songId!, (picks.get(songId!) ?? 0) + 1);
    }

    // 三首都要出现，且不能某首占压倒性多数：只在头部随机或只洗前两首都会破坏这两条。
    expect([...picks.keys()].sort()).toEqual([...titles].sort());
    for (const count of picks.values()) {
      expect(count).toBeGreaterThanOrEqual(5);
      expect(count).toBeLessThanOrEqual(15);
    }
  });
});
