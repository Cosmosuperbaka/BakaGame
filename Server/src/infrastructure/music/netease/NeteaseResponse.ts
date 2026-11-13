import { AppError } from "../../../domain/Errors";
import { asArray, asRecord, readNumber, readString } from "../../JsonReaders";
import { isCreditLyricLine } from "../lyrics/LyricCreditClassifier";
import type {
  SongEncyclopedia,
  SongSearchResult,
  SonGuessrMusicAccount,
  SonGuessrVipTier,
} from "../../../shared/Index";
import type { ApiResponse } from "./NeteaseTypes";

export const normalizeHttpsUrl = (value: unknown): string | undefined => {
  const raw = readString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    // 网易云接口仍可能返回 HTTP 图片或音频；HTTPS 页面会将其作为混合内容直接拦截或告警。
    if (url.protocol === "http:") url.protocol = "https:";
    return url.toString();
  } catch {
    return raw.startsWith("http://") ? `https://${raw.slice(7)}` : raw;
  }
};

export const normalizeAudioUrl = normalizeHttpsUrl;

export const responseBody = (response: ApiResponse): Record<string, unknown> => {
  const record = asRecord(response);
  return asRecord("body" in record ? record.body : response);
};

export const responseCookie = (response: ApiResponse): string | undefined => {
  const record = asRecord(response);
  const body = responseBody(response);
  const bodyCookie = readString(body.cookie);
  if (bodyCookie) return bodyCookie;
  const cookies = asArray(record.cookie)
    .map(readString)
    .filter((entry): entry is string => Boolean(entry));
  return cookies.length > 0 ? cookies.join(";") : undefined;
};

export const responseCode = (body: Record<string, unknown>): number | undefined => {
  const direct = readNumber(body.code);
  if (direct !== undefined) return direct;
  return readNumber(asRecord(body.data).code);
};

export const responseMessage = (body: Record<string, unknown>, fallback: string) =>
  readString(body.message ?? body.msg) ??
  readString(asRecord(body.data).message ?? asRecord(body.data).msg) ??
  fallback;

export const musicLoginError = (body: Record<string, unknown>, fallback: string) => {
  const code = responseCode(body);
  const risk = code === 8810 || code === 10004;
  return new AppError(
    risk ? "MUSIC_LOGIN_RISK" : "MUSIC_LOGIN_FAILED",
    risk ? "网易云已拦截当前网络环境的登录请求，请稍后重试" : responseMessage(body, fallback),
    { upstreamCode: code }
  );
};

export const readLoginAccount = (body: Record<string, unknown>): SonGuessrMusicAccount => {
  const data = asRecord(dataRecord(body));
  const profile = asRecord(body.profile ?? data.profile);
  const nickname = readString(profile.nickname) ?? "网易云用户";
  return {
    userId: readString(profile.userId ?? profile.id),
    nickname,
    avatarUrl: normalizeHttpsUrl(profile.avatarUrl ?? profile.avatar),
  };
};

const dataRecord = (body: Record<string, unknown>) => asRecord(body.data);

