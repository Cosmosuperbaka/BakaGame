import { GAME_IDS, type GameId } from "./Protocol";
import { SITE_PAGE_ENTRIES } from "./SitePages";

/**
 * 三款玩法的页面路径登记：客户端路由、落地页入口与 Agent 白名单都从这里派生。
 *
 * 路径本体沿用站点页登记，这里只补「玩法」这一维——大厅基路径，以及大厅之外
 * 额外开放给 Agent 的子页。按 `GameId` 映射，少登记一款就是编译错误。
 */
export const GAME_ROUTES = {
  faker: { base: SITE_PAGE_ENTRIES.faker.path, agentPages: [] },
  song: {
    base: SITE_PAGE_ENTRIES.song.path,
    agentPages: [`${SITE_PAGE_ENTRIES.song.path}/solo`],
  },
  // 排位赛不进 Agent 白名单：口径见 AgentPages 的白名单说明。
  cee: { base: SITE_PAGE_ENTRIES.cee.path, agentPages: [] },
} as const satisfies Record<GameId, { base: `/${string}`; agentPages: readonly string[] }>;

const GAME_BASE_PATTERN = GAME_IDS.map((game) => GAME_ROUTES[game].base.slice(1)).join("|");
const ROOM_PATH_SOURCE = `/(?:${GAME_BASE_PATTERN})/room/([A-Za-z0-9_-]{2,32})`;

/** 房间页路径，房间号沿用三款游戏的既有形状。 */
export const GAME_ROOM_PATH = new RegExp(`^${ROOM_PATH_SOURCE}$`);

// 页面上报的路径可能带结尾斜杠（白名单归一化后放行），取房号时不锚定结尾。
const ROOM_ID_PATH = new RegExp(ROOM_PATH_SOURCE);

/** 路径归属哪款玩法：大厅本身与其子路径都算，站点页与相似前缀不算。 */
export const gameOfPath = (pathname: string): GameId | undefined =>
  GAME_IDS.find((game) => {
    const { base } = GAME_ROUTES[game];
    return pathname === base || pathname.startsWith(`${base}/`);
  });

export const roomIdOfPath = (pathname: string): string | undefined =>
  ROOM_ID_PATH.exec(pathname)?.[1];
