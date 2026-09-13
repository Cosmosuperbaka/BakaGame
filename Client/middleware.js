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
 * 变更这里之前请先读 Agents/Deployment.md「前后端同源化」一节。
 */

/** 后端公开域名。改这里等于切换该前端对应的后端。 */
const API_ORIGIN = "https://gameserver.baka.website";

export function middleware(context) {
  const { request, next, rewrite } = context;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return next();
  }

  // 只接管 /api/*，其余（首页、/assets/*、sitemap、robots）原样放行。
  if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
    return next();
  }

  // 拼接绝对地址。文档示例只演示过站内路径，跨域绝对地址是这里的关键假设，
  // 详见 Agents/Deployment.md 中记录的上线实测结论。
  return rewrite(API_ORIGIN + url.pathname + url.search);
}

export const config = {
  matcher: ["/api/:path*"],
};
