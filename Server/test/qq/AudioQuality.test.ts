import { afterEach, describe, expect, it, mock } from "bun:test";
import qqmusic from "qqmusic-api-enhanced";
import { QQMusicProvider } from "../../src/infrastructure/music/qq/QQMusicProvider";
import { qqStub } from "../support/Qqmusic";
import { LRC, offlineAmll } from "./Fixtures";

const originals = {
  song_detail: qqmusic.song_detail,
  song_url: qqmusic.song_url,
  lyric: qqmusic.lyric,
  request: qqmusic.request,
};
afterEach(() => Object.assign(qqmusic, originals));

/** 详情里登记：有标准、HQ、SQ 与臻品母带，没有臻品音质、全景声与杜比。 */
const detailWithFiles = (file: Record<string, unknown>) =>
  qqStub.song_detail(
    mock(async () => ({
      status: 200,
      body: {
        data: {
          track_info: { name: "测试曲", singer: [{ name: "歌手" }], interval: 200, file },
        },
      },
    }))
  );

const vkeyResponse = (purl: string) => ({
  status: 200,
  body: { midurlinfo: [{ songmid: "mid1", purl }], sip: ["http://ws.stream.qqmusic.example/"] },
});

describe("QQ 音乐按音质取播放地址", () => {
  it("接口包支持的档位走 song_url，其余档位按前缀自拼文件名请求同一个取直链接口", async () => {
    const provider = new QQMusicProvider(offlineAmll);
    qqmusic.song_detail = detailWithFiles({
      size_128mp3: 100,
      size_320mp3: 200,
      size_flac: 300,
      size_new: [900, 0, 0],
    });
    qqmusic.lyric = qqStub.lyric(mock(async () => ({ status: 200, body: { lyric: LRC } })));
    const libraryTypes: string[] = [];
    qqmusic.song_url = qqStub.song_url(
      mock(async ({ type } = {}) => {
        libraryTypes.push(type!);
        return {
          status: 200,
          body: { data: [{ url: `https://ws.stream.qqmusic.example/${type}` }] },
        };
      })
    );
    const filenames: string[] = [];
    qqmusic.request = mock(async (_module: string, _method?: unknown, param?: unknown) => {
      filenames.push(...((param as { filename: string[] }).filename ?? []));
      return vkeyResponse("AI00mid1mid1.flac?vkey=SIGN");
    });

    await provider.getSongMetadata("qq:mid1");
    await expect(provider.getSongAudioVariant("qq:mid1", "master", "uin=1")).resolves.toEqual({
      url: "https://ws.stream.qqmusic.example/AI00mid1mid1.flac?vkey=SIGN",
      quality: "master",
      format: "flac",
    });
    expect(filenames).toEqual(["AI00mid1mid1.flac"]);

    await expect(provider.getSongAudioVariant("qq:mid1", "lossless", "uin=1")).resolves.toEqual({
      url: "https://ws.stream.qqmusic.example/flac",
      quality: "lossless",
      format: "flac",
    });
    expect(libraryTypes).toEqual(["flac"]);
  });

  it("跳过这首歌没有的档：没有全景声文件时直接退到 SQ，不为它白打上游", async () => {
    const provider = new QQMusicProvider(offlineAmll);
    qqmusic.song_detail = detailWithFiles({ size_128mp3: 100, size_320mp3: 200, size_flac: 300 });
    qqmusic.lyric = qqStub.lyric(mock(async () => ({ status: 200, body: { lyric: LRC } })));
    const request = mock(async () => vkeyResponse("Q001mid1mid1.flac"));
    qqmusic.request = request;
    qqmusic.song_url = qqStub.song_url(
      mock(async () => ({
        status: 200,
        body: { data: [{ url: "https://ws.stream.qqmusic.example/sq" }] },
      }))
    );
    await provider.getSongMetadata("qq:mid1");
    await expect(provider.getSongAudioVariant("qq:mid1", "surround")).resolves.toMatchObject({
      quality: "lossless",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("没权限（空直链）与试听前缀都算拿不到，往下退；全部拿不到报不可用", async () => {
    const provider = new QQMusicProvider(offlineAmll);
    qqmusic.request = mock(async () => vkeyResponse(""));
    const types: string[] = [];
    qqmusic.song_url = qqStub.song_url(
      mock(async ({ type } = {}) => {
        types.push(type!);
        return {
          status: 200,
          body: {
            data: [{ url: type === "320" ? "https://ws.stream.qqmusic.example/RS02x.mp3" : "" }],
          },
        };
      })
    );
    // 没读过详情：不知道有哪些档，就按退路逐档去试。
    await expect(provider.getSongAudioVariant("qq:mid2", "dolby")).rejects.toMatchObject({
      code: "SONG_UNAVAILABLE",
    });
    expect(types).toEqual(["flac", "320"]);
  });
});
