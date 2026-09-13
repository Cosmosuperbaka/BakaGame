import { DEFAULT_SERVER_URL } from "@/config/Constants";

/**
 * 解析后端请求基址。
 *
 * 生产环境的 `/api/*` 由 EdgeOne Makers 边缘中间件（`Client/middleware.js`）
 * 反代到后端域名，因此浏览器侧应当走**同源相对路径**，而不是跨域的后端域名：
 * 同源之后不再有 CORS 预检、不再依赖服务端 Origin 白名单，
 * WebSocket 升级阶段也不会因为 Origin 不匹配被 403。
 *
 * 本地开发时 Vite（5173）与 Bun（4850）分属不同端口，同源反代不存在，
 * 所以仍需通过 `VITE_SERVER_URL` 显式指定后端地址。
 *
 * 返回空串表示「使用同源相对路径」——这是生产环境的正常状态。
 */
export const resolveServerBase = (rawUrl?: string): string => {
  const value = rawUrl ?? import.meta.env.VITE_SERVER_URL;

  // 显式声明同源：交给浏览器按当前 origin 解析。
  if (value === "same-origin" || value === "/") return "";

  // 未配置时按环境区分：
  // 生产构建走同源（由边缘中间件转发），开发环境兜底到本地后端端口。
  if (!value) return import.meta.env.DEV ? DEFAULT_SERVER_URL : "";

  return value.replace(/\/+$/, "");
};

/**
 * 把基址与路径拼成可直接使用的 URL 字符串。
 *
 * 基址为空时返回相对路径（如 `/api/whoisfaker/ws`），浏览器会自动补全
 * 为当前页面的 origin —— 这正是同源化想要的效果。
 */
export const resolveServerUrl = (path: string, rawUrl?: string): string => {
  const base = resolveServerBase(rawUrl);
  return base ? base + path : path;
};
