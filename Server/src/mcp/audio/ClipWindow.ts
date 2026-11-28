import { concatBytes, type RangeReader } from "./RangeReader";

/** 一次截取的目标：片段起止（毫秒）与输出上限。 */
export interface ClipTarget {
  startTime: number;
  endTime: number;
  /** 输出的音频数据最多这么多字节，超出就在帧边界截短。 */
  maxBytes: number;
}

/** 截取结果：编码数据原样拼接，不解码、不重编码；起止是按帧换算的实际覆盖范围。 */
export interface ClipBytes {
  mimeType: "audio/mpeg" | "audio/flac" | "audio/aac";
  format: "mp3" | "flac" | "aac";
  data: Uint8Array;
  startTime: number;
  endTime: number;
  /** 因字节上限截短，没有覆盖到目标终点。 */
  truncated: boolean;
}

const CHUNK_BYTES = 64 * 1024;

/**
 * 顺着文件往后读的滑动窗口：帧解析按绝对偏移取字节，缺了就再读一块。
 * 已经越过的部分随时丢掉，内存里只留当前窗口。
 */
export class ClipWindow {
  private bytes: Uint8Array = new Uint8Array();
  private base = 0;
  private ended = false;

  constructor(
    private readonly reader: RangeReader,
    start: number,
    private readonly chunkBytes = CHUNK_BYTES
  ) {
    this.base = start;
  }

  /** 保证 `[offset, offset + length)` 都在窗口里；读到文件末尾时返回 false。 */
  async ensure(offset: number, length: number): Promise<boolean> {
    while (offset + length > this.base + this.bytes.length) {
      if (this.ended) return false;
      const from = this.base + this.bytes.length;
      const want = Math.max(this.chunkBytes, offset + length - from);
      const next = await this.reader.read(from, from + want - 1);
      if (next.length === 0) {
        this.ended = true;
        return false;
      }
      if (next.length < want) this.ended = true;
      this.bytes = this.bytes.length ? concatBytes([this.bytes, next]) : next;
    }
    return true;
  }

  /** 绝对偏移处的字节视图；调用前必须 `ensure` 过。 */
  view(offset: number, length: number): Uint8Array {
    const from = offset - this.base;
    return this.bytes.subarray(from, from + length);
  }

  /** 窗口里从 `offset` 起还剩多少字节（不触发读取）。 */
  available(offset: number): number {
    return Math.max(0, this.base + this.bytes.length - offset);
  }

  /** 丢掉 `offset` 之前的字节。 */
  release(offset: number): void {
    const drop = Math.min(Math.max(0, offset - this.base), this.bytes.length);
    if (drop === 0) return;
    this.bytes = this.bytes.slice(drop);
    this.base += drop;
  }
}
