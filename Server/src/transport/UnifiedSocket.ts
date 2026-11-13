import type { GameId } from "../shared/Protocol";

/** 统一实时入口：三款游戏与站点通道共用一条升级路径。 */
export const UNIFIED_WS_PATH = "/api/ws";

/** 旧入口：仍由同一个 `gameSocketHandlers` 提供，供已发布的桌面/移动壳与旧页面继续连接。 */
export const LEGACY_WS_PATHS: Readonly<Record<GameId, string>> = {
  faker: "/api/whoisfaker/ws",
  song: "/api/songuessr/ws",
  cee: "/api/cee/ws",
};
