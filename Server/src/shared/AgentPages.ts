/**
 * 标签页接管的页面边界，两端同一份：服务端拦 `navigate`，页面在读取与点击时再拦一次。
 *
 * 这是白名单而不是黑名单：新增页面默认 Agent 到不了，登记后才开放。
 * 管理后台、排位赛入口与账号相关页面都不在表里。
 */
export const AGENT_PAGE_PATHS = [
  "/",
  "/whoisfaker",
  "/songuessr",
  "/songuessr/solo",
  "/cee",
  "/abouts",
  "/status",
] as const;

const AGENT_PAGES: ReadonlySet<string> = new Set(AGENT_PAGE_PATHS);

/** 房间页路径，房间号沿用三款游戏的既有形状。 */
const AGENT_ROOM_PATH = /^\/(?:whoisfaker|songuessr|cee)\/room\/[A-Za-z0-9_-]{2,32}$/;

export const isAgentPagePath = (path: string): boolean => {
  const normalized = path.split(/[?#]/)[0]?.replace(/\/+$/, "") || "/";
  return AGENT_PAGES.has(normalized) || AGENT_ROOM_PATH.test(normalized);
};

/** 页面能执行的动作：`read` 读当前画面，其余都落在真实控件上。 */
export const SITE_PAGE_ACTIONS = [
  "read",
  "navigate",
  "click",
  "focus",
  "type",
  "press",
  "select",
  "scroll",
] as const;

export type SitePageAction = (typeof SITE_PAGE_ACTIONS)[number];

/** `press` 可用的按键：只有完成界面操作需要的键，不开放组合键。 */
export const SITE_PAGE_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
] as const;

export type SitePageKey = (typeof SITE_PAGE_KEYS)[number];

export const SITE_PAGE_SCROLLS = ["up", "down", "top", "bottom"] as const;

export type SitePageScroll = (typeof SITE_PAGE_SCROLLS)[number];

/**
 * 接管结束的原因，页面据此告诉人类发生了什么：
 * `released` Agent 主动交还，`agent_left` Agent 会话断开，`expired` 长时间没有动作。
 */
export const SITE_PAGE_END_REASONS = ["released", "agent_left", "expired"] as const;

export type SitePageEndReason = (typeof SITE_PAGE_END_REASONS)[number];

/** 刷新续接的等待上限：页面重新连上并认回身份要在这之内。两端共用，页面据此判断接管是否已断。 */
export const PAGE_REATTACH_GRACE_MS = 20_000;
