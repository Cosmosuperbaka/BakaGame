import { afterEach, describe, expect, it, mock } from "bun:test";
import qqmusic from "qqmusic-api-enhanced";
import type { Response } from "qqmusic-api-enhanced";
import { QQMusicProvider } from "../../src/infrastructure/music/qq/QQMusicProvider";
import { amllTtmlFixture, LRC } from "./Fixtures";
import { qqStub } from "../support/Qqmusic";

const originals = { song_detail: qqmusic.song_detail, lyric: qqmusic.lyric };
afterEach(() => {
  Object.assign(qqmusic, originals);
});

const mockUpstream = (lyric: () => Promise<Response>) => {
  let detailCalls = 0;
  qqmusic.song_detail = qqStub.song_detail(
    mock(async () => {
      detailCalls += 1;
      return {
        status: 200,
        body: { data: { track_info: { name: "歌", singer: [{ name: "歌手" }] } } },
      };
    })
  );
  qqmusic.lyric = qqStub.lyric(mock(lyric));
  return { detailCalls: () => detailCalls };
};

describe("QQ 歌词链：瞬态失败不随元数据落缓存", () => {
  it("AMLL 瞬态失败而降到低优先级歌词时，元数据不缓存，恢复后下一次拿到官方逐字歌词", async () => {
    let amllCalls = 0;
    const provider = new QQMusicProvider({
      fetchAmllLyrics: async () => {
        amllCalls += 1;
        if (amllCalls === 1) throw new Error("AMLL 暂时不可用");
        return amllTtmlFixture("官方逐字");
      },
      fetchAmllSearchLyrics: async () => undefined,
    });
    const upstream = mockUpstream(async () => ({ status: 200, body: { lyric: LRC } }));

    const degraded = await provider.getSongMetadata("qq:transient1");
    expect(degraded.lyrics.map((line) => line.text)).toEqual(["第一句", "第二句"]);

    const recovered = await provider.getSongMetadata("qq:transient1");
    expect(upstream.detailCalls()).toBe(2);
    expect(recovered.lyrics.map((line) => line.text)).toEqual(["官方逐字"]);
  });

  it("所有来源都没取到（含平台歌词接口瞬态失败）时，空歌词不落缓存", async () => {
    let lyricCalls = 0;
    const provider = new QQMusicProvider({
      fetchAmllLyrics: async () => undefined,
      fetchAmllSearchLyrics: async () => undefined,
    });
    const upstream = mockUpstream(async () => {
      lyricCalls += 1;
      if (lyricCalls === 1) throw new Error("lyric api down");
      return { status: 200, body: { lyric: LRC } };
    });

    const first = await provider.getSongMetadata("qq:transient2");
    expect(first.lyrics).toEqual([]);
    const second = await provider.getSongMetadata("qq:transient2");
    expect(upstream.detailCalls()).toBe(2);
    expect(second.lyrics).toHaveLength(2);
  });

  it("官方歌词库确定没有（缺失）时照旧缓存，不重复回源", async () => {
    const provider = new QQMusicProvider({
      fetchAmllLyrics: async () => undefined,
      fetchAmllSearchLyrics: async () => undefined,
    });
    const upstream = mockUpstream(async () => ({ status: 200, body: { lyric: LRC } }));

    await provider.getSongMetadata("qq:definitive");
    await provider.getSongMetadata("qq:definitive");
    expect(upstream.detailCalls()).toBe(1);
  });

  it("按标识没取到、按歌名检索命中时，更高优先级的来源缺席，同样不缓存", async () => {
    const provider = new QQMusicProvider({
      fetchAmllLyrics: async () => {
        throw new Error("按标识查询失败");
      },
      fetchAmllSearchLyrics: async () => amllTtmlFixture("按歌名命中"),
    });
    const upstream = mockUpstream(async () => ({ status: 200, body: { lyric: LRC } }));

    const first = await provider.getSongMetadata("qq:searchhit");
    expect(first.lyrics.map((line) => line.text)).toEqual(["按歌名命中"]);
    await provider.getSongMetadata("qq:searchhit");
    expect(upstream.detailCalls()).toBe(2);
  });
});
