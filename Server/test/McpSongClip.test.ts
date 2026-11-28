import { describe, expect, test } from "bun:test";
import { ClipAudioError, HttpRangeReader } from "../src/mcp/audio/RangeReader";
import { AGENT_CLIP_MAX_MS, SongClipLoader, ticketPathOf } from "../src/mcp/audio/SongClip";
import { parseAudioSpecificConfig } from "../src/mcp/audio/Mp4Clip";
import {
  AAC_FRAME_MS,
  aacSampleSize,
  buildFlac,
  buildMp3,
  buildMp4,
  containsSecret,
  FLAC_FRAME_MS,
  FLAC_PAYLOAD,
  MP3_FRAME_BYTES,
  MP3_FRAME_MS,
  rangeServer,
  readIndex,
  SECRET,
} from "./support/SyntheticAudio";

const SERVER = "http://127.0.0.1:4850";
const UPSTREAM = "https://cdn.example.com/M500abcdef.mp3?vkey=SIGNATURE";
let ticketSeq = 0;

/** 站内票据路由回 302 到上游；每个用例用不同票据，避免进程内缓存串味。 */
const setup = (audio: Uint8Array, options: { ignoreRange?: boolean } = {}) => {
  const ticket = `ticket-${(ticketSeq += 1)}`;
  const path = `/api/songuessr/audio/1234/${ticket}`;
  const upstream = rangeServer({ [UPSTREAM]: audio }, options);
  const fetcher = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    if (String(input) === `${SERVER}${path}`) {
      upstream.requests.push({ url: String(input), range: null });
      return new Response(null, { status: 302, headers: { location: UPSTREAM } });
    }
    return upstream.fetcher(input, init);
  };
  const loader = new SongClipLoader({ serverUrl: SERVER, fetcher });
  return {
    loader,
    requests: upstream.requests,
    audioUrl: `https://game.example.com${path}`,
  };
};

/** MP3 输出逐帧解析：返回每帧载荷里写的帧序号。 */
const mp3Indexes = (data: Uint8Array): number[] => {
  const indexes: number[] = [];
  for (let at = 0; at + MP3_FRAME_BYTES <= data.length; at += MP3_FRAME_BYTES) {
    expect([data[at], data[at + 1]]).toEqual([0xff, 0xfb]);
    indexes.push(readIndex(data, at + 4));
  }
  return indexes;
};

describe("片段截取：MP3", () => {
  test("只取片段对应的帧，跳过文件头的 ID3v2 与结尾的 ID3v1", async () => {
    const { loader, audioUrl } = setup(buildMp3(1200));
    const clip = await loader.load({ audioUrl, startTime: 10_000, endTime: 15_000 });
    expect(clip.mimeType).toBe("audio/mpeg");
    expect(containsSecret(clip.data)).toBe(false);
    const indexes = mp3Indexes(clip.data);
    expect(clip.data.length % MP3_FRAME_BYTES).toBe(0);
    const first = Math.floor(10_000 / MP3_FRAME_MS);
    // 往前多留一帧给比特池，起点最多早两帧。
    expect(indexes[0]).toBeGreaterThanOrEqual(first - 2);
    expect(indexes[0]).toBeLessThanOrEqual(first);
    expect(indexes.at(-1)! * MP3_FRAME_MS).toBeGreaterThanOrEqual(15_000 - MP3_FRAME_MS);
    // 帧是连续的，中间没有漏帧或重复。
    expect(indexes).toEqual(indexes.map((_, offset) => indexes[0]! + offset));
    expect(clip.startTime).toBeLessThanOrEqual(10_000);
    expect(clip.endTime).toBeGreaterThanOrEqual(15_000);
  });

  test("片段越过文件末尾时停在最后一个合法帧，不带出结尾标签", async () => {
    const { loader, audioUrl } = setup(buildMp3(400));
    const clip = await loader.load({ audioUrl, startTime: 9_000, endTime: 20_000 });
    const indexes = mp3Indexes(clip.data);
    expect(indexes.at(-1)).toBe(399);
    expect(containsSecret(clip.data)).toBe(false);
  });

  test("上游无视 Range 回 200 时照样截出同一段", async () => {
    const ranged = setup(buildMp3(600));
    const plain = setup(buildMp3(600), { ignoreRange: true });
    const target = { startTime: 5_000, endTime: 8_000 };
    const left = await ranged.loader.load({ audioUrl: ranged.audioUrl, ...target });
    const right = await plain.loader.load({ audioUrl: plain.audioUrl, ...target });
    expect(mp3Indexes(right.data)).toEqual(mp3Indexes(left.data));
  });

  test("同一片段重复播放走缓存；换了票据（刷新音频）后重新回源", async () => {
    const { loader, audioUrl, requests } = setup(buildMp3(600));
    const first = await loader.load({ audioUrl, startTime: 1_000, endTime: 6_000 });
    const count = requests.length;
    const again = await loader.load({ audioUrl, startTime: 1_000, endTime: 6_000 });
    expect(again).toBe(first);
    expect(requests.length).toBe(count);
    loader.invalidate(audioUrl);
    await loader.load({ audioUrl, startTime: 1_000, endTime: 6_000 });
    expect(requests.length).toBeGreaterThan(count);
  });

  test("并发的同一请求只回源一次", async () => {
    const { loader, audioUrl, requests } = setup(buildMp3(600));
    const [left, right] = await Promise.all([
      loader.load({ audioUrl, startTime: 2_000, endTime: 7_000 }),
      loader.load({ audioUrl, startTime: 2_000, endTime: 7_000 }),
    ]);
    expect(left).toBe(right);
    expect(requests.filter((entry) => entry.range === null)).toHaveLength(1);
  });

  test("超过单次上限的片段只截开头，并如实标出", async () => {
    const { loader, audioUrl } = setup(buildMp3(4000));
    const clip = await loader.load({ audioUrl, startTime: 0, endTime: 100_000 });
    expect(clip.clipped).toBe(true);
    expect(clip.endTime - clip.startTime).toBeLessThanOrEqual(AGENT_CLIP_MAX_MS + MP3_FRAME_MS * 2);
    expect(clip.endTime - clip.startTime).toBeGreaterThanOrEqual(AGENT_CLIP_MAX_MS - MP3_FRAME_MS);
  });
});

