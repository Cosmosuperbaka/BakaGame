import { GAME_IDS, isGameId, type GameId } from "../shared/Protocol";

/** 统一实时入口：三款游戏与站点通道共用一条升级路径。 */
export const UNIFIED_WS_PATH = "/api/ws";

/** 旧入口：仍由同一个 `gameSocketHandlers` 提供，供已发布的桌面/移动壳与旧页面继续连接。 */
export const LEGACY_WS_PATHS: Readonly<Record<GameId, string>> = {
  faker: "/api/whoisfaker/ws",
  song: "/api/songuessr/ws",
  cee: "/api/cee/ws",
};

/**
 * 这条命令属于哪款游戏。
 *
 * 优先读信封上的 `game`：`mcp.focus` / `mcp.claim` / `mcp.release` 三款游戏同名，
 * 靠类型名推不出来。其余命令按各自的前缀推断——歌与角色游戏的整张命令表都带
 * `song.` / `cee.` 前缀，卧底的反过来一条都不带，所以兜底给卧底是唯一无歧义的选择。
 */
export const gameOfMessage = (message: unknown): GameId => {
  if (message && typeof message === "object") {
    const record = message as { game?: unknown; type?: unknown };
    if (isGameId(record.game)) return record.game;
    if (typeof record.type === "string") {
      if (record.type.startsWith("song.")) return "song";
      if (record.type.startsWith("cee.")) return "cee";
    }
  }
  return GAME_IDS[0];
};
