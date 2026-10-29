import type { GameId } from "../shared/Protocol";
/**
 * 人类可达的站点位置表：给 Agent 的「地图」。
 *
 * 这里只登记**导航事实**（路径、用途、可达条件），不复制页面内容——页面文案的真相源在
 * `Client/src`，服务端抄一份会立刻漂移。`visit_page` 返回的是简短说明加真实链接，
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
    path: "/",
    title: "BakaGame 首页",
    description: "三款游戏入口、客户端下载、友情链接与版本信息；所有游戏免注册即点即玩。",
    access: "public",
  },
  {
    path: "/whoisfaker",
    title: "WhoisFaker 谁是卧底大厅",
    description:
      "语言推理游戏（4~16 人）的大厅：查看公开房间、创建房间、加入房间；房内可出题、发言、投票与夜间行动。",
    access: "public",
  },
  {
    path: "/songuessr",
    title: "Songuessr 猜歌大厅",
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
    path: "/cee",
    title: "CEE 猜角色大厅",
    description:
      "动漫角色线索推理的大厅：查看公开房间、创建原生房间或加入房间；支持组队、全局 BP 与渐进提示。",
    access: "public",
  },
  {
    path: "/abouts",
    title: "关于项目",
    description: "开源致谢、更新日志、提交历史、隐私说明与用户条款。",
    access: "public",
    tabs: ["credits", "changelog", "commits", "privacy", "terms"],
  },
  {
    path: "/status",
    title: "站点状态",
    description: "公开的可用性、在线房间与连接数量级、历史样本与事件。",
    access: "public",
  },
];

/** 游戏标识 → 人类页面路径：两者拼写不同（faker ↔ /whoisfaker），只在映射表里对齐一次。 */
export const GAME_PATHS = {
  faker: "/whoisfaker",
  song: "/songuessr",
  cee: "/cee",
} as const;

export const gamePathOf = (game: GameId): string => GAME_PATHS[game];

/** 加入房间后的页内位置；只在已经知道房间号时使用。 */
export const roomPageOf = (game: GameId, roomId: string): string =>
  `${GAME_PATHS[game]}/room/${roomId}`;

export const findSitePage = (path: string): SitePage | undefined => {
  const normalized = path.split("?")[0]?.replace(/\/+$/, "") || "/";
  return SITE_PAGES.find((page) => page.path === normalized);
};

/** 绝对地址：Agent 需要能把链接原样转给人类。 */
export const absolutePageUrl = (origin: string, page: SitePage, tab?: string): string => {
  const base = `${origin.replace(/\/+$/, "")}${page.path}`;
  return tab ? `${base}?tab=${encodeURIComponent(tab)}` : base;
};
