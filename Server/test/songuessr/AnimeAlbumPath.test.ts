import { describe, expect, test } from "bun:test";
import { anime, provider, songs, startAnimeSolo } from "./Fixtures";
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
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "答案歌", kind: "ost" as const }],
      }),
      searchSubjects: async () => [anime],
    });

    const chosenId = await animeSoloRound(musicProvider, bangumiProvider);
    expect(chosenId).toBe(official.id);
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
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "角色歌合辑", kind: "character" as const }],
      }),
      searchSubjects: async () => [anime],
    });
    const musicProvider: MusicProvider = {
      ...provider,
      // 单曲检索按专辑名一无所获；专辑检索能命中同名专辑，再取回专辑曲目。
      search: async () => [],
      searchAlbums: async () => [{ id: "album-1", name: "角色歌合辑", artist: "角色声优" }],
      getAlbumSongs: async () => [albumTrack],
      getSong: async () => albumTrack,
    };

    const chosenId = await animeSoloRound(musicProvider, bangumiProvider);
    expect(chosenId).toBe(albumTrack.id);
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
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "角色歌合辑", kind: "character" as const }],
      }),
      searchSubjects: async () => [anime],
    });
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
    const bangumiProvider = fakeBangumiProvider({
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
    });
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
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        musicTracks: [{ title: "Answer Anime Original SoundTrack", kind: "ost" as const }],
      }),
      searchSubjects: async () => [anime],
    });
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

    const chosenId = await animeSoloRound(musicProvider, bangumiProvider);
    expect(chosenId).toBe("legit-track");
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
    const bangumiProvider = fakeBangumiProvider({
      getSubject: async () => ({
        ...anime,
        musicTracks: [
          { title: "「Answer Anime」キャラクターソング集", kind: "character" as const },
        ],
      }),
      searchSubjects: async () => [anime],
    });
    const musicProvider: MusicProvider = {
      ...provider,
      search: async () => [],
      searchAlbums: async () => [
        { id: "album-chara", name: "「Answer Anime」キャラクターソング集", artist: "V.A." },
      ],
      getAlbumSongs: async () => [remixTrack, originalTrack],
      getSong: async (id) => (id === "remix-track" ? remixTrack : originalTrack),
    };

    const chosenId = await animeSoloRound(musicProvider, bangumiProvider);
    expect(chosenId).toBe("original-track");
  });
});
