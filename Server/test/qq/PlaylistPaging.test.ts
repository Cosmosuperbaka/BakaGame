import { describe, expect, it, mock, afterEach } from "bun:test";
import { QQMusicProvider } from "../../src/infrastructure/QQMusicProvider";
import qqmusic from "qqmusic-api-enhanced";

const originals = {
  playlist_detail: qqmusic.playlist_detail,
  playlist_track_all: qqmusic.playlist_track_all,
};
const restore = () => Object.assign(qqmusic, originals);
afterEach(restore);

const track = (index: number) => ({
  songmid: `m${index}`,
  songname: `曲目${index}`,
  singer: [{ name: "歌手甲" }],
  interval: 100,
});

describe("QQ音乐歌单翻页（对齐网易云口径）", () => {
  it("歌单超过单页上限时按 total 翻页取完并按 mid 去重", async () => {
    const total = 1201;
    const all = Array.from({ length: total }, (_, index) => track(index));
    const offsets: number[] = [];
    const provider = new QQMusicProvider({ minRequestIntervalMs: 0 });
    qqmusic.playlist_detail = mock(async () => ({
      status: 200,
      body: { dirinfo: { title: "超长歌单" } },
    })) as any;
    qqmusic.playlist_track_all = mock(async ({ offset }: { offset?: number }) => {
      const start = Number(offset ?? 0);
      offsets.push(start);
      return { status: 200, body: { songs: all.slice(start, start + 1000), total } };
    }) as any;

    const result = await provider.getPlaylistSongs("901211232");
    expect(result.info).toEqual({ id: "qq:901211232", name: "超长歌单", songCount: total });
    expect(result.songs).toHaveLength(total);
    expect(result.songs.at(-1)?.id).toBe("qq:m1200");
    expect(new Set(result.songs.map((song) => song.id)).size).toBe(total);
    // 第二页取完即停，不会为短页再发一次请求
    expect(offsets).toEqual([0, 1000]);
  });

  it("歌单翻页中途失败时保留已取到的曲目", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => track(index));
    const provider = new QQMusicProvider({ minRequestIntervalMs: 0 });
    qqmusic.playlist_detail = mock(async () => ({
      status: 200,
      body: { dirinfo: { title: "半途" } },
    })) as any;
    qqmusic.playlist_track_all = mock(async ({ offset }: { offset?: number }) => {
      if (Number(offset ?? 0) > 0) throw new Error("上游翻页失败");
      return { status: 200, body: { songs: firstPage, total: 1201 } };
    }) as any;

    const result = await provider.getPlaylistSongs("901211232");
    expect(result.info.songCount).toBe(1201);
    expect(result.songs).toHaveLength(1000);
  });

  it("响应无 total 时靠“本页无新增曲目”终止翻页", async () => {
    let trackCalls = 0;
    const repeated = [track(0), track(1)];
    const provider = new QQMusicProvider({ minRequestIntervalMs: 0 });
    qqmusic.playlist_detail = mock(async () => ({
      status: 200,
      body: { dirinfo: { title: "两首" } },
    })) as any;
    qqmusic.playlist_track_all = mock(async () => {
      trackCalls += 1;
      // 不带 total，且每页都返回同一份曲目：只能靠“本页没有新增”终止翻页
      return { status: 200, body: { songs: repeated } };
    }) as any;

    const result = await provider.getPlaylistSongs("901211232");
    expect(result.songs.map((song) => song.id)).toEqual(["qq:m0", "qq:m1"]);
    expect(result.info).toEqual({ id: "qq:901211232", name: "两首", songCount: 2 });
    expect(trackCalls).toBe(2);
  });
});
