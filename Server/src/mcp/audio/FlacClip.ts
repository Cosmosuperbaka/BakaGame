import { ClipWindow, type ClipBytes, type ClipTarget } from "./ClipWindow";
import {
  asciiAt,
  ClipAudioError,
  concatBytes,
  readUint16,
  readUint24,
  readUint32,
  type RangeReader,
} from "./RangeReader";

/**
 * FLAC 片段截取：帧头自带帧号（或样本号）与 CRC-8，时间换算是精确的。
 *
 * 输出只重建一个 STREAMINFO：VORBIS_COMMENT（歌名、歌手）、PICTURE（封面）等元数据块一概不带；
 * STREAMINFO 里的总样本数与整曲 MD5 也清零——整曲 MD5 可以拿去对曲库指纹，等于交出答案。
 */

interface StreamInfo {
  /** 原样复制的 34 字节，输出前清零总样本数与 MD5。 */
  raw: Uint8Array;
  minBlock: number;
  maxBlock: number;
  maxFrame: number;
  sampleRate: number;
  totalSamples: number;
}

interface FlacFrame {
  /** 帧首样本号。 */
  sample: number;
  blockSize: number;
}

const CRC8_TABLE = (() => {
  const table = new Uint8Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    table[value] = crc;
  }
  return table;
})();

const crc8 = (bytes: Uint8Array, from: number, to: number): number => {
  let crc = 0;
  for (let index = from; index < to; index += 1) crc = CRC8_TABLE[crc ^ bytes[index]!]!;
  return crc;
};

/** 帧号/样本号的「UTF-8 式」变长编码：返回数值与占用字节数。 */
const codedNumber = (
  bytes: Uint8Array,
  offset: number
): { value: number; length: number } | undefined => {
  const lead = bytes[offset];
  if (lead === undefined) return undefined;
  let length = 1;
  let value = lead;
  if (lead >= 0x80) {
    let mask = 0x40;
    while (lead & mask && length < 7) {
      length += 1;
      mask >>= 1;
    }
    if (length === 1 || offset + length > bytes.length) return undefined;
    value = lead & (mask - 1);
    for (let index = 1; index < length; index += 1) {
      const next = bytes[offset + index]!;
      if ((next & 0xc0) !== 0x80) return undefined;
      value = value * 64 + (next & 0x3f);
    }
  }
  return { value, length };
};

const blockSizeOf = (
  code: number,
  bytes: Uint8Array,
  at: number
): { size: number; extra: number } | undefined => {
  if (code === 1) return { size: 192, extra: 0 };
  if (code >= 2 && code <= 5) return { size: 576 << (code - 2), extra: 0 };
  if (code === 6) return at < bytes.length ? { size: bytes[at]! + 1, extra: 1 } : undefined;
  if (code === 7)
    return at + 1 < bytes.length ? { size: readUint16(bytes, at) + 1, extra: 2 } : undefined;
  if (code >= 8) return { size: 256 << (code - 8), extra: 0 };
  return undefined;
};

const RATE_EXTRA: Record<number, number> = { 12: 1, 13: 2, 14: 2 };

/** 解析并校验一个帧头（同步字、保留位、CRC-8）；不合法返回 undefined。 */
export const parseFlacFrame = (
  bytes: Uint8Array,
  offset: number,
  info: StreamInfo
): FlacFrame | undefined => {
  if (offset + 6 > bytes.length) return undefined;
  if (bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xfe) !== 0xf8) return undefined;
  const variable = (bytes[offset + 1]! & 1) === 1;
  const b2 = bytes[offset + 2]!;
  const b3 = bytes[offset + 3]!;
  const rateCode = b2 & 0x0f;
  if (b2 >> 4 === 0 || rateCode === 15 || b3 >> 4 >= 11 || (b3 & 1) !== 0) return undefined;
  const number = codedNumber(bytes, offset + 4);
  if (!number) return undefined;
  let at = offset + 4 + number.length;
  const block = blockSizeOf(b2 >> 4, bytes, at);
  if (!block) return undefined;
  at += block.extra + (RATE_EXTRA[rateCode] ?? 0);
  if (at >= bytes.length || crc8(bytes, offset, at) !== bytes[at]) return undefined;
  if (block.size > info.maxBlock && info.maxBlock > 0) return undefined;
  return {
    sample: variable ? number.value : number.value * info.minBlock,
    blockSize: block.size,
  };
};

