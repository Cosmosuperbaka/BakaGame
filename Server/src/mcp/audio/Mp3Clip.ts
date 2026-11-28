import { ClipWindow, type ClipBytes, type ClipTarget } from "./ClipWindow";
import { asciiAt, ClipAudioError, concatBytes, readUint32, type RangeReader } from "./RangeReader";

/**
 * MP3 片段截取：按帧头换算时间，只拼接覆盖片段的完整帧，不解码。
 *
 * 文件开头的 ID3v2（歌名、歌手、封面）由调用方跳过；片段从中间截起，结尾也停在最后一个合法帧，
 * 末尾的 ID3v1 / APE 标签不会被带出去。只认 Layer III：音乐平台的 MP3 都是它，
 * 只认一种层也让重新同步时的误判更少。
 */

interface Mp3Header {
  /** 3 = MPEG-1，2 = MPEG-2，0 = MPEG-2.5。 */
  version: number;
  sampleRate: number;
  /** kbps */
  bitrate: number;
  length: number;
  samples: number;
  mono: boolean;
  crc: boolean;
}

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

export const parseMp3Header = (bytes: Uint8Array, offset: number): Mp3Header | undefined => {
  if (offset + 4 > bytes.length) return undefined;
  const b1 = bytes[offset + 1]!;
  const b2 = bytes[offset + 2]!;
  const b3 = bytes[offset + 3]!;
  if (bytes[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return undefined;
  const version = (b1 >> 3) & 3;
  if (version === 1 || ((b1 >> 1) & 3) !== 1) return undefined;
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3 || (b3 & 3) === 2)
    return undefined;
  const bitrate = (version === 3 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex]!;
  const sampleRate = SAMPLE_RATES[version]![rateIndex]!;
  const padding = (b2 >> 1) & 1;
  const length = Math.floor(((version === 3 ? 144_000 : 72_000) * bitrate) / sampleRate) + padding;
  return {
    version,
    sampleRate,
    bitrate,
    length,
    samples: version === 3 ? 1152 : 576,
    mono: b3 >> 6 === 3,
    crc: (b1 & 1) === 0,
  };
};

const sameStream = (left: Mp3Header, right: Mp3Header): boolean =>
  left.version === right.version && left.sampleRate === right.sampleRate;

/** 连续三帧首尾相接才算找到帧边界；数据里偶然出现的 0xFFE 同步字一般接不上第二帧。 */
const CHAIN = 3;

const isChained = async (
  window: ClipWindow,
  offset: number,
  first: Mp3Header
): Promise<boolean> => {
  let at = offset + first.length;
  for (let index = 1; index < CHAIN; index += 1) {
    if (!(await window.ensure(at, 4))) return true;
    const next = parseMp3Header(window.view(at, 4), 0);
    if (!next || !sameStream(first, next)) return false;
    at += next.length;
  }
  return true;
};

/** 从 `offset` 起找第一个可信帧，最多往后找 `limit` 字节。 */
const resync = async (
  window: ClipWindow,
  offset: number,
  limit: number
): Promise<{ offset: number; header: Mp3Header } | undefined> => {
  for (let at = offset; at < offset + limit; at += 1) {
    if (!(await window.ensure(at, 4))) return undefined;
    const header = parseMp3Header(window.view(at, 4), 0);
    if (header && (await isChained(window, at, header))) return { offset: at, header };
  }
  return undefined;
};

interface Mp3Timeline {
  /** 第一帧音频（跳过 Xing / Info / VBRI 头帧）的绝对偏移。 */
  dataStart: number;
  header: Mp3Header;
  /** 毫秒 → 绝对字节偏移的估算。 */
  byteAt(ms: number): number;
  /** 绝对字节偏移 → 毫秒的估算。 */
  msAt(offset: number): number;
}

interface VbrInfo {
  frames?: number;
  bytes?: number;
  toc?: Uint8Array;
}

const xingAt = (frame: Uint8Array, header: Mp3Header): VbrInfo | undefined => {
  const side = header.version === 3 ? (header.mono ? 17 : 32) : header.mono ? 9 : 17;
  for (const start of [4 + side, 4 + side + 2]) {
    const tag = asciiAt(frame, start, 4);
    if (tag !== "Xing" && tag !== "Info") continue;
    const flags = readUint32(frame, start + 4);
    let at = start + 8;
    const info: VbrInfo = {};
    if (flags & 1) {
      info.frames = readUint32(frame, at);
      at += 4;
    }
    if (flags & 2) {
      info.bytes = readUint32(frame, at);
      at += 4;
    }
    if (flags & 4) info.toc = frame.slice(at, at + 100);
    return info;
  }
  if (asciiAt(frame, 36, 4) === "VBRI")
    return { bytes: readUint32(frame, 36 + 10), frames: readUint32(frame, 36 + 14) };
  return undefined;
};

const tocByte = (toc: Uint8Array, percent: number): number => {
  const clamped = Math.min(99.999, Math.max(0, percent));
  const index = Math.floor(clamped);
  const low = toc[index]!;
  const high = index < 99 ? toc[index + 1]! : 256;
  return (low + (high - low) * (clamped - index)) / 256;
};

/** 目录映射是单调的：二分求出某个字节占比对应的时间。 */
const invertShare = (share: (ms: number) => number, ratio: number, durationMs: number): number => {
  let low = 0;
  let high = durationMs;
  for (let step = 0; step < 40; step += 1) {
    const middle = (low + high) / 2;
    if (share(middle) < ratio) low = middle;
    else high = middle;
  }
  return low;
};

/** 用首帧建立时间轴：有 Xing 目录按目录插值，没有就按首帧码率当 CBR。 */
const timelineOf = async (
  window: ClipWindow,
  first: { offset: number; header: Mp3Header },
  fileSize: number | undefined
): Promise<Mp3Timeline> => {
  await window.ensure(first.offset, first.header.length);
  const vbr = xingAt(window.view(first.offset, first.header.length), first.header);
  const dataStart = vbr ? first.offset + first.header.length : first.offset;
  const header = vbr
    ? ((await resync(window, dataStart, 4096))?.header ?? first.header)
    : first.header;
  const frameMs = (header.samples * 1000) / header.sampleRate;
  const audioBytes =
    vbr?.bytes ?? (fileSize !== undefined ? Math.max(0, fileSize - dataStart) : undefined);
  if (vbr?.frames && audioBytes) {
    const durationMs = vbr.frames * frameMs;
    const toc = vbr.toc;
    const share = (ms: number) => (toc ? tocByte(toc, (ms / durationMs) * 100) : ms / durationMs);
    return {
      dataStart,
      header,
      byteAt: (ms) => dataStart + Math.round(share(ms) * audioBytes),
      msAt: (offset) => invertShare(share, (offset - dataStart) / audioBytes, durationMs),
    };
  }
  const bytesPerMs = (header.bitrate * 1000) / 8 / 1000;
  return {
    dataStart,
    header,
    byteAt: (ms) => dataStart + Math.round(ms * bytesPerMs),
    msAt: (offset) => (offset - dataStart) / bytesPerMs,
  };
};

/** 往前多留一帧：首帧的比特池可能引用上一帧的数据，缺了它解码器开头会有一声杂音。 */
const LEAD_FRAMES = 1;

export const sliceMp3 = async (
  reader: RangeReader,
  audioStart: number,
  target: ClipTarget
): Promise<ClipBytes> => {
  const head = new ClipWindow(reader, audioStart);
  const first = await resync(head, audioStart, 64 * 1024);
  if (!first) throw new ClipAudioError("没有在音源里找到 MP3 音频帧");
  const timeline = await timelineOf(head, first, reader.size());
  const frameBytes = timeline.header.length;
  const from = Math.max(
    timeline.dataStart,
    timeline.byteAt(target.startTime) - frameBytes * (LEAD_FRAMES + 1)
  );

  // 一次读够整段：按估算的片段字节数取块，避免几十次小区间请求。
  const estimate = timeline.byteAt(target.endTime) - from + frameBytes * 4;
  const window = new ClipWindow(reader, from, Math.min(target.maxBytes, estimate) + 32 * 1024);
  const start = await resync(window, from, 64 * 1024);
  if (!start) throw new ClipAudioError("片段位置超出了音源长度");
  const parts: Uint8Array[] = [];
  const frameMs = (start.header.samples * 1000) / start.header.sampleRate;
  const startMs = Math.max(0, timeline.msAt(start.offset));
  let at = start.offset;
  let bytes = 0;
  let coveredMs = 0;
  let truncated = false;
  while (startMs + coveredMs < target.endTime) {
    if (!(await window.ensure(at, 4))) break;
    const header = parseMp3Header(window.view(at, 4), 0);
    if (!header || !sameStream(start.header, header)) break;
    if (bytes + header.length > target.maxBytes) {
      truncated = true;
      break;
    }
    if (!(await window.ensure(at, header.length))) break;
    parts.push(window.view(at, header.length).slice());
    bytes += header.length;
    coveredMs += frameMs;
    at += header.length;
    window.release(at);
  }
  if (parts.length === 0) throw new ClipAudioError("片段位置超出了音源长度");
  return {
    mimeType: "audio/mpeg",
    format: "mp3",
    data: concatBytes(parts),
    startTime: Math.round(startMs),
    endTime: Math.round(startMs + coveredMs),
    truncated,
  };
};
