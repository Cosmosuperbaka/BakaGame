import { DEFAULT_SERVER_URL } from "@/config/Constants";

/**
 * 解析后端请求基址。
 *
 * 返回空串表示「使用同源相对路径」，由边缘把 `/api/*` 转发到后端；返回绝对地址
 * 表示浏览器跨域直连后端，由后端以 Origin 白名单 + CORS 回应。当前生产取哪一侧由
 * 构建注入的 `VITE_SERVER_URL` 决定（见 CI 的构建步骤），不在这里写死。
 *
 * 切换口径的前提是完整链路验证：WebSocket 要在目标环境跑通「握手 → 命令 → ACK」，
 * 只拿到 101 或 HTTP 200 都不算数——同源口径下没被转发的 `/api/*` 会退回 SPA 的
 * HTML，表现为另一种故障。约束见 `Agents/Deployment.md`。
 *
 * 本地开发时前端与后端分属不同端口，需要显式指定后端地址。
 */
export const resolveServerBase = (rawUrl?: string): string => {
  const value = rawUrl ?? import.meta.env.VITE_SERVER_URL;

  // 显式声明同源：交给浏览器按当前 origin 解析。
  if (value === "same-origin" || value === "/") return "";

  // 未配置时按环境区分：开发兜底到本地后端，生产留空即走同源。
  if (!value) return import.meta.env.DEV ? DEFAULT_SERVER_URL : "";

  return value.replace(/\/+$/, "");
};

/**
 * 把基址与路径拼成可直接使用的 URL 字符串。
 *
 * 基址为空时返回相对路径，浏览器会自动补全为当前页面的 origin。
 */
export const resolveServerUrl = (path: string, rawUrl?: string): string => {
  const base = resolveServerBase(rawUrl);
  return base ? base + path : path;
};
