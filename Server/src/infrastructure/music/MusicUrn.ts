import { AppError } from "../../domain/Errors";
import type { MusicPlatform } from "./MusicProvider";

export interface ParsedSongUrn {
  platform: MusicPlatform;
  rawId: string;
}

/**
 * 严格解析歌曲 URN (统一资源标识).
 * 零向后兼容包袱：必须显式携带平台前缀 (如 netease:123 或 qq:0039MnYb0qxYhV).
 */
export function parseSongUrn(urn: string): ParsedSongUrn {
  const trimmed = urn?.trim() || "";
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx === -1) {
    throw new AppError(
      "INVALID_SONG_URN",
      `歌曲 ID 必须包含平台前缀 (如 netease:123 或 qq:0039MnYb0qxYhV)，收到: "${urn}"`
    );
  }

  const platformStr = trimmed.slice(0, colonIdx).toLowerCase();
  const rawId = trimmed.slice(colonIdx + 1).trim();

  if (platformStr !== "netease" && platformStr !== "qq") {
    throw new AppError(
      "INVALID_SONG_URN",
      `不支持的音源平台 "${platformStr}"，仅支持 netease 与 qq`
    );
  }
  if (!rawId) {
    throw new AppError("INVALID_SONG_URN", `歌曲原始 ID 不能为空: "${urn}"`);
  }

  return {
    platform: platformStr as MusicPlatform,
    rawId,
  };
}

/**
 * 构造统一歌曲 URN.
 */
export function buildSongUrn(platform: MusicPlatform, rawId: string): string {
  const trimmed = rawId?.toString().trim();
  if (!trimmed) {
    throw new AppError("INVALID_SONG_URN", `原始歌曲 ID 不能为空，平台: ${platform}`);
  }
  return `${platform}:${trimmed}`;
}

/** 补统一 URN 前缀：已带本平台前缀的原样返回（子 provider 的检索结果可能是裸标识，也可能已带前缀）。 */
export function withUrn(platform: MusicPlatform, id: string): string {
  return id.startsWith(`${platform}:`) ? id : buildSongUrn(platform, id);
}

/**
 * 歌曲条目补统一 URN：自身 ID 与翻唱指向的原曲 ID（`originSongId`）一起补。
 *
 * 子 provider 返回的原曲 ID 是平台裸标识；只补自身 ID 时，调用方拿原曲 ID 去回指原版
 * （`getSong`）会因为不是 URN 直接抛 `INVALID_SONG_URN`，判对时与 URN 形态的答案 ID
 * 也永远比不上。原曲 ID 与翻唱同属一个平台。
 */
export function withSongUrns<T extends { id: string; originSongId?: string }>(
  platform: MusicPlatform,
  song: T,
  rawId: string = song.id
): T {
  return {
    ...song,
    id: withUrn(platform, rawId),
    ...(song.originSongId ? { originSongId: withUrn(platform, song.originSongId) } : {}),
  };
}

/**
 * 判断是否为合法音源 URN.
 */
export function isSongUrn(urn: unknown): boolean {
  if (typeof urn !== "string") return false;
  return /^(netease|qq):.+$/i.test(urn.trim());
}
