import { createHash } from "node:crypto";
import type { MusicCookieInput } from "../MusicProvider";

export const extractQqCookie = (cookie?: MusicCookieInput): string | undefined => {
  if (typeof cookie === "string") return cookie;
  if (typeof cookie !== "object" || cookie === null) return undefined;
  const val = cookie.qq;
  return typeof val === "string" ? val : undefined;
};

/** 播放地址与登录态按 Cookie 指纹分键（原文不进缓存键），匿名请求共用同一桶。 */
export const audioCacheScope = (cookie?: string): string => {
  const value = cookie?.trim();
  if (!value) return "anonymous";
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
};
