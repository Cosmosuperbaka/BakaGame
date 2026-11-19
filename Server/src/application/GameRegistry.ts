import { GAME_IDS, type GameId } from "../shared/Protocol";
import type { CEEService } from "./CEEService";
import type { GameService } from "./GameService";
import type { SonGuessrService } from "./SonGuessrService";
import type { WhoIsFakerService } from "./WhoIsFakerService";

/** 每款游戏的服务类型；新增一款时这里漏登记，下面的映射类型就无法成立。 */
interface GameServiceTypes {
  faker: WhoIsFakerService;
  song: SonGuessrService;
  cee: CEEService;
}

/**
 * 组合根产出的三款游戏服务。键就是三个具名位置，没有哪一款是宿主（Spec 5）；
 * 按 `GameId` 映射，是为了让「对每一款做同一件事」的调用方少一处登记就是编译错误。
 */
export type GameServices = { readonly [G in GameId]: GameServiceTypes[G] };

/**
 * 对每一款游戏做同一件事，按 `GAME_IDS` 的顺序逐款访问并收集返回值。
 *
 * 访问函数只拿到三款共有的公共形状：需要某一款专有能力的调用方继续用具名位置取用。
 * 访问函数同步抛错会中断后面的款，和手写三行等价；要逐款隔离的调用方在函数体内自己 try。
 */
export const eachGame = <T>(
  services: GameServices,
  visit: (game: GameId, service: GameService<never>) => T
): T[] => GAME_IDS.map((game) => visit(game, services[game]));
