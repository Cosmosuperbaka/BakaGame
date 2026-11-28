import type { ClipBytes, ClipTarget } from "./ClipWindow";
import {
  asciiAt,
  ClipAudioError,
  concatBytes,
  readUint16,
  readUint32,
  readUint64,
  type RangeReader,
} from "./RangeReader";

/**
 * M4A（MP4 封装的 AAC）片段截取：按 moov 里的样本表找出片段对应的 AAC 帧，
 * 每帧补一个 ADTS 头输出为裸 AAC 流。整个 moov（含 `udta/meta/ilst` 里的歌名歌手）都不输出。
 *
 * 只支持非分片的普通 M4A（音乐平台的下载文件都是这种）；分片 MP4 与 AAC 以外的编码明确报不支持。
 */

interface Box {
  type: string;
  /** 盒内数据（不含盒头）。 */
  start: number;
  end: number;
}

/** 在 `[from, to)` 里逐个列出子盒；尺寸不合法就停。 */
const childBoxes = (bytes: Uint8Array, from: number, to: number): Box[] => {
  const boxes: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = readUint32(bytes, at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = readUint64(bytes, at + 8);
      header = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < header || at + size > to) break;
    boxes.push({ type: asciiAt(bytes, at + 4, 4), start: at + header, end: at + size });
    at += size;
  }
  return boxes;
};

const child = (bytes: Uint8Array, box: Box, type: string): Box | undefined =>
  childBoxes(bytes, box.start, box.end).find((entry) => entry.type === type);

const path = (bytes: Uint8Array, box: Box, types: readonly string[]): Box | undefined => {
  let current: Box | undefined = box;
  for (const type of types) {
    if (!current) return undefined;
    current = child(bytes, current, type);
  }
  return current;
};

/** 顶层盒子：只读盒头逐个跳过，moov 在文件尾时不用读整个 mdat。 */
const locateMoov = async (
  reader: RangeReader,
  audioStart: number
): Promise<{ start: number; size: number }> => {
  let at = audioStart;
  for (let count = 0; count < 64; count += 1) {
    const head = await reader.read(at, at + 15);
    if (head.length < 8) break;
    let size = readUint32(head, 0);
    const type = asciiAt(head, 4, 4);
    if (size === 1 && head.length >= 16) size = readUint64(head, 8);
    if (type === "moof") throw new ClipAudioError("暂不支持分片 MP4 音源");
    if (type === "moov") return { start: at, size };
    if (size < 8) break;
    at += size;
  }
  throw new ClipAudioError("没有在音源里找到 MP4 的 moov");
};

const MOOV_MAX_BYTES = 8 * 1024 * 1024;

interface AacTrack {
  timescale: number;
  profile: number;
  rateIndex: number;
  channels: number;
  sizes: (index: number) => number;
  sampleCount: number;
  /** [样本数, 时长] 的游程。 */
  stts: Array<[number, number]>;
  /** [首块编号, 每块样本数] 的游程（块编号从 1 开始）。 */
  stsc: Array<[number, number]>;
  chunkOffsets: number[];
}

const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

class BitReader {
  private bit = 0;
  constructor(private readonly bytes: Uint8Array) {}
  read(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const byte = this.bytes[this.bit >> 3] ?? 0;
      value = value * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
      this.bit += 1;
    }
    return value;
  }
}

/** AudioSpecificConfig → ADTS 需要的规格、采样率序号与声道配置。HE-AAC 写核心 AAC-LC，解码器会隐式识别 SBR。 */
export const parseAudioSpecificConfig = (
  asc: Uint8Array
): { profile: number; rateIndex: number; channels: number } => {
  const bits = new BitReader(asc);
  const objectType = () => {
    const value = bits.read(5);
    return value === 31 ? 32 + bits.read(6) : value;
  };
  const rateIndexOf = () => {
    const index = bits.read(4);
    if (index !== 15) return index;
    const rate = bits.read(24);
    return AAC_RATES.indexOf(rate);
  };
  let type = objectType();
  const rateIndex = rateIndexOf();
  const channels = bits.read(4);
  if (type === 5 || type === 29) {
    rateIndexOf();
    type = objectType();
  }
  if (type < 1 || type > 4) throw new ClipAudioError("暂不支持这种 AAC 规格");
  if (rateIndex < 0 || rateIndex > 12) throw new ClipAudioError("暂不支持这种 AAC 采样率");
  if (channels < 1 || channels > 7) throw new ClipAudioError("暂不支持这种 AAC 声道配置");
  return { profile: type - 1, rateIndex, channels };
};

