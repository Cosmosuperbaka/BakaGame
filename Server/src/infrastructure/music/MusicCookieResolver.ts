import type { MusicCookieInput, MusicPlatform } from "./MusicProvider";

/**
 * 房间侧凭据 → 某个平台自己的凭据：组合包按平台取值，单平台凭据按特征拒绝互斥平台，
 * 避免把一个平台的登录态发给另一个平台。
 */
/** 组合凭据（JSON 形态）里按平台取值：非字符串一律视为未配置。 */
const pickPlatformCookieField = (
  fields: Partial<Record<MusicPlatform, unknown>>,
  platform?: MusicPlatform
): string | undefined => {
  const val = platform === "qq" ? fields.qq : fields.netease;
  return typeof val === "string" ? val : undefined;
};

/** 看起来是 `{ "netease": ..., "qq": ... }` 形态的组合凭据字符串。 */
const looksLikeCompositeCookie = (cookie: string): boolean =>
  cookie.startsWith("{") && (cookie.includes("netease") || cookie.includes("qq"));

/** 解析组合凭据字符串；不是 JSON 形态时返回 null，交由单平台凭据特征继续判定。 */
const parseCompositeCookie = (
  cookie: string,
  platform?: MusicPlatform
): string | undefined | null => {
  if (!looksLikeCompositeCookie(cookie)) return null;
  try {
    const obj = JSON.parse(cookie) as Partial<Record<MusicPlatform, unknown>>;
    return pickPlatformCookieField(obj, platform);
  } catch {
    /* 不是 JSON 形态的组合凭据，按单平台凭据特征继续判定 */
  }
  return null;
};

/**
 * 单平台特定凭据特征检查：避免将特定平台的凭据传递给互斥平台。
 *
 * 返回 true 表示这份凭据对目标平台无效。
 */
const isPlatformMismatchedCookie = (cookie: string, platform?: MusicPlatform): boolean => {
  if (platform === "qq") return cookie.includes("MUSIC_U") || cookie.includes("NMTID");
  if (platform === "netease") {
    return (
      cookie.includes("qm_keyst") || cookie.includes("musickey") || cookie.includes("qqmusic_key")
    );
  }
  return false;
};

const resolveStringCookie = (cookie: string, platform?: MusicPlatform): string | undefined => {
  const composite = parseCompositeCookie(cookie, platform);
  if (composite !== null) return composite;
  if (isPlatformMismatchedCookie(cookie, platform)) return undefined;
  return cookie;
};

export const resolvePlatformCookie = (
  cookie?: MusicCookieInput,
  platform?: MusicPlatform
): string | undefined => {
  if (!cookie) return undefined;
  if (typeof cookie === "object" && cookie !== null)
    return pickPlatformCookieField(cookie, platform);
  if (typeof cookie === "string") return resolveStringCookie(cookie, platform);
  return undefined;
};
