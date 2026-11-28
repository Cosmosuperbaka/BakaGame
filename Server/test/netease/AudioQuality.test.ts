import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NeteaseMusicProvider } from "../../src/infrastructure/music/netease/NeteaseMusicProvider";
import { fakeFetch } from "../support/Fetch";

type UrlQuery = { id: string | number; level?: string };

const providerWith = (songUrlV1: (query: UrlQuery) => Promise<unknown>) => {
  const calls = { v1: [] as UrlQuery[], legacy: 0 };
  const provider = new NeteaseMusicProvider({
    minRequestIntervalMs: 0,
    loadApi: async () => ({
      song_url_v1: async (query: UrlQuery) => {
        calls.v1.push({ id: query.id, level: query.level });
        return songUrlV1(query);
      },
      // 选档只走 v1：旧接口按码率取，选不了无损与空间音频，也不该被顺手调用。
      song_url: async () => {
        calls.legacy += 1;
        return { body: { data: [{ url: "http://music.example.com/legacy.mp3" }] } };
      },
    }),
  });
  return { provider, calls };
};

describe("网易云按音质取播放地址", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = fakeFetch(async () => {
      throw new Error("测试禁止网络请求");
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("统一档位换成接口的 level，回报响应里的实际档位与格式，地址转 HTTPS", async () => {
    const { provider, calls } = providerWith(async () => ({
      body: {
        data: [
          { id: 7, url: "http://m701.music.example.net/7.flac", level: "jyeffect", type: "FLAC" },
        ],
      },
    }));
    await expect(provider.getSongAudioVariant("7", "effect")).resolves.toEqual({
      url: "https://m701.music.example.net/7.flac",
      quality: "effect",
      format: "flac",
    });
    expect(calls.v1).toEqual([{ id: "7", level: "jyeffect" }]);
    expect(calls.legacy).toBe(0);
  });

  test("上游降档时报实际档位，不当作请求的那一档", async () => {
    const { provider } = providerWith(async () => ({
      body: {
        data: [
          { id: 7, url: "https://m701.music.example.net/7.mp3", level: "exhigh", type: "mp3" },
        ],
      },
    }));
    await expect(provider.getSongAudioVariant("7", "master")).resolves.toMatchObject({
      quality: "exhigh",
      format: "mp3",
    });
  });

  test("试听片段与空地址都算拿不到，按退路往下试；全部拿不到报不可用且不走解灰", async () => {
    const { provider, calls } = providerWith(async ({ level }) =>
      level === "lossless"
        ? { body: { data: [{ url: "https://m701.music.example.net/sq.flac", level: "lossless" }] } }
        : {
            body: {
              data: [
                {
                  url: "https://m701.music.example.net/trial.mp3",
                  freeTrialInfo: { start: 0, end: 30 },
                },
              ],
            },
          }
    );
    await expect(provider.getSongAudioVariant("8", "hires")).resolves.toMatchObject({
      quality: "lossless",
      url: "https://m701.music.example.net/sq.flac",
    });
    expect(calls.v1.map((call) => call.level)).toEqual(["hires", "lossless"]);

    const empty = providerWith(async () => ({ body: { data: [{ url: null, code: 404 }] } }));
    await expect(empty.provider.getSongAudioVariant("9", "master")).rejects.toMatchObject({
      code: "SONG_UNAVAILABLE",
    });
    expect(empty.calls.v1.map((call) => call.level)).toEqual(["jymaster", "hires", "lossless"]);
    expect(empty.calls.legacy).toBe(0);
  });

  test("同一档命中短缓存；拿不到的结果不缓存，下次重新回源", async () => {
    let attempt = 0;
    const { provider, calls } = providerWith(async () => {
      attempt += 1;
      return attempt === 1
        ? { body: { data: [{ url: null }] } }
        : { body: { data: [{ url: "https://m701.music.example.net/ok.mp3", level: "standard" }] } };
    });
    await expect(provider.getSongAudioVariant("10", "standard")).rejects.toMatchObject({
      code: "SONG_UNAVAILABLE",
    });
    await expect(provider.getSongAudioVariant("10", "standard")).resolves.toMatchObject({
      quality: "standard",
    });
    await expect(provider.getSongAudioVariant("10", "standard")).resolves.toMatchObject({
      quality: "standard",
    });
    expect(calls.v1).toHaveLength(2);
  });
});