/** esds 里的描述符：tag + 变长长度。 */
const descriptor = (
  bytes: Uint8Array,
  at: number,
  end: number
): { tag: number; start: number; end: number } | undefined => {
  if (at >= end) return undefined;
  const tag = bytes[at]!;
  let length = 0;
  let cursor = at + 1;
  for (let index = 0; index < 4 && cursor < end; index += 1) {
    const byte = bytes[cursor]!;
    cursor += 1;
    length = (length << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return { tag, start: cursor, end: Math.min(end, cursor + length) };
};

const audioConfigOf = (bytes: Uint8Array, esds: Box): Uint8Array => {
  const es = descriptor(bytes, esds.start + 4, esds.end);
  if (es?.tag !== 0x03) throw new ClipAudioError("M4A 缺少解码配置");
  const flags = bytes[es.start + 2]!;
  let at = es.start + 3;
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += 1 + bytes[at]!;
  if (flags & 0x20) at += 2;
  const config = descriptor(bytes, at, es.end);
  if (config?.tag !== 0x04) throw new ClipAudioError("M4A 缺少解码配置");
  const specific = descriptor(bytes, config.start + 13, config.end);
  if (specific?.tag !== 0x05) throw new ClipAudioError("M4A 缺少解码配置");
  return bytes.slice(specific.start, specific.end);
};

const tableEntries = (bytes: Uint8Array, box: Box | undefined, width: number): number[][] => {
  if (!box) throw new ClipAudioError("M4A 样本表不完整");
  const count = readUint32(bytes, box.start + 4);
  const rows: number[][] = [];
  for (let index = 0; index < count; index += 1) {
    const at = box.start + 8 + index * width * 4;
    if (at + width * 4 > box.end) break;
    rows.push(Array.from({ length: width }, (_, column) => readUint32(bytes, at + column * 4)));
  }
  return rows;
};

const chunkOffsetsOf = (bytes: Uint8Array, stbl: Box): number[] => {
  const co64 = child(bytes, stbl, "co64");
  if (co64) {
    const count = readUint32(bytes, co64.start + 4);
    return Array.from({ length: count }, (_, index) =>
      readUint64(bytes, co64.start + 8 + index * 8)
    );
  }
  return tableEntries(bytes, child(bytes, stbl, "stco"), 1).map((row) => row[0]!);
};

const sampleSizesOf = (bytes: Uint8Array, stbl: Box): Pick<AacTrack, "sizes" | "sampleCount"> => {
  const stsz = child(bytes, stbl, "stsz");
  if (!stsz) throw new ClipAudioError("M4A 样本表不完整");
  const fixed = readUint32(bytes, stsz.start + 4);
  const sampleCount = readUint32(bytes, stsz.start + 8);
  if (fixed > 0) return { sampleCount, sizes: () => fixed };
  return { sampleCount, sizes: (index) => readUint32(bytes, stsz.start + 12 + index * 4) };
};

const isSoundTrack = (bytes: Uint8Array, trak: Box): boolean => {
  const hdlr = path(bytes, trak, ["mdia", "hdlr"]);
  return hdlr !== undefined && asciiAt(bytes, hdlr.start + 8, 4) === "soun";
};

const parseTrack = (moov: Uint8Array): AacTrack => {
  const root: Box = { type: "moov", start: 8, end: moov.length };
  // 分片 MP4 的 moov 里只有空样本表，样本在后面的 moof 里。
  if (child(moov, root, "mvex")) throw new ClipAudioError("暂不支持分片 MP4 音源");
  const trak = childBoxes(moov, root.start, root.end).find(
    (box) => box.type === "trak" && isSoundTrack(moov, box)
  );
  if (!trak) throw new ClipAudioError("M4A 里没有音轨");
  const mdhd = path(moov, trak, ["mdia", "mdhd"]);
  const stbl = path(moov, trak, ["mdia", "minf", "stbl"]);
  if (!mdhd || !stbl) throw new ClipAudioError("M4A 样本表不完整");
  const timescale = readUint32(moov, mdhd.start + (moov[mdhd.start] === 1 ? 20 : 12));
  const stsd = child(moov, stbl, "stsd");
  const entry = stsd ? childBoxes(moov, stsd.start + 8, stsd.end)[0] : undefined;
  if (entry?.type !== "mp4a") throw new ClipAudioError("暂不支持 AAC 以外的 M4A 编码");
  // QuickTime 声音描述 v1 / v2 在 28 字节的基本字段后还各多 16 / 36 字节。
  const soundVersion = readUint16(moov, entry.start + 8);
  const fields = 28 + (soundVersion === 1 ? 16 : soundVersion === 2 ? 36 : 0);
  const esds = childBoxes(moov, entry.start + fields, entry.end).find((box) => box.type === "esds");
  if (!esds) throw new ClipAudioError("M4A 缺少解码配置");
  return {
    timescale,
    ...parseAudioSpecificConfig(audioConfigOf(moov, esds)),
    ...sampleSizesOf(moov, stbl),
    stts: tableEntries(moov, child(moov, stbl, "stts"), 2).map((row) => [row[0]!, row[1]!]),
    stsc: tableEntries(moov, child(moov, stbl, "stsc"), 3).map((row) => [row[0]!, row[1]!]),
    chunkOffsets: chunkOffsetsOf(moov, stbl),
  };
};

interface SampleSpan {
  first: number;
  last: number;
  /** 片段首个样本的时间（毫秒）。 */
  startMs: number;
  endMs: number;
}

/** 时间 → 样本序号区间：覆盖 `[startTime, endTime)` 的全部样本。 */
const sampleSpan = (track: AacTrack, target: ClipTarget): SampleSpan => {
  const startTicks = (target.startTime * track.timescale) / 1000;
  const endTicks = (target.endTime * track.timescale) / 1000;
  let index = 0;
  let ticks = 0;
  let first = -1;
  let firstTicks = 0;
  for (const [count, delta] of track.stts) {
    for (let step = 0; step < count && index < track.sampleCount; step += 1) {
      if (first < 0 && ticks + delta > startTicks) {
        first = index;
        firstTicks = ticks;
      }
      ticks += delta;
      index += 1;
      if (first >= 0 && ticks >= endTicks) {
        return {
          first,
          last: index - 1,
          startMs: (firstTicks * 1000) / track.timescale,
          endMs: (ticks * 1000) / track.timescale,
        };
      }
    }
  }
  if (first < 0) throw new ClipAudioError("片段位置超出了音源长度");
  return {
    first,
    last: index - 1,
    startMs: (firstTicks * 1000) / track.timescale,
    endMs: (ticks * 1000) / track.timescale,
  };
};

/** 片段内每个样本的绝对偏移与长度。 */
const sampleLocations = (track: AacTrack, span: SampleSpan): Array<[number, number]> => {
  const locations: Array<[number, number]> = [];
  let sample = 0;
  let run = -1;
  for (let chunk = 1; chunk <= track.chunkOffsets.length && sample <= span.last; chunk += 1) {
    while (run + 1 < track.stsc.length && track.stsc[run + 1]![0] <= chunk) run += 1;
    const perChunk = run >= 0 ? track.stsc[run]![1] : 0;
    let offset = track.chunkOffsets[chunk - 1]!;
    for (let step = 0; step < perChunk && sample <= span.last; step += 1) {
      const size = track.sizes(sample);
      if (sample >= span.first) locations.push([offset, size]);
      offset += size;
      sample += 1;
    }
  }
  return locations;
};

const adtsHeader = (track: AacTrack, payload: number): Uint8Array => {
  const length = payload + 7;
  return new Uint8Array([
    0xff,
    0xf1,
    ((track.profile & 3) << 6) | ((track.rateIndex & 0x0f) << 2) | ((track.channels >> 2) & 1),
    ((track.channels & 3) << 6) | ((length >> 11) & 3),
    (length >> 3) & 0xff,
    ((length & 7) << 5) | 0x1f,
    0xfc,
  ]);
};

export const sliceMp4 = async (
  reader: RangeReader,
  audioStart: number,
  target: ClipTarget
): Promise<ClipBytes> => {
  const moovAt = await locateMoov(reader, audioStart);
  if (moovAt.size > MOOV_MAX_BYTES) throw new ClipAudioError("M4A 索引过大，暂不支持");
  const moov = await reader.read(moovAt.start, moovAt.start + moovAt.size - 1);
  if (moov.length < moovAt.size) throw new ClipAudioError("M4A 索引不完整");
  const track = parseTrack(moov);
  const span = sampleSpan(track, target);
  let locations = sampleLocations(track, span);
  let truncated = false;
  let total = 0;
  const kept = locations.findIndex(([, size]) => {
    total += size + 7;
    return total > target.maxBytes;
  });
  if (kept >= 0) {
    locations = locations.slice(0, kept);
    truncated = true;
  }
  if (locations.length === 0) throw new ClipAudioError("片段位置超出了音源长度");
  const from = Math.min(...locations.map(([offset]) => offset));
  const to = Math.max(...locations.map(([offset, size]) => offset + size));
  const media = await reader.read(from, to - 1);
  const parts: Uint8Array[] = [];
  for (const [offset, size] of locations) {
    const payload = media.subarray(offset - from, offset - from + size);
    if (payload.length < size) break;
    parts.push(adtsHeader(track, size), payload);
  }
  const frameMs = (span.endMs - span.startMs) / Math.max(1, span.last - span.first + 1);
  return {
    mimeType: "audio/aac",
    format: "aac",
    data: concatBytes(parts),
    startTime: Math.round(span.startMs),
    endTime: Math.round(span.startMs + frameMs * (parts.length / 2)),
    truncated,
  };
};
