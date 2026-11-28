import { LRUCache } from "lru-cache";
import { SONG_AUDIO_ROUTE_PREFIX } from "../../application/songuessr/AudioTicket";
import type { ClipBytes, ClipTarget } from "./ClipWindow";
import { sliceFlac } from "./FlacClip";
import { sliceMp3 } from "./Mp3Clip";
import { sliceMp4 } from "./Mp4Clip";
import {
  asciiAt,
  ClipAudioError,
  HttpRangeReader,
  id3v2Length,
  type AudioFetcher,
  type RangeReader,
} from "./RangeReader";

/**
 * Agent 座位的「听片段」：拿本回合的站内播放地址（与人类页面同一张票据），
 * 由 MCP 这一侧回源取出片段对应的那一小段编码数据，内联进工具结果。
 *
 * - Agent 拿到的只有音频数据本身，没有任何地址：站内票据地址会跳转到带歌曲标识的上游地址，
 *   交给 Agent 等于交出答案；
 * - 只取片段附近的字节（按帧换算区间），不下载整首，也不经过任何对外路由；
 * - 文件头尾的标签（ID3、Vorbis 注释、MP4 元数据、封面）一概不输出。
 */

/** 单次最多给 Agent 这么长的片段：手动出题允许整首，内联整首会让工具结果大到客户端吃不下。 */
export const AGENT_CLIP_MAX_MS = 60_000;
/** 输出数据上限（编码后字节，base64 之前）。 */
export const AGENT_CLIP_MAX_BYTES = 4 * 1024 * 1024;
const CLIP_TIMEOUT_MS = 20_000;
const PROBE_BYTES = 64 * 1024;
/** 上游无视 Range 时为了跳到片段最多愿意顺序读这么多。 */
const MAX_STREAM_BYTES = 24 * 1024 * 1024;

export interface SongClipRequest {
  /** 快照里的本回合站内播放地址（`/api/songuessr/audio/<房号>/<票据>`）。 */
  audioUrl: string;
  startTime: number;
  endTime: number;
}

export interface SongClipAudio extends ClipBytes {
  /** 片段比单次上限长，只截了前一段。 */
  clipped: boolean;
}

export interface SongClipPort {
  load(request: SongClipRequest): Promise<SongClipAudio>;
  /** 「重新获取音频」之后上游地址会换，旧缓存作废。 */
  invalidate(audioUrl: string): void;
}

/** 已经读过的文件开头直接复用，格式探测与帧解析不再重复请求同一段。 */
class PrefetchedReader implements RangeReader {
  constructor(
    private readonly inner: RangeReader,
    private readonly head: Uint8Array
  ) {}

  size(): number | undefined {
    return this.inner.size();
  }