export const readVipAccount = (
  raw: unknown,
  account: SonGuessrMusicAccount,
  now = Date.now()
): SonGuessrMusicAccount => {
  const body = asRecord(raw);
  const data = asRecord(body.data ?? raw);
  const memberships = [
    asRecord(data.associator),
    asRecord(data.musicPackage),
    asRecord(data.redplus),
    asRecord(data.albumVip),
  ];
  const active = memberships.filter((membership) => {
    const code = readNumber(membership.vipCode ?? membership.vipType ?? membership.code) ?? 0;
    const expireTime = readNumber(membership.expireTime ?? membership.expire ?? membership.endTime);
    return code > 0 && (expireTime === undefined || expireTime > now);
  });
  const vipType = active
    .map((membership) => readNumber(membership.vipCode ?? membership.vipType ?? membership.code))
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => right - left)[0];
  const vipExpireTime = active
    .map((membership) =>
      readNumber(membership.expireTime ?? membership.expire ?? membership.endTime)
    )
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => right - left)[0];
  // 展示档位按网易云客户端的优先级取：超级黑胶 > 黑胶 > 音乐包，到期时间跟着这一档走。
  const tiers: Array<[SonGuessrVipTier, Record<string, unknown>]> = [
    ["svip", asRecord(data.redplus)],
    ["vip", asRecord(data.associator)],
    ["musicPackage", asRecord(data.musicPackage)],
  ];
  const shown = tiers.find(([, membership]) => active.includes(membership));
  const level = readNumber(data.redVipLevel);
  const tierFields: Partial<SonGuessrMusicAccount> = shown
    ? {
        vipTier: shown[0],
        vipExpireTime:
          readNumber(shown[1].expireTime ?? shown[1].expire ?? shown[1].endTime) ?? vipExpireTime,
        ...(shown[0] !== "musicPackage" &&
        level !== undefined &&
        Number.isInteger(level) &&
        level >= 1
          ? { vipLevel: Math.min(level, 7) }
          : {}),
      }
    : {};
  return {
    ...account,
    vipStatus: active.length > 0 ? "vip" : "nonVip",
    vipType,
    vipExpireTime,
    ...tierFields,
  };
};

export const artistNames = (song: Record<string, unknown>): string => {
  const artists = asArray(song.ar ?? song.artists ?? song.artist);
  const names = artists
    .map((entry) => readString(asRecord(entry).name) ?? readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return names.join(" / ") || "未知歌手";
};

export const normalizeSong = (value: unknown): SongSearchResult | undefined => {
  const song = asRecord(value);
  const id = readString(song.id);
  const title = readString(song.name ?? song.title);
  if (!id || !title) return undefined;

  const album = asRecord(song.al ?? song.album);
  const privilege = asRecord(song.privilege);
  const fee = readNumber(song.fee ?? privilege.fee);
  // 版本关系（1=原唱 / 2=翻唱）只有详情接口稳定返回，检索结果里通常缺席。
  // 必须原样带出去：它是「原版优先」排序在验证阶段唯一能用的硬信号。
  const originCover = asRecord(song.originSongSimpleData);
  return {
    id,
    title,
    artist: artistNames(song),
    album: readString(album.name),
    pictureUrl: normalizeHttpsUrl(album.picUrl ?? album.pic),
    durationMs: readNumber(song.dt ?? song.duration),
    requiresVip: fee === 1,
    originCoverType: readNumber(song.originCoverType),
    originSongId: readString(originCover.songId),
  };
};

export const readWiki = (raw: unknown): SongEncyclopedia & { language?: string } => {
  const tags = new Set<string>();
  const aliases = new Set<string>();
  let summary: string | undefined;
  let language: string | undefined;

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const record = asRecord(value);
    if (Object.keys(record).length === 0) return;

    const title = readString(record.title ?? record.name ?? record.key)?.toLowerCase();
    const content = readString(record.content ?? record.text ?? record.value);
    if (title && content) {
      if (title.includes("语种") || title.includes("语言") || title.includes("language")) {
        language = content;
      } else if (title.includes("别名") || title.includes("alias")) {
        content
          .split(/[、,，/]/)
          .map((item) => item.trim())
          .filter(Boolean)
          .forEach((item) => aliases.add(item));
      } else if (
        title.includes("曲风") ||
        title.includes("流派") ||
        title.includes("标签") ||
        title.includes("genre") ||
        title.includes("tag")
      ) {
        content
          .split(/[、,，/]/)
          .map((item) => item.trim())
          .filter(Boolean)
          .forEach((item) => tags.add(item));
      } else if (
        !summary &&
        (title.includes("简介") || title.includes("介绍") || title.includes("summary"))
      ) {
        summary = content;
      }
    }

    const metaList = asArray(record.wikiSubMetaVos ?? record.tags);
    metaList.forEach((entry) => {
      const text = readString(asRecord(entry).text ?? asRecord(entry).name ?? entry);
      if (text && !isCreditLyricLine(text)) tags.add(text);
    });

    Object.values(record).forEach(visit);
  };

  visit(raw);
  return {
    summary,
    aliases: aliases.size ? [...aliases] : undefined,
    tags: [...tags],
    language,
  };
};
