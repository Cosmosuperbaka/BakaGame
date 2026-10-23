import { describe, expect, test, mock } from "bun:test";
import { AggregatedMusicProvider } from "../src/infrastructure/AggregatedMusicProvider";
import type {
  MusicProvider,
  MusicLoginSession,
  MusicQrLoginCheck,
} from "../src/infrastructure/NeteaseMusicProvider";
import type { AggregatedSongSearchResult } from "../src/infrastructure/MusicDeduplicator";
import type { SongDetails, SongPlaylistInfo, SongSearchResult } from "../src/shared/SonGuessr";

// 返回类型不注解成 MusicProvider：那会让 `expect(mock.getSong)` 被判成游离方法引用，
// satisfies 同样守住接口契约，又保留推断出的属性类型。
function createMockProvider(platform: "netease" | "qq", overrides: Partial<MusicProvider> = {}) {
  return {
    search: mock(async (_keyword: string, _limit?: number): Promise<SongSearchResult[]> => []),
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
    getPlaylistSongs: mock(
      async (
        playlistId: string
      ): Promise<{ info: SongPlaylistInfo; songs: SongSearchResult[] }> => ({
        info: { id: playlistId, name: "Test Playlist", songCount: 0 },
        songs: [],
      })
    ),
    searchAlbums: mock(async () => []),
    getAlbumSongs: mock(async () => []),
    ...overrides,
  } satisfies MusicProvider;
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

    // 两家音源都有账号：QQ 侧才会真的发检索。
    const results = (await agg.search("晴天", 10, {
      netease: "nc_cookie",
      qq: "qc_cookie",
    })) as AggregatedSongSearchResult[];
    expect(results.length).toBe(1);
    // 共有曲目归到网易云那一侧，哪怕 QQ 侧曲名更干净、徽章与播放源才一致。
    expect(results[0]?.id).toBe("netease:1001");
    expect(results[0]?.artist).toBe("周杰伦");
    expect(results[0]?.sources).toBeDefined();
    expect(results[0]?.sources?.length).toBe(2);
  });

  test("search 账号池为空时以匿名 QQ 补充：免费曲可播、会员曲不可播", async () => {
    const neteaseMock = createMockProvider("netease", {
      search: mock(async () => [
        { id: "netease:1001", title: "网易云同名曲", artist: "周杰伦", durationMs: 269000 },
      ]),
    });
    const qqMock = createMockProvider("qq", {
      search: mock(async () => [
        { id: "qq:free", title: "QQ 独占免费曲", artist: "某歌手", durationMs: 200000 },
        {
          id: "qq:vip",
          title: "QQ 独占会员曲",
          artist: "另一歌手",
          durationMs: 210000,
          requiresVip: true,
        },
      ]),
    });
    const agg = new AggregatedMusicProvider({ neteaseProvider: neteaseMock, qqProvider: qqMock });

    // 只有网易云凭据（房间没挂 QQ 账号）：QQ 走匿名补充，而不是整轮跳过。
    const results = await agg.search("独占", 10, { netease: "nc_cookie_only" });
    expect(qqMock.search).toHaveBeenCalledWith("独占", 10, undefined);
    expect(results.find((song) => song.id === "qq:free")?.playable).toBeUndefined();
    expect(results.find((song) => song.id === "qq:vip")?.playable).toBe(false);
  });

  test("search 匿名补充开关关闭时跳过 QQ，只回网易云结果", async () => {
    const neteaseMock = createMockProvider("netease", {
      search: mock(async () => [
        { id: "netease:1001", title: "晴天", artist: "周杰伦", durationMs: 269000 },
      ]),
    });
    const qqMock = createMockProvider("qq", {
      search: mock(async () => [
        { id: "qq:exclusive", title: "晴天", artist: "周杰伦", durationMs: 269000 },
      ]),
    });
    const agg = new AggregatedMusicProvider({
      neteaseProvider: neteaseMock,
      qqProvider: qqMock,
      allowAnonymousQqSearch: false,
    });

    const results = await agg.search("晴天", 10, { netease: "nc_cookie_only" });
    expect(qqMock.search).not.toHaveBeenCalled();
    expect(results.map((song) => song.id)).toEqual(["netease:1001"]);
  });

  test("search 按房间偏好决定共有曲目主实体：默认网易云，QQ-only 反转", async () => {
    const neteaseMock = createMockProvider("netease", {
      search: mock(async () => [
        { id: "netease:1001", title: "晴天", artist: "周杰伦", durationMs: 269000 },
      ]),
    });
    const qqMock = createMockProvider("qq", {
      search: mock(async () => [
        { id: "qq:1001", title: "晴天", artist: "周杰伦", durationMs: 269000 },
      ]),
    });
    const agg = new AggregatedMusicProvider({ neteaseProvider: neteaseMock, qqProvider: qqMock });
    const cookie = { qq: "qc_cookie_only" };

    // 只有 QQ 账号：默认偏好仍是网易云；传入反向偏好后共有曲目归 QQ。
    const neteaseFirst = await agg.search("晴天", 10, cookie);
    expect(neteaseFirst[0]?.id).toBe("netease:1001");

    const qqFirst = (await agg.search("晴天", 10, cookie, {
      platformPreference: ["qq", "netease"],
    })) as AggregatedSongSearchResult[];
    expect(qqFirst[0]?.id).toBe("qq:1001");
    expect(qqFirst[0]?.sources?.length).toBe(2);
  });

  test("匿名补充关闭时 QQ 歌单、歌手与专辑检索都不再发往上游", async () => {
    const neteaseMock = createMockProvider("netease", {
      searchArtists: mock(async () => [{ id: "netease:10", name: "周杰伦" }]),
      searchAlbums: mock(async () => [{ id: "netease:20", name: "范特西" }]),
    });
    const qqMock = createMockProvider("qq", {
      getPlaylistSongs: mock(async (id: string) => ({
        info: { id, name: "QQ Playlist", songCount: 0 },
        songs: [],
      })),
      searchArtists: mock(async () => [{ id: "qq:10", name: "周杰伦" }]),
      searchAlbums: mock(async () => [{ id: "qq:20", name: "范特西" }]),
    });
    const agg = new AggregatedMusicProvider({
      neteaseProvider: neteaseMock,
      qqProvider: qqMock,
      allowAnonymousQqSearch: false,
    });

    await agg.searchArtists("周杰伦", 10, { netease: "nc_cookie_only" });
    await agg.searchAlbums("范特西", 10, { netease: "nc_cookie_only" });
    expect(qqMock.searchArtists).not.toHaveBeenCalled();
    expect(qqMock.searchAlbums).not.toHaveBeenCalled();
    await expect(
      agg.getPlaylistSongs("qq:12345", { netease: "nc_cookie_only" })
    ).rejects.toThrow("QQ 音乐匿名音源已关闭");
    expect(qqMock.getPlaylistSongs).not.toHaveBeenCalled();
  });

  test("search 非会员 QQ 账号池里，会员专享曲目标记不可播放", async () => {
    const neteaseMock = createMockProvider("netease", {
      search: mock(async () => [
        { id: "netease:1001", title: "晴天", artist: "周杰伦", durationMs: 269000 },
      ]),
    });
    const qqMock = createMockProvider("qq", {
      search: mock(async () => [
        {
          id: "qq:viponly",
          title: "反方向的钟",
          artist: "周杰伦",
          durationMs: 258000,
          requiresVip: true,
        },
      ]),
    });
    const agg = new AggregatedMusicProvider({ neteaseProvider: neteaseMock, qqProvider: qqMock });
    const cookie = { netease: "nc_cookie", qq: "qc_cookie" };

    const nonVip = await agg.search("周杰伦", 10, cookie, { vipPlatforms: [] });
    const blocked = nonVip.find((song) => song.id === "qq:viponly");
    expect(blocked?.playable).toBe(false);
    expect(blocked?.unplayableReason).toBe("需要 QQ 音乐会员账号");
    // 不可播的后置：能播的网易云结果排在它前面。
    expect(nonVip[0]?.id).toBe("netease:1001");

    const vip = await agg.search("周杰伦", 10, cookie, { vipPlatforms: ["qq"] });
    expect(vip.find((song) => song.id === "qq:viponly")?.playable).toBeUndefined();
  });

  test("单源搜索超时按单音源降级，不拖住另一侧", async () => {
    const neteaseMock = createMockProvider("netease", {
      search: mock(async () => [
        { id: "netease:1001", title: "晴天", artist: "周杰伦", durationMs: 269000 },
      ]),
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const qqMock = createMockProvider("qq", {
      search: mock(async () => {
        await pending;
        return [{ id: "qq:1001", title: "晴天", artist: "周杰伦", durationMs: 269000 }];
      }),
    });
    const agg = new AggregatedMusicProvider({
      neteaseProvider: neteaseMock,
      qqProvider: qqMock,
      searchTimeoutMs: { qq: 10 },
    });

    const started = Date.now();
    const results = await agg.search("晴天", 10, { netease: "nc", qq: "qc" });
    expect(results.map((song) => song.id)).toContain("netease:1001");
    expect(Date.now() - started).toBeLessThan(500);
    release();
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

    const results = await agg.search("反方向的钟", 5, { netease: "nc_cookie", qq: "qc_cookie" });
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

  test("searchArtists 同名去重并交错保留双平台，按房间偏好选主条目", async () => {
    const neteaseMock = createMockProvider("netease", {
      searchArtists: mock(async () => [
        { id: "netease:only", name: "甲" },
        { id: "netease:shared", name: "共同" },
      ]),
    });
    const qqMock = createMockProvider("qq", {
      searchArtists: mock(async () => [
        { id: "qq:only", name: "乙" },
        { id: "qq:shared", name: "共同" },
      ]),
    });
    const agg = new AggregatedMusicProvider({ neteaseProvider: neteaseMock, qqProvider: qqMock });
    const cookie = { netease: "nc", qq: "qc" };

    const neteaseFirst = await agg.searchArtists("x", 10, cookie);
    expect(neteaseFirst.map((artist) => artist.name)).toEqual(["甲", "乙", "共同"]);
    expect(neteaseFirst.find((artist) => artist.name === "共同")?.id).toBe("netease:shared");

    const qqFirst = await agg.searchArtists("x", 10, cookie, {
      platformPreference: ["qq", "netease"],
    });
    expect(qqFirst.map((artist) => artist.name)).toEqual(["乙", "甲", "共同"]);
    expect(qqFirst.find((artist) => artist.name === "共同")?.id).toBe("qq:shared");
  });

  test("searchAlbums 按名称与歌手去重并交错保留双平台", async () => {
    const neteaseMock = createMockProvider("netease", {
      searchAlbums: mock(async () => [
        { id: "netease:a", name: "甲专辑", artist: "甲" },
        { id: "netease:shared", name: "共同专辑", artist: "丙" },
      ]),
    });
    const qqMock = createMockProvider("qq", {
      searchAlbums: mock(async () => [
        { id: "qq:b", name: "乙专辑", artist: "乙" },
        { id: "qq:shared", name: "共同专辑", artist: "丙" },
      ]),
    });
    const agg = new AggregatedMusicProvider({ neteaseProvider: neteaseMock, qqProvider: qqMock });

    const results = await agg.searchAlbums("x", 10, { netease: "nc", qq: "qc" });
    expect(results.map((album) => album.name)).toEqual(["甲专辑", "乙专辑", "共同专辑"]);
    expect(results.find((album) => album.name === "共同专辑")?.id).toBe("netease:shared");
  });

  test("双平台聚合 Cookie 正确解构并透传给对应提供商", async () => {
    const neteaseMock = createMockProvider("netease", {
      getPlaylistSongs: mock(async (id: string, _cookie?: string) => ({
        info: { id, name: "NCM Playlist", songCount: 1 },
        songs: [{ id: "netease:1", title: "NCM Track", artist: "Artist" }],
      })),
      getSongPopularity: mock(async (_id: string, _cookie?: string) => 999),
      getSongChorus: mock(async (_id: string, _cookie?: string) => ({
        startTime: 1000,
        endTime: 5000,
      })),
      searchArtists: mock(async (_keyword: string, _limit?: number, _cookie?: string) => [
        { id: "netease:10", name: "Artist A" },
      ]),
      getArtistSongs: mock(async (_id: string, _cookie?: string) => [
        { id: "netease:1", title: "Artist Track", artist: "Artist A" },
      ]),
      searchAlbums: mock(async (_keyword: string, _limit?: number, _cookie?: string) => [
        { id: "netease:20", name: "Album A" },
      ]),
      getAlbumSongs: mock(async (_id: string, _cookie?: string) => [
        { id: "netease:1", title: "Album Track", artist: "Artist A" },
      ]),
    });
    const qqMock = createMockProvider("qq", {
      getPlaylistSongs: mock(async (id: string, _cookie?: string) => ({
        info: { id, name: "QQ Playlist", songCount: 1 },
        songs: [{ id: "qq:2", title: "QQ Track", artist: "Artist" }],
      })),
      getSongPopularity: mock(async (_id: string, _cookie?: string) => 888),
      getSongChorus: mock(async (_id: string, _cookie?: string) => ({
        startTime: 2000,
        endTime: 6000,
      })),
      searchArtists: mock(async (_keyword: string, _limit?: number, _cookie?: string) => [
        { id: "qq:20", name: "Artist B" },
      ]),
      getArtistSongs: mock(async (_id: string, _cookie?: string) => [
        { id: "qq:2", title: "Artist Track QQ", artist: "Artist B" },
      ]),
      searchAlbums: mock(async (_keyword: string, _limit?: number, _cookie?: string) => [
        { id: "qq:30", name: "Album B" },
      ]),
      getAlbumSongs: mock(async (_id: string, _cookie?: string) => [
        { id: "qq:2", title: "Album Track QQ", artist: "Artist B" },
      ]),
    });

    const agg = new AggregatedMusicProvider({
      neteaseProvider: neteaseMock,
      qqProvider: qqMock,
    });

    const aggregatedCookie = { netease: "nc_cookie_123", qq: "qc_cookie_456" };

    // 1. getPlaylistSongs
    await agg.getPlaylistSongs("netease:12345", aggregatedCookie);
    expect(neteaseMock.getPlaylistSongs).toHaveBeenCalledWith("12345", "nc_cookie_123");

    await agg.getPlaylistSongs("qq:88888", aggregatedCookie);
    expect(qqMock.getPlaylistSongs).toHaveBeenCalledWith("88888", "qc_cookie_456");

    // 2. getSongPopularity & getSongChorus
    const ncmPop = await agg.getSongPopularity("netease:100", aggregatedCookie);
    expect(ncmPop).toBe(999);
    expect(neteaseMock.getSongPopularity).toHaveBeenCalledWith("100", "nc_cookie_123");

    const qqPop = await agg.getSongPopularity("qq:200", aggregatedCookie);
    expect(qqPop).toBe(888);
    expect(qqMock.getSongPopularity).toHaveBeenCalledWith("200", "qc_cookie_456");

    const ncmChorus = await agg.getSongChorus("netease:100", aggregatedCookie);
    expect(ncmChorus?.startTime).toBe(1000);
    expect(neteaseMock.getSongChorus).toHaveBeenCalledWith("100", "nc_cookie_123");

    const qqChorus = await agg.getSongChorus("qq:200", aggregatedCookie);
    expect(qqChorus?.startTime).toBe(2000);
    expect(qqMock.getSongChorus).toHaveBeenCalledWith("200", "qc_cookie_456");

    // 3. searchArtists & getArtistSongs
    await agg.searchArtists("周杰伦", 10, aggregatedCookie);
    expect(neteaseMock.searchArtists).toHaveBeenCalledWith("周杰伦", 10, "nc_cookie_123");
    expect(qqMock.searchArtists).toHaveBeenCalledWith("周杰伦", 10, "qc_cookie_456");

    await agg.getArtistSongs("netease:10", aggregatedCookie);
    expect(neteaseMock.getArtistSongs).toHaveBeenCalledWith("10", "nc_cookie_123");

    await agg.getArtistSongs("qq:20", aggregatedCookie);
    expect(qqMock.getArtistSongs).toHaveBeenCalledWith("20", "qc_cookie_456");

    // 4. searchAlbums & getAlbumSongs
    await agg.searchAlbums("范特西", 5, aggregatedCookie);
    expect(neteaseMock.searchAlbums).toHaveBeenCalledWith("范特西", 5, "nc_cookie_123");
    expect(qqMock.searchAlbums).toHaveBeenCalledWith("范特西", 5, "qc_cookie_456");

    await agg.getAlbumSongs("netease:20", aggregatedCookie);
    expect(neteaseMock.getAlbumSongs).toHaveBeenCalledWith("20", "nc_cookie_123");

    await agg.getAlbumSongs("qq:30", aggregatedCookie);
    expect(qqMock.getAlbumSongs).toHaveBeenCalledWith("30", "qc_cookie_456");
  });

  test("getSong 主平台失败时按歌名+歌手跨平台 Failover", async () => {
    const neteaseMock = createMockProvider("netease", {
      getSong: mock(async () => {
        throw new Error("netease song unavailable");
      }),
      getSongMetadata: mock(async () => ({
        id: "netease:1001",
        title: "反方向的钟",
        artist: "周杰伦",
        album: "范特西",
        durationMs: 258000,
        lyrics: [],
        audioUrl: "",
        encyclopedia: { tags: [] },
      })),
    });
    const qqMock = createMockProvider("qq", {
      search: mock(async () => [
        { id: "qq:hit", title: "反方向的钟", artist: "周杰伦", durationMs: 258500 },
      ]),
      getSong: mock(async (id: string) => ({
        id: `qq:${id}`,
        title: "反方向的钟",
        artist: "周杰伦",
        album: "范特西",
        durationMs: 258500,
        lyrics: [],
        audioUrl: "https://cdn.example/qq-failover.mp3",
        encyclopedia: { tags: [] },
      })),
    });

    const agg = new AggregatedMusicProvider({ neteaseProvider: neteaseMock, qqProvider: qqMock });
    const song = await agg.getSong("netease:1001");
    expect(song.audioUrl).toBe("https://cdn.example/qq-failover.mp3");
    expect(qqMock.search).toHaveBeenCalled();
  });

  test("getSong 主平台失败且备选平台也取不到时抛原错误", async () => {
    const neteaseMock = createMockProvider("netease", {
      getSong: mock(async () => {
        throw new Error("primary down");
      }),
      getSongMetadata: mock(async () => ({
        id: "netease:1001",
        title: "无人知",
        artist: "无名",
        album: "",
        durationMs: 100000,
        lyrics: [],
        audioUrl: "",
        encyclopedia: { tags: [] },
      })),
    });
    const qqMock = createMockProvider("qq", {
      search: mock(async () => []),
    });

    const agg = new AggregatedMusicProvider({ neteaseProvider: neteaseMock, qqProvider: qqMock });
    await expect(agg.getSong("netease:1001")).rejects.toThrow("primary down");
  });

  test("refreshSongAudio 优先直连 provider 的刷新能力，并按平台路由", async () => {
    const neteaseMock = createMockProvider("netease", {
      refreshSongAudio: mock(async () => "https://cdn.example/ncm-refresh.mp3"),
    });
    const qqMock = createMockProvider("qq", {
      refreshSongAudio: mock(async () => "https://cdn.example/qq-refresh.mp3"),
    });
    const agg = new AggregatedMusicProvider({ neteaseProvider: neteaseMock, qqProvider: qqMock });

    expect(await agg.refreshSongAudio("netease:1")).toBe("https://cdn.example/ncm-refresh.mp3");
    expect(await agg.refreshSongAudio("qq:2")).toBe("https://cdn.example/qq-refresh.mp3");
  });

  test("searchAmllTtmlLyrics 先问网易、为空再问 QQ", async () => {
    const neteaseMock = createMockProvider("netease", {
      searchAmllTtmlLyrics: mock(async () => undefined),
    });
    const qqMock = createMockProvider("qq", {
      searchAmllTtmlLyrics: mock(async () => "<tt>qq 歌词</tt>"),
    });
    const agg = new AggregatedMusicProvider({ neteaseProvider: neteaseMock, qqProvider: qqMock });
    expect(await agg.searchAmllTtmlLyrics("歌名", "歌手")).toBe("<tt>qq 歌词</tt>");
  });

  test("扫码登录按平台路由到对应 provider", async () => {
    const neteaseMock = createMockProvider("netease", {
      createQrLogin: mock(async () => ({ key: "ncm", qrUrl: "ncm://qr", qrImage: "ncm-img" })),
      checkQrLogin: mock(async (): Promise<MusicQrLoginCheck> => ({
        status: "waiting",
        message: "ncm",
      })),
      getLoginStatus: mock(async (): Promise<MusicLoginSession> => ({
        cookie: "ncm_cookie",
        account: { platform: "netease", userId: "1", nickname: "NCM", vipStatus: "nonVip" },
      })),
    });
    const qqMock = createMockProvider("qq", {
      createQrLogin: mock(async () => ({ key: "qq", qrUrl: "qq://qr", qrImage: "qq-img" })),
      checkQrLogin: mock(async (): Promise<MusicQrLoginCheck> => ({
        status: "authorized",
        message: "qq",
      })),
      getLoginStatus: mock(async (): Promise<MusicLoginSession> => ({
        cookie: "qq_cookie",
        account: { platform: "qq", userId: "2", nickname: "QQ", vipStatus: "vip" },
      })),
    });
    const agg = new AggregatedMusicProvider({ neteaseProvider: neteaseMock, qqProvider: qqMock });

    expect((await agg.createQrLogin("qq", "qq")).key).toBe("qq");
    expect((await agg.createQrLogin("netease")).key).toBe("ncm");
    expect((await agg.checkQrLogin("k", "qq")).status).toBe("authorized");
    expect((await agg.getLoginStatus("c", "qq")).account.nickname).toBe("QQ");
    expect((await agg.getLoginStatus("c", "netease")).account.nickname).toBe("NCM");
  });
});
