import { api, type ApiClient } from "@/lib/Api";

/**
 * 访问统计上报（见 Server/docs/Account.md「访问统计」）：每次载入页面与切换板块各报一次。
 * `visitorId` 是本机随机值，服务端按天加盐摘要后才落库；接口不可用（含账号系统未启用）时静默忽略。
 */
const VISITOR_KEY = "bakagame:visitor";

const randomVisitorId = (): string => {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function")
    crypto.getRandomValues(bytes);
  else
    for (let index = 0; index < bytes.length; index += 1)
      bytes[index] = Math.floor(Math.random() * 256);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export const visitorId = (): string => {
  try {
    const saved = window.localStorage.getItem(VISITOR_KEY);
    if (saved && /^[A-Za-z0-9_-]{16,64}$/.test(saved)) return saved;
    const created = randomVisitorId();
    window.localStorage.setItem(VISITOR_KEY, created);
    return created;
  } catch {
    // 存储被禁用：本次访问用临时 ID，统计上只是多算一名访客。
    return randomVisitorId();
  }
};

/** 板块：与服务端折叠口径一致，房号与子路径不单独计数。 */
export const visitSection = (pathname: string): string => {
  const [first = "", second = ""] = pathname.split("/").filter(Boolean);
  if (!first) return "/";
  return second === "room" || second === "solo" ? `/${first}/${second}` : `/${first}`;
};

export const reportVisit = (pathname: string, client: ApiClient = api): void => {
  client.site.visit({ visitorId: visitorId(), path: pathname.slice(0, 512) }).catch(() => {});
};