/** 帧头最长 16 字节，确认一帧时多要这么多。 */
const HEADER_BYTES = 16;

const parseStreamInfo = (raw: Uint8Array): StreamInfo => {
  const sampleRate = (raw[10]! << 12) | (raw[11]! << 4) | (raw[12]! >> 4);
  const totalSamples = (raw[13]! & 0x0f) * 2 ** 32 + readUint32(raw, 14);
  return {
    raw,
    minBlock: readUint16(raw, 0),
    maxBlock: readUint16(raw, 2),
    maxFrame: readUint24(raw, 7),
    sampleRate,
    totalSamples,
  };
};

/** 读元数据块链：返回 STREAMINFO 与第一帧的绝对偏移。封面块可能有几百 KB，只读块头跳过去。 */
const readMetadata = async (
  reader: RangeReader,
  audioStart: number
): Promise<{ info: StreamInfo; framesStart: number }> => {
  const window = new ClipWindow(reader, audioStart, 8 * 1024);
  if (
    !(await window.ensure(audioStart, 4 + 4 + 34)) ||
    asciiAt(window.view(audioStart, 4), 0, 4) !== "fLaC"
  )
    throw new ClipAudioError("音源不是有效的 FLAC");
  const info = parseStreamInfo(window.view(audioStart + 8, 34).slice());
  if (info.sampleRate === 0) throw new ClipAudioError("FLAC 缺少采样率");
  let at = audioStart + 4;
  for (let blocks = 0; blocks < 256; blocks += 1) {
    const reread = window.available(at) >= 4 ? window : new ClipWindow(reader, at, 8 * 1024);
    if (!(await reread.ensure(at, 4))) throw new ClipAudioError("FLAC 元数据不完整");
    const header = reread.view(at, 4);
    const last = (header[0]! & 0x80) !== 0;
    at += 4 + readUint24(header, 1);
    if (last) return { info, framesStart: at };
  }
  throw new ClipAudioError("FLAC 元数据块过多");
};

/** 往后找一个能与下一帧首尾相接的帧头（帧号连续），最多找 `limit` 字节。 */
const findFrame = async (
  window: ClipWindow,
  offset: number,
  limit: number,
  info: StreamInfo
): Promise<{ offset: number; frame: FlacFrame } | undefined> => {
  for (let at = offset; at < offset + limit; at += 1) {
    if (!(await window.ensure(at, HEADER_BYTES))) return undefined;
    const frame = parseFlacFrame(window.view(at, HEADER_BYTES), 0, info);
    if (!frame) continue;
    const next = await nextFrame(window, at, frame, info);
    if (next !== undefined) return { offset: at, frame };
  }
  return undefined;
};

/**
 * 当前帧之后的下一个帧头偏移：样本号必须正好接上。读到文件末尾时 `eof` 为真——
 * 末尾可能挂着 ID3v1 / APE 标签（里面就是歌名），最后这一帧不输出。
 * 找不到接得上的帧头返回 undefined。
 */
const nextFrame = async (
  window: ClipWindow,
  offset: number,
  frame: FlacFrame,
  info: StreamInfo
): Promise<{ end: number; eof: boolean } | undefined> => {
  const limit = (info.maxFrame || 1 << 20) + HEADER_BYTES;
  const expected = frame.sample + frame.blockSize;
  for (let at = offset + 2; at < offset + limit; at += 1) {
    if (!(await window.ensure(at, 2))) return { end: at, eof: true };
    const pair = window.view(at, 2);
    if (pair[0] !== 0xff || (pair[1]! & 0xfe) !== 0xf8) continue;
    await window.ensure(at, HEADER_BYTES);
    const candidate = parseFlacFrame(
      window.view(at, Math.min(HEADER_BYTES, window.available(at))),
      0,
      info
    );
    if (candidate?.sample === expected) return { end: at, eof: false };
  }
  return undefined;
};

