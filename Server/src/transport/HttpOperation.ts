/**
 * HTTP 操作名的维度来源。**不能**直接拼 inbound pathname：指标序列与 Sentry 事务名共享
 * 这个名字，扫描器与爬虫的随机路径会把基数推到无界，长尾噪声淹没真实慢请求。
 * 维度只取自已注册路由模板；模板匹配不到的请求统一归入固定桶，路径本身不进标签。
 */
export const UNROUTED_HTTP_ACTION = "HTTP * UNROUTED";

/**
 * 允许进入操作名的方法集合。ALL 模板对任意方法都能匹配，而真实路由分发只受理标准方法；
 * 不在表内的方法（`curl -X FOO` 之类）直接落固定桶，方法维度同样有界。
 */
const LOGGED_HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export interface RouteTemplate {
  method: string;
  path: string;
  segments: string[];
}

const splitPathSegments = (path: string): string[] => path.split("/").filter(Boolean);

/** 按 Elysia 的路由语义逐段匹配：`:param` 吃一个段，`*` 吞掉其余全部。 */
const matchesRouteSegments = (pattern: readonly string[], path: readonly string[]): boolean => {
  for (let index = 0; index < pattern.length; index += 1) {
    const segment = pattern[index];
    if (segment === "*") return true;
    if (index >= path.length) return false;
    if (!segment.startsWith(":") && segment !== path[index]) return false;
  }
  return pattern.length === path.length;
};

const routeMethodMatches = (routeMethod: string, method: string): boolean =>
  routeMethod === "ALL" ||
  routeMethod === method ||
  // Bun 用 GET 处理器同时兜住 HEAD；WS 升级在 HTTP 层就是 GET。
  (routeMethod === "GET" && method === "HEAD") ||
  (routeMethod === "WS" && method === "GET");

export const compileRouteTemplates = (
  routes: readonly { method: string; path: string }[]
): RouteTemplate[] =>
  routes.map((route) => ({
    method: route.method.toUpperCase(),
    path: route.path,
    segments: splitPathSegments(route.path),
  }));

/** 请求路径 → 操作名：命中模板则带上模板（真实参数值不进名字），否则落 `UNROUTED_HTTP_ACTION`。 */
export const httpOperationAction = (
  templates: readonly RouteTemplate[],
  method: string,
  pathname: string
): string => {
  if (!LOGGED_HTTP_METHODS.has(method)) return UNROUTED_HTTP_ACTION;
  const segments = splitPathSegments(pathname);
  for (const template of templates) {
    if (!routeMethodMatches(template.method, method)) continue;
    if (matchesRouteSegments(template.segments, segments)) return `HTTP ${method} ${template.path}`;
  }
  return UNROUTED_HTTP_ACTION;
};
