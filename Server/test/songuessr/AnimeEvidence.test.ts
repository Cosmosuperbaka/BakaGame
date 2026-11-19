import { describe, expect, test } from "bun:test";
import { anime, provider, songs, startAnimeSolo } from "./Fixtures";
import { type BangumiDataProvider } from "../../src/infrastructure/BangumiDataProvider";
import { type MusicProvider } from "../../src/infrastructure/music/MusicProvider";
import { fakeBangumiProvider } from "../support/Providers";

describe("SonGuessr 番剧级兜底归属证据", () => {
  const soloRound = async (musicProvider: MusicProvider, bangumiProvider: BangumiDataProvider) => {
    const { chosenId } = await startAnimeSolo({
      musicProvider,
      bangumiProvider,
      connectionId: "anime-level-solo",
      roomId: "8890",
    });
    return chosenId;
  };
  /** 曲目名在网易云根本不存在，逼着走到番剧级兜底。 */
  const unreachableTrack = fakeBangumiProvider({
    getSubject: async () => ({
      ...anime,
      musicTracks: [{ title: "无此曲XYZ", artist: "未知歌手", kind: "theme" }],
    }),
    searchSubjects: async () => [anime],
  });
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
    const chosenId = await soloRound(musicProvider, unreachableTrack);
    expect(chosenId).toBe("same-name");
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
