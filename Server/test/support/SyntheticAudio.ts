/**
 * 测试用的合成音频：帧头与容器结构是真的，载荷里只写帧序号，用来断言截出了哪几帧。
 * 每种格式都在文件头尾挂上带「Secret」字样的标签，断言输出里一个字节都不带。
 */

export const SECRET = "SecretTitle";

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

const u16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];
const u24 = (value: number): number[] => [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
const u32 = (value: number): number[] => [
  (value >>> 24) & 0xff,
  (value >> 16) & 0xff,
  (value >> 8) & 0xff,
  value & 0xff,
];

const bytes = (...parts: Array<number[] | Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** 帧序号写成两字节，序号小于 65280 时载荷里不会出现 0xFF 开头的同步字。 */
const indexPayload = (index: number, length: number): Uint8Array => {
  const payload = new Uint8Array(length);
  payload[0] = (index >> 8) & 0xff;
  payload[1] = index & 0xff;
  return payload;
};

export const readIndex = (data: Uint8Array, offset: number): number =>
  (data[offset]! << 8) | data[offset + 1]!;

const id3v2 = (): Uint8Array => {
  const body = bytes(
    ascii("TIT2"),
    u32(SECRET.length + 1),
    [0, 0, 0],
    ascii(SECRET),
    new Array(64).fill(0)
  );
  const size = body.length;
  const syncsafe = [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];
  return bytes(ascii("ID3"), [3, 0, 0], syncsafe, body);
};

const id3v1 = (): Uint8Array => {
  const tag = new Uint8Array(128);
  tag.set(ascii("TAG"), 0);
  tag.set(ascii(SECRET), 3);
  return tag;
};

/** MPEG-1 Layer III、128 kbps、44.1 kHz、无填充：每帧 417 字节、1152 个样本（约 26.12 毫秒）。 */
export const MP3_FRAME_BYTES = 417;
export const MP3_FRAME_MS = (1152 * 1000) / 44100;

export const buildMp3 = (frames: number): Uint8Array =>
  bytes(
    id3v2(),
    ...Array.from({ length: frames }, (_, index) =>
      bytes([0xff, 0xfb, 0x90, 0x00], indexPayload(index, MP3_FRAME_BYTES - 4))
    ),
    id3v1()
  );

/** 帧头 CRC-8（多项式 0x07）。 */
const crc8 = (data: number[]): number => {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
};

const utf8Number = (value: number): number[] => {
  if (value < 0x80) return [value];
  if (value < 0x800) return [0xc0 | (value >> 6), 0x80 | (value & 0x3f)];
  return [0xe0 | (value >> 12), 0x80 | ((value >> 6) & 0x3f), 0x80 | (value & 0x3f)];
};

/** 定长 4096 样本、44.1 kHz：每帧约 92.88 毫秒。 */
export const FLAC_BLOCK = 4096;
export const FLAC_FRAME_MS = (FLAC_BLOCK * 1000) / 44100;
export const FLAC_PAYLOAD = 900;

export const buildFlac = (frames: number): Uint8Array => {
  const total = frames * FLAC_BLOCK;
  const streamInfo = [
    ...u16(FLAC_BLOCK),
    ...u16(FLAC_BLOCK),
    ...u24(0),
    ...u24(2048),
    0x0a,
    0xc4,
    0x42,
    0xf0 | (Math.floor(total / 2 ** 32) & 0x0f),
    ...u32(total >>> 0),
    ...new Array(16).fill(0xab),
  ];
  const comment = bytes(ascii(`TITLE=${SECRET}`), new Array(32).fill(0));
  const picture = bytes(new Array(100_000).fill(0), ascii("SecretCover"));
  const frameBytes = Array.from({ length: frames }, (_, index) => {
    const header = [0xff, 0xf8, 0xc9, 0x18, ...utf8Number(index)];
    return bytes(header, [crc8(header)], indexPayload(index, FLAC_PAYLOAD), [0, 0]);
  });
  return bytes(
    id3v2(),
    ascii("fLaC"),
    [0x00, ...u24(34)],
    streamInfo,
    [0x04, ...u24(comment.length)],
    comment,
    [0x86, ...u24(picture.length)],
    picture,
    ...frameBytes,
    id3v1()
  );
};

const box = (type: string, ...children: Array<number[] | Uint8Array>): Uint8Array => {
  const body = bytes(...children);
  return bytes(u32(body.length + 8), ascii(type), body);
};

/** AAC-LC、44.1 kHz、双声道：每个样本 1024 点（约 23.22 毫秒），每块 10 个样本。 */
export const AAC_FRAME_MS = (1024 * 1000) / 44100;
const SAMPLES_PER_CHUNK = 10;
export const aacSampleSize = (index: number): number => 180 + (index % 7);

const esds = (): Uint8Array => {
  const specific = [0x05, 2, 0x12, 0x10];
  const config = [
    0x04,
    13 + specific.length,
    0x40,
    0x15,
    0,
    0,
    0,
    ...u32(128_000),
    ...u32(128_000),
    ...specific,
  ];
  const sl = [0x06, 1, 2];
  const es = [0x03, 3 + config.length + sl.length, 0, 1, 0, ...config, ...sl];
  return box("esds", [0, 0, 0, 0], es);
};

const moovOf = (samples: number, chunkOffsets: number[]): Uint8Array => {
  const sizes = Array.from({ length: samples }, (_, index) => u32(aacSampleSize(index))).flat();
  const mp4a = box(
    "mp4a",
    new Array(6).fill(0),
    u16(1),
    new Array(8).fill(0),
    u16(2),
    u16(16),
    u16(0),
    u16(0),
    u32(44100 << 16),
    esds()
  );
  const stbl = box(
    "stbl",
    box("stsd", [0, 0, 0, 0], u32(1), mp4a),
    box("stts", [0, 0, 0, 0], u32(1), u32(samples), u32(1024)),
    box("stsc", [0, 0, 0, 0], u32(1), u32(1), u32(SAMPLES_PER_CHUNK), u32(1)),
    box("stsz", [0, 0, 0, 0], u32(0), u32(samples), sizes),
    box("stco", [0, 0, 0, 0], u32(chunkOffsets.length), chunkOffsets.map(u32).flat())
  );
  const mdia = box(
    "mdia",
    box("mdhd", [0, 0, 0, 0], u32(0), u32(0), u32(44100), u32(samples * 1024), u16(0), u16(0)),
    box(
      "hdlr",
      [0, 0, 0, 0],
      u32(0),
      ascii("soun"),
      new Array(12).fill(0),
      ascii("SoundHandler"),
      [0]
    ),
    box("minf", stbl)
  );
  const udta = box("udta", box("meta", [0, 0, 0, 0], box("ilst", box("©nam", ascii(SECRET)))));
  return box("moov", box("trak", mdia), udta);
};

/**
 * `moovFirst` 对应「快速启动」布局；否则 moov 在文件尾，截取时要先跳过整个 mdat。
 * `gapBytes` 在每个音频块后面垫一段别的数据，模拟与其它轨交错存放的文件。
 */
export const buildMp4 = (samples: number, moovFirst: boolean, gapBytes = 0): Uint8Array => {
  const ftyp = box("ftyp", ascii("M4A "), u32(0), ascii("M4A mp42isom"));
  const chunkCount = Math.ceil(samples / SAMPLES_PER_CHUNK);
  const media = bytes(
    ...Array.from({ length: chunkCount }, (_, chunk) =>
      bytes(
        ...Array.from({ length: SAMPLES_PER_CHUNK }, (_, step) => chunk * SAMPLES_PER_CHUNK + step)
          .filter((index) => index < samples)
          .map((index) => indexPayload(index, aacSampleSize(index))),
        new Uint8Array(gapBytes)
      )
    )
  );
  const offsetsFrom = (mdatData: number) => {
    const offsets: number[] = [];
    let at = mdatData;
    for (let chunk = 0; chunk < chunkCount; chunk += 1) {
      offsets.push(at);
      for (let step = 0; step < SAMPLES_PER_CHUNK; step += 1) {
        const index = chunk * SAMPLES_PER_CHUNK + step;
        if (index < samples) at += aacSampleSize(index);
      }
      at += gapBytes;
    }
    return offsets;
  };
  const mdat = bytes(u32(media.length + 8), ascii("mdat"), media);
  if (!moovFirst) {
    const moov = moovOf(samples, offsetsFrom(ftyp.length + 8));
    return bytes(ftyp, mdat, moov);
  }
  const placeholder = moovOf(samples, offsetsFrom(0));
  const moov = moovOf(samples, offsetsFrom(ftyp.length + placeholder.length + 8));
  return bytes(ftyp, moov, mdat);
};

export interface RangeServerOptions {
  /** 无视 Range、回整个文件的上游。 */
  ignoreRange?: boolean;
}

/** 内存里的上游：按 Range 回 206，记录每次请求的区间。 */
export const rangeServer = (
  files: Record<string, Uint8Array>,
  options: RangeServerOptions = {}
) => {
  const requests: Array<{ url: string; range: string | null }> = [];
  const fetcher = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const range = new Headers(init?.headers).get("range");
    requests.push({ url, range });
    const data = files[url];
    if (!data) return new Response("missing", { status: 404 });
    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    if (!match || options.ignoreRange)
      return new Response(data.slice(), {
        status: 200,
        headers: { "content-length": String(data.length) },
      });
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), data.length - 1);
    if (start >= data.length) return new Response(null, { status: 416 });
    return new Response(data.slice(start, end + 1), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${data.length}` },
    });
  };
  return { fetcher, requests };
};

export const containsSecret = (data: Uint8Array): boolean => Buffer.from(data).includes("Secret");
