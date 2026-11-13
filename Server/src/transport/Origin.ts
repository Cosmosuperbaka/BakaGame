import { isPrivateLanHost } from "./routes/System";

/**
 * 内嵌壳（安卓 APK）的固定页面来源：壳把前端产物打包进 WebView，总是以
 * `https://localhost` 为 origin 直连公网后端（`Mobile/capacitor.config.ts`）。
 * 恒信理由：https 下的 localhost 页面必须持有本机受信证书，公网攻击者拿不到该 origin
 * （与「未配置白名单时只放行本机来源」口径一致）；且只认 https，`http://localhost:PORT`
 * 任意本机进程都能提供，不在此列。
 */
const EMBEDDED_APP_ORIGINS = new Set(["https://localhost"]);

export const isAllowedOrigin = (origin: string | null | undefined, clientUrl?: string): boolean => {
  if (!origin) return true;
  if (EMBEDDED_APP_ORIGINS.has(origin)) return true;
  // 没有配置白名单时不能「放行一切」——那是 CSWSH 的入口。
  // 此时退化为「只允许同属私网/本机的来源」，公网浏览器页面一律拒绝。
  if (!clientUrl) {
    try {
      return isPrivateLanHost(new URL(origin).hostname);
    } catch {
      return false;
    }
  }
  try {
    const originUrl = new URL(origin);
    const allowedUrls = clientUrl
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    for (const rawAllowed of allowedUrls) {
      try {
        const allowedUrl = new URL(rawAllowed);
        if (originUrl.origin === allowedUrl.origin) return true;
        if (isPrivateLanHost(originUrl.hostname) && isPrivateLanHost(allowedUrl.hostname)) {
          return true;
        }
      } catch {
        // 忽略单项解析异常
      }
    }
  } catch {
    return false;
  }
  return false;
};
