import { fetchWithGuardedRedirects } from "../../infrastructure/OutboundGuard";

/**
 * 按字节区间读一段音频文件。三种容器的截取都只依赖这一个能力：
 * 先读开头找出格式与时间轴，再按估算的偏移只取片段附近的数据，不下载整首。
 */
export interface RangeReader {
  /** 读 `[start, end]`（含两端）；越过文件末尾时返回实际读到的部分。 */
  read(start: number, end: number): Promise<Uint8Array>;
  /** 文件总长；上游不报总长时为 undefined。 */
  size(): number | undefined;
}

export type AudioFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** 截取失败一律抛这个错，文案直接回给 Agent，不带上游地址。 */
export class ClipAudioError extends Error {
  readonly code = "AUDIO_CLIP_UNAVAILABLE";
}

export const readUint16 = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset]! << 8) | bytes[offset + 1]!) >>> 0;

export const readUint24 = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset + 2]!) >>> 0;

export const readUint32 = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset]! << 24) |
    (bytes[offset + 1]! << 16) |
    (bytes[offset + 2]! << 8) |
    bytes[offset + 3]!) >>>
  0;

export const readUint64 = (bytes: Uint8Array, offset: number): number =>
  readUint32(bytes, offset) * 2 ** 32 + readUint32(bytes, offset + 4);

export const asciiAt = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

export const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** ID3v2 标签的总长（含头与可选尾）；开头不是 ID3v2 时为 0。标签里就是歌名与歌手，必须整段跳过。 */
export const id3v2Length = (bytes: Uint8Array): number => {
  if (bytes.length < 10 || asciiAt(bytes, 0, 3) !== "ID3") return 0;
  const size =
    ((bytes[6]! & 0x7f) << 21) |
    ((bytes[7]! & 0x7f) << 14) |
    ((bytes[8]! & 0x7f) << 7) |
    (bytes[9]! & 0x7f);
  const footer = (bytes[5]! & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
};

const CONTENT_RANGE = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i;

/**
 * 读响应体，最多读 `limit` 字节就停：上游无视 Range 回 200 整文件时，不能把整首歌都读进内存。
 */
const readLimited = async (
  response: Response,
  skip: number,
  limit: number
): Promise<Uint8Array> => {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let skipped = 0;
  let kept = 0;
  try {
    while (kept < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      let chunk = value;
      if (skipped < skip) {
        const drop = Math.min(skip - skipped, chunk.length);
        skipped += drop;
        chunk = chunk.subarray(drop);
      }
      if (chunk.length === 0) continue;
      const take = chunk.subarray(0, limit - kept);
      parts.push(take);
      kept += take.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return concatBytes(parts);
};

export interface HttpRangeReaderOptions {
  fetcher: AudioFetcher;
  /** 不带 Range 支持的上游回 200 时，为了跳到偏移最多愿意读的字节数。 */
  maxStreamBytes: number;
  signal?: AbortSignal;
}

/**
 * 上游音频的区间读取：每一跳都过出站守卫（上游地址来自第三方接口，属于不可信输入），
 * 不带 Cookie、不带来源页。
 */
export class HttpRangeReader implements RangeReader {
  private total: number | undefined;

  constructor(
    private readonly url: string,
    private readonly options: HttpRangeReaderOptions
  ) {}

  size(): number | undefined {
    return this.total;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    if (this.total !== undefined && start >= this.total) return new Uint8Array();
    const last = this.total === undefined ? end : Math.min(end, this.total - 1);
    const response = await fetchWithGuardedRedirects(this.options.fetcher, this.url, {
      headers: { range: `bytes=${start}-${last}` },
      referrerPolicy: "no-referrer",
      ...(this.options.signal ? { signal: this.options.signal } : {}),
    });
    if (response.status === 206) {
      const match = CONTENT_RANGE.exec(response.headers.get("content-range") ?? "");
      if (match && match[3] !== "*") this.total = Number(match[3]);
      const from = match ? Number(match[1]) : start;
      return readLimited(response, Math.max(0, start - from), last - start + 1);
    }
    if (response.status === 200) {
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > 0) this.total = length;
      if (start > this.options.maxStreamBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new ClipAudioError("音源不支持按区间读取，片段太靠后无法截取");
      }
      return readLimited(response, start, last - start + 1);
    }
    await response.body?.cancel().catch(() => undefined);
    throw new ClipAudioError(`音源暂时不可用（HTTP ${response.status}），可以先点「重新获取音频」`);
  }
}