  read(start: number, end: number): Promise<Uint8Array> {
    if (end < this.head.length) return Promise.resolve(this.head.subarray(start, end + 1));
    return this.inner.read(start, end);
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** 只接受站内播放路径：快照来自自己连着的服务端，路径不对说明快照坏了，不去碰别的路由。 */
export const ticketPathOf = (audioUrl: string): string => {
  let url: URL;
  try {
    url = new URL(audioUrl, "http://ticket.invalid");
  } catch {
    throw new ClipAudioError("本回合没有可用的播放地址");
  }
  if (!url.pathname.startsWith(`${SONG_AUDIO_ROUTE_PREFIX}/`) || url.search)
    throw new ClipAudioError("本回合没有可用的播放地址");
  return url.pathname;
};

/** 站内票据路由只回 302：读出跳转目标，不跟随（目标交给出站守卫逐跳复核）。 */
const resolveUpstream = async (
  fetcher: AudioFetcher,
  ticketUrl: string,
  signal: AbortSignal
): Promise<string> => {
  const response = await fetcher(ticketUrl, { redirect: "manual", signal });
  await response.body?.cancel().catch(() => undefined);
  const location = REDIRECTS.has(response.status) ? response.headers.get("location") : null;
  if (location) return new URL(location, ticketUrl).href;
  if (response.status === 429) throw new ClipAudioError("播放请求过于频繁，请稍后再试");
  throw new ClipAudioError("本回合的音频已失效；可以先点「重新获取音频」再播放");
};

const sliceClip = async (reader: RangeReader, target: ClipTarget): Promise<ClipBytes> => {
  const probe = await reader.read(0, PROBE_BYTES - 1);
  if (probe.length === 0) throw new ClipAudioError("音源是空的");
  const prefetched = new PrefetchedReader(reader, probe);
  const audioStart = id3v2Length(probe);
  const head = await prefetched.read(audioStart, audioStart + 11);
  if (asciiAt(head, 0, 4) === "fLaC") return sliceFlac(prefetched, audioStart, target);
  if (asciiAt(head, 4, 4) === "ftyp") return sliceMp4(prefetched, audioStart, target);
  if (["OggS", "RIFF"].includes(asciiAt(head, 0, 4)) || head[0] === 0x3c)
    throw new ClipAudioError("暂不支持这种音源格式");
  return sliceMp3(prefetched, audioStart, target);
};

/**
 * 同一回合的片段在进程内共用：同房多个 Agent、同一 Agent 重播都不再回源。
 * 键里带票据，换回合即换键；按字节计容量，最旧的先淘汰。
 */
const CACHE = new LRUCache<string, SongClipAudio>({
  maxSize: 32 * 1024 * 1024,
  sizeCalculation: (clip) => Math.max(1, clip.data.length),
  ttl: 10 * 60_000,
});
const INFLIGHT = new Map<string, Promise<SongClipAudio>>();

export interface SongClipLoaderOptions {
  /** 游戏连接所连的服务端（远程入口是回环地址）；票据路径拼在它后面。 */
  serverUrl: string;
  fetcher?: AudioFetcher;
  timeoutMs?: number;
}

export class SongClipLoader implements SongClipPort {
  private readonly serverUrl: string;
  private readonly fetcher: AudioFetcher;
  private readonly timeoutMs: number;

  constructor(options: SongClipLoaderOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? CLIP_TIMEOUT_MS;
  }

  private keyOf(path: string, startTime: number, endTime: number): string {
    return `${this.serverUrl}${path}|${startTime}|${endTime}`;
  }

  load(request: SongClipRequest): Promise<SongClipAudio> {
    const path = ticketPathOf(request.audioUrl);
    const startTime = Math.max(0, Math.round(request.startTime));
    const wantedEnd = Math.max(startTime + 1, Math.round(request.endTime));
    const endTime = Math.min(wantedEnd, startTime + AGENT_CLIP_MAX_MS);
    const key = this.keyOf(path, startTime, endTime);
    const cached = CACHE.get(key);
    if (cached) return Promise.resolve(cached);
    const running = INFLIGHT.get(key);
    if (running) return running;
    const task = this.fetchClip(path, { startTime, endTime, maxBytes: AGENT_CLIP_MAX_BYTES })
      .then((clip) => {
        const audio = { ...clip, clipped: endTime < wantedEnd };
        CACHE.set(key, audio);
        return audio;
      })
      .finally(() => INFLIGHT.delete(key));
    INFLIGHT.set(key, task);
    return task;
  }

  invalidate(audioUrl: string): void {
    let path: string;
    try {
      path = ticketPathOf(audioUrl);
    } catch {
      return;
    }
    const prefix = `${this.serverUrl}${path}|`;
    for (const key of [...CACHE.keys()]) if (key.startsWith(prefix)) CACHE.delete(key);
  }

  private async fetchClip(path: string, target: ClipTarget): Promise<ClipBytes> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const upstream = await resolveUpstream(this.fetcher, `${this.serverUrl}${path}`, signal);
      const reader = new HttpRangeReader(upstream, {
        fetcher: this.fetcher,
        maxStreamBytes: MAX_STREAM_BYTES,
        signal,
      });
      return await sliceClip(reader, target);
    } catch (error) {
      if (error instanceof ClipAudioError) throw error;
      if (signal.aborted) throw new ClipAudioError("取音频超时，请稍后再试");
      // 出站守卫与网络错误的原文可能带上游主机名，不原样回给 Agent。
      throw new ClipAudioError("暂时取不到本回合的音频，请稍后再试");
    }
  }
}
