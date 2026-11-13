import { asArray, asRecord } from "../../JsonReaders";
import { buildSongUrn } from "../MusicUrn";
import type { SongSearchResult } from "../../../shared/SonGuessr";

// QQ 音乐上游返回的是未标注类型的 JSON：通用窄化助手取自 JsonReaders（与网易云
// 同一套约定）；`readString` 留在本地——它不 trim、不接受数字，与通用版语义不同，
// 音频直链与 Cookie 判定依赖这一差异。不引入 any。

export const stripHtmlTags = (val: unknown): string => {
  if (typeof val !== "string") return "";
  return val.replace(/<[^>]+>/g, "").trim();
};

/** 按顺序取第一个对象；用于 `data.body / body / data / 顶层` 这类历史形状兜底链。 */
export const firstRecord = (...values: unknown[]): Record<string, unknown> => {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  }
  return {};
};

/** 列表字段有时直接是数组，有时包一层 `{ items: [...] }`；非对象项归一成空记录。 */
export const readRecords = (value: unknown): Record<string, unknown>[] => {
  const list = Array.isArray(value) ? value : asArray(asRecord(value).items);
  return list.map((entry) => asRecord(entry));
};

export const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/** 取标量字段并转文本（上游 mid 只可能是字符串或数字）；对象与空值按缺失处理。 */
export const readText = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
};

/**
 * 是否必须会员账号才能在线播放。
 *
 * `pay_down` 只约束下载，计入播放门槛会把 `pay_play=0` 的可播曲误标成会员专享；
 * `time_free=1` 是限时免费，此时即使 `pay_play=1` 也先放行，交给真实音频判定兜底。
 */
const requiresVipAccount = (pay: Record<string, unknown>): boolean =>
  Number(pay.pay_play) === 1 && Number(pay.time_free) !== 1;

/** 歌手字段是对象数组（`name` / `title` 两种键），也见过裸字符串。 */
const singerNames = (value: unknown): string[] => {
  if (typeof value === "string") return [stripHtmlTags(value)];
  return asArray(value).map((singer) => {
    const record = asRecord(singer);
    return stripHtmlTags(record.name || record.title);
  });
};

/** QQ 音乐专辑封面的固定 CDN 路径按 albumId 取模分桶。 */
const albumPictureUrl = (albumId: number): string | undefined =>
  albumId
    ? `https://imgcache.qq.com/music/photo/album_500/${albumId % 100}/500_albumpic_${albumId}_0.jpg`
    : undefined;

/**
 * 从 XML 包裹的 QRC 中剥出 `LyricContent` 属性值；已是裸格式则原样返回。
 *
 * 属性值里的 `\n` 是字面量转义（XML 属性不能含真实换行），需还原成真实换行，
 * 否则所有行会被拼成一行。
 *
 * 必须「提取属性值」而非「剔除标签」：剥离标签的正则会把开标签、结尾自闭合
 * 与两者之间的整段歌词一并吃掉，结果为空。
 */
export const extractQrcPayload = (raw: string): string => {
  const attr = /LyricContent="([\s\S]*?)"/.exec(raw);
  const payload = attr ? attr[1] : raw;
  return payload.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
};

/** 各上游形状里取出的歌曲原始字段：形状差异留在读取函数里，归一与映射只此一份。 */
export interface QqSongFields {
  mid: string;
  rawTitle: unknown;
  singer: unknown;
  rawAlbum: unknown;
  albumId: number;
  intervalSec: unknown;
  /** 支付标记；缺省表示该形状不带会员信息，结果里不出现 requiresVip。 */
  pay?: Record<string, unknown>;
}

export const mapQqSong = (fields: QqSongFields): SongSearchResult => {
  const title = stripHtmlTags(fields.rawTitle);
  const artist = singerNames(fields.singer).filter(Boolean).join(" / ");
  const albumName = fields.rawAlbum ? stripHtmlTags(fields.rawAlbum) || undefined : undefined;
  const durationMs = Number(fields.intervalSec || 0) * 1000;
  return {
    id: buildSongUrn("qq", fields.mid),
    title,
    artist: artist || "未知歌手",
    album: albumName,
    pictureUrl: albumPictureUrl(fields.albumId),
    durationMs: durationMs > 0 ? durationMs : undefined,
    ...(fields.pay ? { requiresVip: requiresVipAccount(fields.pay) } : {}),
  };
};

/** 检索结果条目（`body.songs` / `data.body.item_song` 两种形状归一后）。 */
export const normalizeSearchSong = (item: Record<string, unknown>): SongSearchResult => {
  const album = asRecord(item.album);
  return mapQqSong({
    mid: readText(item.mid || item.songmid),
    rawTitle: readText(item.title || item.name || item.songname),
    singer: item.singer,
    rawAlbum: album.name || album.title || item.albumname || undefined,
    albumId: Number(album.id || item.albumid),
    intervalSec: item.interval,
    pay: asRecord(item.pay),
  });
};

/** 歌单曲目条目（`songmid` / `songname` 老字段优先）。 */
export const normalizePlaylistSong = (
  item: Record<string, unknown>,
  mid: string
): SongSearchResult => {
  const album = asRecord(item.album);
  return mapQqSong({
    mid,
    rawTitle: readText(item.songname || item.name || item.title),
    singer: item.singer,
    rawAlbum: item.albumname || album.name || undefined,
    albumId: Number(item.albumid || album.id),
    intervalSec: item.interval,
    pay: asRecord(item.pay),
  });
};

/** 歌手曲目条目（歌曲信息嵌在 `songInfo` 里；该形状不带会员标记）。 */
export const normalizeArtistSong = (item: Record<string, unknown>): SongSearchResult => {
  const songInfo = asRecord(item.songInfo);
  const songInfoAlbum = asRecord(songInfo.album);
  const itemAlbum = asRecord(item.album);
  const singerValue = songInfo.singer || item.singer;
  return mapQqSong({
    mid: readText(songInfo.mid || item.mid),
    rawTitle: readText(songInfo.name || songInfo.title || item.name),
    singer: Array.isArray(singerValue) ? singerValue : undefined,
    rawAlbum: songInfoAlbum.name || itemAlbum.name || undefined,
    albumId: Number(songInfoAlbum.id || itemAlbum.id),
    intervalSec: songInfo.interval || item.interval,
  });
};
