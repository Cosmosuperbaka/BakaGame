import { DEFAULT_SERVER_URL } from "@/config/Constants";

/**
 * 解析后端请求基址。
 *
 * 设计目标是让浏览器侧走**同源相对路径**，由边缘把 `/api/*` 反代到后端域名。
 * 但同源反代当前**没有启用**：`Client/middleware.js` 因无法转发 WebSocket 请求
 * 已被撤销（握手能拿到 101，数据帧过不去），详见 `Agents/Deployment.md`。
 *
 * 因此**生产现在必须回落到后端公开域名做跨域直连**，由后端以 Origin 白名单 +
 * CORS 回应。只有在确认边缘反代真的能转发 WebSocket 之后，才可以把基址切回同源；
 * 切早了前端会请求落到被打回 HTML 的同源路径，游戏直接不可用。
 *
 * 本地开发时 Vite（5173）与 Bun（4850）分属不同端口，同样需要显式指定后端地址。
 *
 * 返回空串表示「使用同源相对路径」——仅在反代确认可用时才是生产环境的正常状态。
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
