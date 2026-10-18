/**
 * HTTP 安全响应头。写在 `onRequest` 里而不是各路由自己加：
 * `set.headers` 会由全局 `mapResponse` 补到自建 `Response` 上（Better Auth、oRPC、头像与图床的字节流），
 * 一处登记就能覆盖全部出口，漏掉某条路由的风险比逐条加低得多。
 */

/** Swagger UI 需要内联脚本与外部资源，给不了 `default-src 'none'`；它只在 `/openapi` 及其子路径出现。 */
const DOCS_PATHS = ["/openapi"];

const STATIC_HEADERS: Record<string, string> = {
  // API 永不该被嵌进别人的框架；图床是浏览器可直接导航的图片，同样按最严格口径。
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  // 同源请求不带 Referer，避免把带房间号/用户号的查询串泄给第三方。
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin",
};

/**
 * HSTS 只在请求确实走了 TLS 时回：本机与容器里是明文 HTTP，由边缘终结 TLS，
 * 对明文连接发这个头浏览器会直接忽略，但写死成「永远发」会让未来的 http 内部域名踩坑。
 * 边缘与站点主域另有一份，这里取不带 `includeSubDomains` 的保守值，只覆盖后端自己的域。
 */
const HSTS_MAX_AGE_DIRECTIVES = "max-age=31536000";

const isHttps = (headers: Headers): boolean =>
  (headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? "") === "https";

const isDocsPath = (pathname: string): boolean =>
  pathname === "/openapi" || DOCS_PATHS.some((prefix) => pathname.startsWith(`${prefix}/`));

export const securityHeaders = (request: Request): Record<string, string> => {
  const { pathname } = new URL(request.url);
  // 文档页要跑 Swagger UI 的内联脚本与外部资源，给不了 `default-src 'none'`：
  // 只保留与「页面自身资源加载」无关的三条限制，其余收紧项照旧。
  const headers: Record<string, string> = isDocsPath(pathname)
    ? { ...STATIC_HEADERS, "content-security-policy": "frame-ancestors 'none'; base-uri 'none'; form-action 'none'" }
    : { ...STATIC_HEADERS };
  if (isHttps(request.headers)) headers["strict-transport-security"] = HSTS_MAX_AGE_DIRECTIVES;
  return headers;
};
