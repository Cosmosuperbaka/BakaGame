import { GAME_ROUTES } from "../shared/GameRoutes";
import type { GameId } from "../shared/Protocol";
import { SITE_NAME, SITE_PAGE_ENTRIES, lobbyTitleOf } from "../shared/SitePages";
/**
 * 人类可达的站点位置表：给 Agent 的「地图」。
 *
 * 这里只登记**导航事实**（路径、用途、可达条件），不复制页面内容——页面文案的真相源在
 * `Client/src`，服务端抄一份会立刻漂移。公开页的路径与短标题取自共享的站点页登记，
 * 与客户端页面元信息是同一份。`visit_page` 返回的是简短说明加真实链接，
 * Agent 据此决定下一步（进哪款游戏的大厅、去关于页的哪个 tab），而不是把页面抓下来解析。
 */
export interface SitePage {
  path: string;
  title: string;
  description: string;
  /** `public` 任何人都能打开；`room` 需要先进房（房间号形如 `/xxx/room/<roomId>`）。 */
  access: "public" | "room";
  /** 同页内可切换的标签（关于项目页用它）。 */
  tabs?: readonly string[];
}

export const SITE_PAGES: readonly SitePage[] = [
  {
    path: SITE_PAGE_ENTRIES.home.path,
    title: `${SITE_NAME} 首页`,
    description: "三款游戏入口、客户端下载、友情链接与版本信息。",
    access: "public",
  },
  {
    path: SITE_PAGE_ENTRIES.faker.path,
    title: lobbyTitleOf(SITE_PAGE_ENTRIES.faker.shortTitle),
    description:
      "语言推理游戏（至少 4 名参战玩家加 1 名出题人）的大厅：查看公开房间、创建房间、加入房间；房内可出题、发言、投票与夜间行动。",
    access: "public",
  },
  {
    path: SITE_PAGE_ENTRIES.song.path,
    title: lobbyTitleOf(SITE_PAGE_ENTRIES.song.shortTitle),
    description:
      "听歌识曲 / 听歌识番的大厅：查看公开房间、创建房间或加入房间；也可进入 /songuessr/solo 单人练习。",
    access: "public",
  },
  {
    path: "/songuessr/solo",
    title: "Songuessr 单人练习",
    description: "自动出题的单人房，不需要等待其他玩家，适合先熟悉玩法。",
    access: "public",
  },
  {
    path: SITE_PAGE_ENTRIES.cee.path,
    title: lobbyTitleOf(SITE_PAGE_ENTRIES.cee.shortTitle),
    description:
      "动漫角色线索推理的大厅：查看公开房间、创建原生房间或加入房间；支持组队、全局 BP 与渐进提示。",
    access: "public",
  },
  {
    path: SITE_PAGE_ENTRIES.abouts.path,
    title: "关于项目",
    description: "开源致谢、更新日志、提交历史、隐私说明与用户条款。",
    access: "public",
    tabs: ["credits", "changelog", "commits", "privacy", "terms"],
  },
  {
    path: "/status",
    title: "站点状态",
    description: "公开的可用性、当前房间与连接数量级、历史样本与事件。",
    access: "public",
  },
];

/** 游戏标识 → 人类页面路径：两者拼写不同（faker ↔ /whoisfaker），对齐只在玩法路由登记表里做一次。 */
export const gamePathOf = (game: GameId): string => GAME_ROUTES[game].base;

/** 加入房间后的页内位置；只在已经知道房间号时使用。 */
export const roomPageOf = (game: GameId, roomId: string): string =>
  `${gamePathOf(game)}/room/${roomId}`;

export const findSitePage = (path: string): SitePage | undefined => {
  const normalized = path.split("?")[0]?.replace(/\/+$/, "") || "/";
  return SITE_PAGES.find((page) => page.path === normalized);
};

/** 绝对地址：Agent 需要能把链接原样转给人类。 */
export const absolutePageUrl = (origin: string, page: SitePage, tab?: string): string => {
  const base = `${origin.replace(/\/+$/, "")}${page.path}`;
  return tab ? `${base}?tab=${encodeURIComponent(tab)}` : base;
};
