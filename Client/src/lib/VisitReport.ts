import { api, type ApiClient } from "@/lib/Api";
import { localStore } from "@/lib/SafeStorage";

/**
 * 访问统计上报（见 Server/docs/Account.md「访问统计」）：每次载入页面与切换板块各报一次。
 * `visitorId` 是本机随机值，服务端按天加盐摘要后才落库；接口不可用（含账号系统未启用）时静默忽略。
 */
const VISITOR_KEY = "bakagame:visitor";

const randomVisitorId = (): string => {
  // `getRandomValues` 在非安全上下文同样可用（不同于 `randomUUID`），无需降级分支。
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

export const visitorId = (): string => {
  const saved = localStore.get(VISITOR_KEY);
  if (saved && /^[A-Za-z0-9_-]{16,64}$/.test(saved)) return saved;
  // 存储被禁用时写不进去，本次访问用临时 ID，统计上只是多算一名访客。
  const created = randomVisitorId();
  localStore.set(VISITOR_KEY, created);
  return created;
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