/** 估算落点前多读这么多秒：FLAC 压缩率随段落起伏，按比例估的偏移可能偏后。 */
const SEEK_MARGIN_MS = 3_000;
const MAX_SEEKS = 4;

/** 找到覆盖片段起点的帧：落点偏后就往前退，偏前就顺着帧链往后走。 */
const seekStart = async (
  reader: RangeReader,
  info: StreamInfo,
  framesStart: number,
  span: { startSample: number; endSample: number; maxBytes: number }
): Promise<{ window: ClipWindow; offset: number; frame: FlacFrame }> => {
  const targetSample = span.startSample;
  const audioBytes = Math.max(1, (reader.size() ?? framesStart + 1) - framesStart);
  const bytesPerSample = info.totalSamples > 0 ? audioBytes / info.totalSamples : 0;
  if (bytesPerSample === 0) throw new ClipAudioError("FLAC 缺少总长度，无法定位片段");
  const margin = Math.max(64 * 1024, ((SEEK_MARGIN_MS * info.sampleRate) / 1000) * bytesPerSample);
  // 一次读够整段：按估算的片段字节数取块，避免几十次小区间请求。
  const chunk =
    Math.min(span.maxBytes, (span.endSample - span.startSample) * bytesPerSample) + margin * 2;
  let guess = framesStart + targetSample * bytesPerSample;
  for (let attempt = 0; attempt < MAX_SEEKS; attempt += 1) {
    const from = Math.max(framesStart, Math.floor(guess - margin * (attempt + 1)));
    const window = new ClipWindow(reader, from, Math.ceil(chunk));
    const found = await findFrame(window, from, 1 << 20, info);
    if (!found) break;
    if (found.frame.sample > targetSample && from > framesStart) {
      guess -= (found.frame.sample - targetSample) * bytesPerSample;
      continue;
    }
    return { window, ...found };
  }
  throw new ClipAudioError("没能在 FLAC 里定位到片段起点");
};

const streamInfoBlock = (info: StreamInfo): Uint8Array => {
  const raw = info.raw.slice();
  raw[13] = raw[13]! & 0xf0;
  raw.fill(0, 14, 34);
  return concatBytes([new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22]), raw]);
};

export const sliceFlac = async (
  reader: RangeReader,
  audioStart: number,
  target: ClipTarget
): Promise<ClipBytes> => {
  const { info, framesStart } = await readMetadata(reader, audioStart);
  const startSample = Math.floor((target.startTime * info.sampleRate) / 1000);
  const endSample = Math.ceil((target.endTime * info.sampleRate) / 1000);
  const { window, ...located } = await seekStart(reader, info, framesStart, {
    startSample,
    endSample,
    maxBytes: target.maxBytes,
  });
  let { offset, frame } = located;
  const header = streamInfoBlock(info);
  const parts: Uint8Array[] = [header];
  let bytes = header.length;
  let coveredFrom: number | undefined;
  let coveredTo = frame.sample;
  let truncated = false;
  while (frame.sample < endSample) {
    const next = await nextFrame(window, offset, frame, info);
    if (!next || next.eof) break;
    const length = next.end - offset;
    if (frame.sample + frame.blockSize > startSample) {
      if (bytes + length > target.maxBytes) {
        truncated = true;
        break;
      }
      parts.push(window.view(offset, length).slice());
      bytes += length;
      coveredFrom ??= frame.sample;
      coveredTo = frame.sample + frame.blockSize;
    }
    window.release(next.end);
    const following = parseFlacFrame(window.view(next.end, HEADER_BYTES), 0, info);
    if (!following) break;
    offset = next.end;
    frame = following;
  }
  if (coveredFrom === undefined) throw new ClipAudioError("片段位置超出了音源长度");
  return {
    mimeType: "audio/flac",
    format: "flac",
    data: concatBytes(parts),
    startTime: Math.round((coveredFrom * 1000) / info.sampleRate),
    endTime: Math.round((coveredTo * 1000) / info.sampleRate),
    truncated,
  };
};
