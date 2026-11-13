import type { GameServices } from "../application/GameRegistry";
import type { GameService } from "../application/GameService";
import type { CEEClientMessage } from "../shared/CEE";
import { GAME_IDS, isGameId, type GameId } from "../shared/Protocol";
import type { SiteFeatureKey } from "../shared/SiteFeatures";
import type { SonGuessrClientMessage } from "../shared/SonGuessr";
import { parseCEEMessage } from "./CEEProtocol";
import { parseSonGuessrMessage } from "./SonGuessrProtocol";
import { parseWhoIsFakerMessage, type WhoIsFakerClientMessage } from "./WhoIsFakerProtocol";

/** 三款命令表的信封共有的最小形状：幂等、回执与日志只依赖这三个字段。 */
export interface GameMessage {
  id: string;
  type: string;
  traceId?: string;
}

/** 每款游戏的命令类型；新增一款时这里漏登记，下面的映射类型就无法成立。 */
interface GameMessages {
  faker: WhoIsFakerClientMessage;
  song: SonGuessrClientMessage;
  cee: CEEClientMessage;
}

/**
 * 一款游戏在传输层的全部差异：除了服务本身，都是不依赖运行时实例的纯函数与常量，
 * 所以拆出来单独成表，路由归属与建房闸门的判定不必装配服务就能验证。
 */
export interface GameProtocol<TMessage extends GameMessage> {
  readonly game: GameId;
  /** 日志前缀。 */
  readonly serviceName: string;
  /** 本款的严格解析；CEE 的线路信封归一已经包含在里面。 */
  readonly parse: (raw: unknown) => TMessage;
  /**
   * 这条命令在命令类型上是否属于本款，只按前缀认领。
   * 卧底的命令一条前缀都没有，所以它不认领任何类型，是没人认领时的兜底（见 `gameOfMessage`）。
   */
  readonly ownsType: (type: string) => boolean;
  /**
   * 建房命令对应的模式开关键；不是建房命令返回 `undefined`。
   * 只拦建房：加入已有房间、断线重连和局内命令一律放行，关掉模式时正在玩的人能把这局打完。
   * 排位不经过这里，它的开关只管首页入口（见 `SiteFeatures`）。
   */
  readonly createMode: (message: { type: string; payload?: unknown }) => SiteFeatureKey | undefined;
}

/** 协议加上承载它的服务：统一入口与三条旧路径都从这里取用，不再各自手抄三叉。 */
export interface GameEndpoint<TMessage extends GameMessage> extends GameProtocol<TMessage> {
  readonly service: GameService<TMessage>;
}

/** 三款游戏的协议表，按 `GameId` 映射：少一款登记就是编译错误。 */
export const GAME_PROTOCOLS: { readonly [G in GameId]: GameProtocol<GameMessages[G]> } = {
  faker: {
    game: "faker",
    serviceName: "WhoIsFaker",
    parse: parseWhoIsFakerMessage,
    ownsType: () => false,
    createMode: (message) => (message.type === "room.create" ? "fakerEntry" : undefined),
  },
  song: {
    game: "song",
    serviceName: "SonGuessr",
    parse: parseSonGuessrMessage,
    ownsType: (type) => type.startsWith("song."),
    createMode: (message) => {
      if (message.type !== "song.room.create") return undefined;
      const solo = (message.payload as { solo?: unknown } | undefined)?.solo === true;
      return solo ? "songSoloEntry" : "songMultiplayerEntry";
    },
  },
  cee: {
    game: "cee",
    serviceName: "CEE",
    parse: parseCEEMessage,
    ownsType: (type) => type.startsWith("cee."),
    // 增强房与原版房共用一个开关：玩家在同一个大厅里看到的都是「多人模式」。
    createMode: (message) =>
      message.type === "cee.room.create" ? "ceeMultiplayerEntry" : undefined,
  },
};

export type GameEndpoints = { readonly [G in GameId]: GameEndpoint<GameMessages[G]> };

/** 把组合根产出的服务接到协议表上；三个键各写一次，是为了保住每款自己的消息类型。 */
export const createGameEndpoints = (services: GameServices): GameEndpoints => ({
  faker: { ...GAME_PROTOCOLS.faker, service: services.faker },
  song: { ...GAME_PROTOCOLS.song, service: services.song },
  cee: { ...GAME_PROTOCOLS.cee, service: services.cee },
});

/** 没有任何一款按前缀认领的命令归谁：卧底的整张命令表都不带前缀。 */
const FALLBACK_GAME: GameId = "faker";

/**
 * 这条命令属于哪款游戏。
 *
 * 优先读信封上的 `game`（三款同名的命令必须由调用方显式声明归属），其余按各款的前缀认领，
 * 没人认领则落到卧底：反过来让卧底认领、另两款兜底会有歧义，唯一无歧义的选择就是它。
 */
export const gameOfMessage = (message: unknown): GameId => {
  if (message && typeof message === "object") {
    const record = message as { game?: unknown; type?: unknown };
    if (isGameId(record.game)) return record.game;
    if (typeof record.type === "string") {
      for (const game of GAME_IDS) if (GAME_PROTOCOLS[game].ownsType(record.type)) return game;
    }
  }
  return FALLBACK_GAME;
};
