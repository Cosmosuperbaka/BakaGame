import { describe, expect, test, mock } from "bun:test";
import { AggregatedMusicProvider } from "../src/infrastructure/AggregatedMusicProvider";
import type { MusicProvider } from "../src/infrastructure/NeteaseMusicProvider";
import type { AggregatedSongSearchResult } from "../src/infrastructure/MusicDeduplicator";
import type { SongDetails, SongPlaylistInfo, SongSearchResult } from "../src/shared/SonGuessr";

function createMockProvider(platform: "netease" | "qq", overrides: Partial<MusicProvider> = {}): MusicProvider {
  return {
    search: mock(async (keyword: string, limit?: number): Promise<SongSearchResult[]> => []),
    getSong: mock(async (id: string): Promise<SongDetails> => ({
      id: `${platform}:${id}`,
      title: "Test Song",
      artist: "Test Artist",
      album: "Test Album",
      durationMs: 200000,
      lyrics: [],
      audioUrl: `http://example.com/${platform}/${id}.mp3`,
      encyclopedia: { tags: [] },
    })),
    getSongMetadata: mock(async (id: string): Promise<SongDetails> => ({
      id: `${platform}:${id}`,
      title: "Test Song",
      artist: "Test Artist",
      album: "Test Album",
      durationMs: 200000,
      lyrics: [],
      audioUrl: "",
      encyclopedia: { tags: [] },
    })),
    getPlaylistSongs: mock(async (playlistId: string): Promise<{ info: SongPlaylistInfo; songs: SongSearchResult[] }> => ({
      info: { id: playlistId, name: "Test Playlist", songCount: 0 },
      songs: [],
    })),
    searchAlbums: mock(async () => []),
    getAlbumSongs: mock(async () => []),
    ...overrides,
  };
}

describe("AggregatedMusicProvider", () => {
  test("search 并行调用双平台并进行聚合去重", async () => {
    const neteaseMock = createMockProvider("netease", {
      search: mock(async () => [
        {
          id: "netease:1001",
          title: "晴天 (2020 Remaster)",
          artist: "周杰伦",
          durationMs: 269000,
        },
      ]),
    });

    const qqMock = createMockProvider("qq", {
      search: mock(async () => [
        {
          id: "qq:0039MnYb0qxYhV",
          title: "晴天",
          artist: "周杰伦",
          durationMs: 269000,
        },
      ]),
    });

    const agg = new AggregatedMusicProvider({
      neteaseProvider: neteaseMock,
      qqProvider: qqMock,
    });

    const results = (await agg.search("晴天", 10)) as AggregatedSongSearchResult[];
    expect(results.length).toBe(1);
    expect(results[0]?.title).toBe("晴天");
    expect(results[0]?.artist).toBe("周杰伦");
    expect(results[0]?.sources).toBeDefined();
    expect(results[0]?.sources?.length).toBe(2);
  });

  test("search 在单边平台抛出异常时实现优雅降级不崩盘", async () => {
    const neteaseMock = createMockProvider("netease", {
      search: mock(async () => {
        throw new Error("Netease rate limited");
      }),
    });

    const qqMock = createMockProvider("qq", {
      search: mock(async () => [
        {
          id: "qq:0017K7gL4WYnw2",
          title: "反方向的钟",
          artist: "周杰伦",
          durationMs: 258000,
        },
      ]),
    });

    const agg = new AggregatedMusicProvider({
      neteaseProvider: neteaseMock,
      qqProvider: qqMock,
    });

    const results = await agg.search("反方向的钟", 5);
    expect(results.length).toBe(1);
    expect(results[0]?.title).toBe("反方向的钟");
    expect(results[0]?.artist).toBe("周杰伦");
  });

  test("getSong 路由至对应平台提供商", async () => {
    const neteaseMock = createMockProvider("netease");
    const qqMock = createMockProvider("qq");

    const agg = new AggregatedMusicProvider({
      neteaseProvider: neteaseMock,
      qqProvider: qqMock,
    });

    const song = await agg.getSong("qq:0017K7gL4WYnw2");
    expect(song.id).toBe("qq:0017K7gL4WYnw2");
    expect(qqMock.getSong).toHaveBeenCalled();
    expect(neteaseMock.getSong).not.toHaveBeenCalled();
  });

  test("getPlaylistSongs 识别 URN 前缀并分发至正确平台", async () => {
    const neteaseMock = createMockProvider("netease", {
      getPlaylistSongs: mock(async (id: string) => ({
        info: { id, name: "NCM Playlist", songCount: 1 },
        songs: [{ id: "netease:1", title: "NCM Track", artist: "Artist" }],
      })),
    });
    const qqMock = createMockProvider("qq", {
      getPlaylistSongs: mock(async (id: string) => ({
        info: { id, name: "QQ Playlist", songCount: 1 },
        songs: [{ id: "qq:2", title: "QQ Track", artist: "Artist" }],
      })),
    });

    const agg = new AggregatedMusicProvider({
      neteaseProvider: neteaseMock,
      qqProvider: qqMock,
    });

    const ncmList = await agg.getPlaylistSongs("netease:12345");
    expect(ncmList.songs[0]?.id).toBe("netease:1");
    expect(neteaseMock.getPlaylistSongs).toHaveBeenCalledWith("12345", undefined);

    const qqList = await agg.getPlaylistSongs("qq:88888");
    expect(qqList.songs[0]?.id).toBe("qq:2");
    expect(qqMock.getPlaylistSongs).toHaveBeenCalledWith("88888", undefined);
  });
});