describe("片段截取：FLAC", () => {
  test("跳过 ID3、注释与封面块，只重建 STREAMINFO，并清零总样本数与整曲 MD5", async () => {
    const { loader, audioUrl } = setup(buildFlac(600));
    const clip = await loader.load({ audioUrl, startTime: 20_000, endTime: 25_000 });
    expect(clip.mimeType).toBe("audio/flac");
    expect(containsSecret(clip.data)).toBe(false);
    expect(Buffer.from(clip.data.subarray(0, 4)).toString("latin1")).toBe("fLaC");
    // 唯一的元数据块就是 STREAMINFO，且标记为最后一块。
    expect([...clip.data.subarray(4, 8)]).toEqual([0x80, 0, 0, 34]);
    const info = clip.data.subarray(8, 8 + 34);
    expect(info[13]! & 0x0f).toBe(0);
    expect([...info.subarray(14)].every((byte) => byte === 0)).toBe(true);
    const frames: number[] = [];
    for (let at = 42; at < clip.data.length;) {
      expect([clip.data[at], clip.data[at + 1]]).toEqual([0xff, 0xf8]);
      const numberBytes = clip.data[at + 4]! < 0x80 ? 1 : clip.data[at + 4]! < 0xe0 ? 2 : 3;
      const header = 4 + numberBytes + 1;
      frames.push(readIndex(clip.data, at + header));
      at += header + FLAC_PAYLOAD + 2;
    }
    const first = Math.floor(20_000 / FLAC_FRAME_MS);
    expect(frames[0]).toBe(first);
    expect(frames.at(-1)).toBe(Math.ceil(25_000 / FLAC_FRAME_MS) - 1);
    expect(frames).toEqual(frames.map((_, offset) => first + offset));
    expect(clip.startTime).toBeLessThanOrEqual(20_000);
    expect(clip.endTime).toBeGreaterThanOrEqual(25_000);
  });

  test("片段停在文件末尾时丢掉最后一帧，挂在后面的标签不会被当成帧数据带出", async () => {
    const { loader, audioUrl } = setup(buildFlac(200));
    const clip = await loader.load({ audioUrl, startTime: 15_000, endTime: 30_000 });
    expect(containsSecret(clip.data)).toBe(false);
    expect(clip.endTime).toBeLessThan(200 * FLAC_FRAME_MS);
  });
});

