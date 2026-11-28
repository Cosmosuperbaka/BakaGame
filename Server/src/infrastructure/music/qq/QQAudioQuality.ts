import qqmusic from "qqmusic-api-enhanced";
import { asArray, asRecord, readNumber } from "../../JsonReaders";
import type { SongAudioQuality } from "../../../shared/Index";

/**
 * QQ 音乐的一档音质：文件名前缀、扩展名与歌曲详情 `file` 里登记文件大小的位置。
 * `libraryType` 是接口包 `song_url` 认得的档位名；没有它的档位接口包不支持，按同样的入参
 * 自己拼文件名请求 `UrlGetVkey`。只收不加密的文件：加密档（mflac / mgg）浏览器解不了。
 * `RS02` 是试听片段的前缀，不在这里出现。
 */
export interface QqAudioFile {
  libraryType?: "128" | "320" | "flac";
  prefix: string;
  ext: string;
  size: (file: Record<string, unknown>, sizeNew: unknown[]) => number | undefined;
}

const sizeNewAt = (sizeNew: unknown[], index: number) => readNumber(sizeNew[index]);

/** QQ 音乐没有单列的 Hi-Res 与臻音全景声档，这两档按退路回到无损。 */
export const QQ_AUDIO_FILES: Partial<Record<SongAudioQuality, QqAudioFile>> = {
  standard: {
    libraryType: "128",
    prefix: "M500",
    ext: ".mp3",
    size: (f) => readNumber(f.size_128mp3),
  },
  higher: { prefix: "C600", ext: ".m4a", size: (f) => readNumber(f.size_192aac) },
  exhigh: {
    libraryType: "320",
    prefix: "M800",
    ext: ".mp3",
    size: (f) => readNumber(f.size_320mp3),
  },
  lossless: {
    libraryType: "flac",
    prefix: "F000",
    ext: ".flac",
    size: (f) => readNumber(f.size_flac),
  },
  /** 臻品音质 2.0 */
  effect: { prefix: "Q000", ext: ".flac", size: (_f, n) => sizeNewAt(n, 1) },
  /** 臻品全景声 5.1 */
  surround: { prefix: "Q001", ext: ".flac", size: (_f, n) => sizeNewAt(n, 2) },
  dolby: { prefix: "D004", ext: ".mp4", size: (f) => readNumber(f.size_dolby) },
  /** 臻品母带 */
  master: { prefix: "AI00", ext: ".flac", size: (_f, n) => sizeNewAt(n, 0) },
};

/**
 * 从歌曲详情的 `file` 读出这首歌有哪些档：大小为正才算有。详情里没有 `file` 时返回 undefined，
 * 表示「不知道」，调用方照常逐档去试，而不是当成一档都没有。
 */
export const readQqAudioQualities = (file: unknown): Set<SongAudioQuality> | undefined => {
  const record = asRecord(file);
  if (Object.keys(record).length === 0) return undefined;
  const sizeNew = asArray(record.size_new);
  const qualities = new Set<SongAudioQuality>();
  for (const [quality, entry] of Object.entries(QQ_AUDIO_FILES)) {
    const size = entry.size(record, sizeNew);
    if (size !== undefined && size > 0) qualities.add(quality as SongAudioQuality);
  }
  return qualities;
};

/**
 * 接口包不支持的档位：与接口包 `song_url` 相同的 `UrlGetVkey` 入参，只换文件名前缀与扩展名。
 * 原样返回上游响应，交给 `QQUpstream.callUpstream` 照常判定限流；地址用 `readQqVkeyUrl` 读。
 */
export const requestQqVkey = (mid: string, entry: QqAudioFile, cookie?: string) => {
  const cookieObj = qqmusic.cookieToJson(cookie);
  const uin = cookieObj.uin || cookieObj.qqmusic_uin || cookieObj.wxuin || cookieObj.musicid || "0";
  const guid = cookieObj.guid || qqmusic.getGuid();
  return qqmusic.request(
    "music.vkey.GetVkey",
    "UrlGetVkey",
    {
      filename: [`${entry.prefix}${mid}${mid}${entry.ext}`],
      guid,
      songmid: [mid],
      songtype: [0],
      uin: String(uin),
      loginflag: 1,
      platform: "20",
      ctx: 0,
    },
    { cookie, guid, platform: "web" }
  );
};

/** 读 `UrlGetVkey` 的直链；空串表示这一档拿不到（没权限或没有这个文件）。 */
export const readQqVkeyUrl = (response: unknown): string => {
  const body = asRecord(asRecord(response).body);
  const purl = asRecord(asArray(body.midurlinfo)[0]).purl;
  if (typeof purl !== "string" || !purl || purl.includes("RS02")) return "";
  const sip = asArray(body.sip)[0];
  const domain = typeof sip === "string" && sip ? sip : "https://ws.stream.qqmusic.qq.com/";
  return `${domain.replace(/^http:\/\//i, "https://")}${purl}`;
};
