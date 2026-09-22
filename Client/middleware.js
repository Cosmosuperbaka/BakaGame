/**
 * EdgeOne Makers 边缘中间件：把同源 `/api/*` 反代到后端域名。
 *
 * 目的：前端与后端分属不同域名时，所有请求都是跨域请求，需要 CORS 预检、
 * 服务端 Origin 白名单、以及 WebSocket 升级阶段的来源校验。把 `/api/*`
 * 收敛到前端域名后，浏览器侧全部变成同源请求，跨域问题从根上消失。
 *
 * 关键点：rewrite 的目标是后端的**公开域名**而不是源站 IP。
 * 后端域名本身已经套在 EdgeOne 加速层后面（响应头带 eo-cache-status），
 * 所以请求仍然经过 CDN，加速能力不受影响 —— 只是发起方从浏览器变成了边缘节点。
 *
 * 为什么这个文件必须存在（2026-09-21 全量审查实测）：
 * 曾一度改成「只在 Makers 控制台配置，仓库不含 middleware.js」，随后实测发现
 * 控制台那份也没生效 —— 主域名的 `/api/*`（含 WS 升级）全部被打回 SPA 兜底，
 * 返回的是 index.html 而不是后端 JSON，`/health` `/readyz` `/livez` 同样如此，
 * 于是健康检查永远「假通过」。兜底只影响这些路径，静态资源与页面不受影响。
 *
 * 变更这里之前请先读 Agents/Deployment.md「前后端同源化」一节。
 */

/** 后端公开域名。改这里等于切换该前端对应的后端。 */
const API_ORIGIN = "https://gameserver.baka.website";

/** 运维探针不在 `/api/` 前缀下，单独列出一并反代，否则外部健康检查拿到的永远是首页 HTML。 */
const OPS_PATHS = new Set(["/health", "/readyz", "/livez"]);

/** 是否应交给后端处理（导出以便单测覆盖路径判定）。 */
export function shouldProxyToBackend(pathname) {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    OPS_PATHS.has(pathname)
  );
}

export function middleware(context) {
  const { request, next, rewrite } = context;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return next();
  }

  // 只接管 /api/* 与三条运维探针，其余（首页、/assets/*、sitemap、robots）原样放行。
  if (!shouldProxyToBackend(url.pathname)) {
    return next();
  }

  // 拼接绝对地址。文档示例只演示过站内路径，跨域绝对地址是这里的关键假设，
  // 详见 Agents/Deployment.md 中记录的上线实测结论。
  return rewrite(API_ORIGIN + url.pathname + url.search);
}

export const config = {
  matcher: ["/api/:path*", "/health", "/readyz", "/livez"],
};