describe("片段截取：M4A", () => {
  const adtsFrames = (data: Uint8Array): number[] => {
    const indexes: number[] = [];
    for (let at = 0; at < data.length;) {
      expect([data[at], data[at + 1]]).toEqual([0xff, 0xf1]);
      // 规格 AAC-LC、采样率序号 4（44.1 kHz）、双声道。
      expect(data[at + 2]).toBe((1 << 6) | (4 << 2));
      expect(data[at + 3]! >> 6).toBe(2);
      const length = ((data[at + 3]! & 3) << 11) | (data[at + 4]! << 3) | (data[at + 5]! >> 5);
      const index = readIndex(data, at + 7);
      expect(length).toBe(aacSampleSize(index) + 7);
      indexes.push(index);
      at += length;
    }
    return indexes;
  };

  for (const moovFirst of [true, false]) {
    test(`按样本表截出 ADTS 帧，不带 moov 里的歌名（moov ${moovFirst ? "在前" : "在文件尾"}）`, async () => {
      const { loader, audioUrl } = setup(buildMp4(2000, moovFirst));
      const clip = await loader.load({ audioUrl, startTime: 12_000, endTime: 18_000 });
      expect(clip.mimeType).toBe("audio/aac");
      expect(containsSecret(clip.data)).toBe(false);
      const indexes = adtsFrames(clip.data);
      const first = Math.floor(12_000 / AAC_FRAME_MS);
      expect(indexes[0]).toBe(first);
      expect(indexes.at(-1)).toBe(Math.ceil(18_000 / AAC_FRAME_MS) - 1);
      expect(indexes).toEqual(indexes.map((_, offset) => first + offset));
    });
  }

  test("HE-AAC 的配置退回核心 AAC-LC，非 AAC 规格明确拒绝", () => {
    // AOT 5（SBR）+ 22.05 kHz 核心 + 双声道 + 扩展 44.1 kHz + 底层 AOT 2。
    expect(parseAudioSpecificConfig(new Uint8Array([0x2b, 0x92, 0x08, 0x00]))).toEqual({
      profile: 1,
      rateIndex: 7,
      channels: 2,
    });
    expect(() => parseAudioSpecificConfig(new Uint8Array([0xf8, 0x00]))).toThrow(ClipAudioError);
  });
});

describe("片段截取：取用与失败", () => {
  test("只接受站内播放路径，其它地址一律拒绝", () => {
    expect(ticketPathOf("https://game.example.com/api/songuessr/audio/1234/abc")).toBe(
      "/api/songuessr/audio/1234/abc"
    );
    expect(ticketPathOf("/api/songuessr/audio/1234/abc")).toBe("/api/songuessr/audio/1234/abc");
    for (const bad of [
      "https://cdn.example.com/a.mp3",
      "/api/admin/users",
      "/api/songuessr/audio/1234/abc?redirect=1",
    ])
      expect(() => ticketPathOf(bad)).toThrow(ClipAudioError);
  });

  test("票据失效、限流与跳到内网都给出不带主机名的错误", async () => {
    const respond = (response: () => Response) =>
      new SongClipLoader({ serverUrl: SERVER, fetcher: async () => response() });
    const audioUrl = "/api/songuessr/audio/1234/gone";
    await expect(
      respond(() => new Response(null, { status: 404 })).load({
        audioUrl,
        startTime: 0,
        endTime: 5_000,
      })
    ).rejects.toThrow("本回合的音频已失效");
    await expect(
      respond(() => new Response(null, { status: 429 })).load({
        audioUrl,
        startTime: 0,
        endTime: 5_000,
      })
    ).rejects.toThrow("播放请求过于频繁");
    const internal = respond(
      () => new Response(null, { status: 302, headers: { location: "http://10.0.0.8/a.mp3" } })
    );
    const failure = await internal
      .load({ audioUrl, startTime: 0, endTime: 5_000 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ClipAudioError);
    expect(String(failure)).not.toContain("10.0.0.8");
  });

  test("不认识的格式明确拒绝", async () => {
    const ogg = new Uint8Array(4096);
    ogg.set([0x4f, 0x67, 0x67, 0x53]);
    const { loader, audioUrl } = setup(ogg);
    await expect(loader.load({ audioUrl, startTime: 0, endTime: 5_000 })).rejects.toThrow(
      "暂不支持这种音源格式"
    );
  });

  test("区间读取遵守 Content-Range，越过末尾返回空", async () => {
    const data = new Uint8Array(1000).map((_, index) => index % 251);
    const { fetcher } = rangeServer({ [UPSTREAM]: data });
    const reader = new HttpRangeReader(UPSTREAM, { fetcher, maxStreamBytes: 1 << 20 });
    expect([...(await reader.read(10, 13))]).toEqual([10, 11, 12, 13]);
    expect(reader.size()).toBe(1000);
    expect((await reader.read(995, 2000)).length).toBe(5);
    expect((await reader.read(1000, 1100)).length).toBe(0);
  });

  test("上游报错时提示重新获取音频", async () => {
    const reader = new HttpRangeReader(UPSTREAM, {
      fetcher: async () => new Response("gone", { status: 403 }),
      maxStreamBytes: 1 << 20,
    });
    await expect(reader.read(0, 10)).rejects.toThrow("重新获取音频");
  });

  test("合成样本里确实带着要被剥掉的标签", () => {
    expect(containsSecret(buildMp3(10))).toBe(true);
    expect(containsSecret(buildFlac(10))).toBe(true);
    expect(containsSecret(buildMp4(10, true))).toBe(true);
    expect(SECRET).toContain("Secret");
  });
});
