import type { AppEnv } from "../../config/Env";
import { AppError, isAppError } from "../../domain/Errors";
import type { ClientChannel } from "../../infrastructure/ClientChannel";
import { describeError, type EventLogger } from "../../infrastructure/EventLogger";
import { isRecord } from "../../shared/Json";
import type { GameId } from "../../shared/Protocol";
import type { SiteFeatures } from "../../shared/SiteFeatures";
import {
  gameOfMessage,
  type GameEndpoint,
  type GameEndpoints,
  type GameMessage,
} from "../GameEndpoints";
import { assertModeOpen } from "../ModeGate";
import { createErrorPacket } from "../Packets";
import type { AccountDependencies } from "../routes/Account";
import type { SitePages } from "../SitePages";
import type { SitePresence } from "../SitePresence";
import type { TabSessions } from "../TabSessions";
import type { WsHandshakeQuota } from "../WsHandshakeQuota";
import {
  connectionIdFor,
  connectionIdOf,
  createConnectionRecord,
  sendPacket,
  type GameSocketLike,
} from "./ConnectionRecord";
import type { CommandDeduplicator } from "./Dedup";
import { describeRawMessage, salvageMessageIdentity } from "./FrameDiagnostics";
import { handleGameMessage } from "./GameMessage";
import {
  applyHandshakeGates,
  confirmHandshakeLease,
  releaseHandshakeLease,
  type GameUpgradeContext,
} from "./Handshake";
import type { createSiteChannel } from "./SiteChannel";

export interface UnifiedSocketDependencies {
  env: AppEnv;
  logger: EventLogger;
  endpoints: GameEndpoints;
  account: AccountDependencies | undefined;
  handshakeQuota: WsHandshakeQuota;
  clientChannel?: ClientChannel;
  siteFeatures?: () => SiteFeatures;
  dedup: CommandDeduplicator;
  sitePresence: SitePresence;
  sitePages: SitePages;
  tabSessions: TabSessions;
  siteChannel: ReturnType<typeof createSiteChannel>;
}

/** 统一实时入口（`/api/ws`）的四个钩子：握手闸门、站点通道与三款游戏按命令前缀分发、连接生命周期。 */
export const createUnifiedSocketHandlers = ({
  env,
  logger,
  endpoints,
  account,
  handshakeQuota,
  clientChannel,
  siteFeatures,
  dedup,
  sitePresence,
  sitePages,
  tabSessions,
  siteChannel,
}: UnifiedSocketDependencies) => {
  const { handleTabSessionCommand, handleSiteCommand } = siteChannel;
  /**
   * 统一入口按需把连接登记进对应游戏的服务。
   *
   * 一条物理连接可能先后用到三款游戏（MCP 就是这样），但绝不能一次性登记进三个服务：
   * 在线连接数按服务各自统计，全部登记会让一条连接被数三次，而且没碰过的游戏里会留下
   * 一条永远不订阅、不进房的影子记录。登记只发生在该游戏的第一条命令到来时。
   */
  const ensureGameConnection = (ws: GameSocketLike, game: GameId): void => {
    const data = ws.data as { registeredGames?: Set<GameId> };
    const registered = (data.registeredGames ??= new Set<GameId>());
    if (registered.has(game)) return;
    registered.add(game);
    const record = createConnectionRecord(ws, connectionIdFor(ws), (tabKey) =>
      sitePages.isTabControlled(tabKey)
    );
    endpoints[game].service.registerConnection(record);
  };

  /**
   * 解析、幂等执行并回执一条游戏命令。三款的命令类型不同，所以经泛型函数落到单个端点上，
   * 而不是把三个端点放进同一个数组丢掉各自的类型。
   */
  const runOn = <TMessage extends GameMessage>(
    ws: GameSocketLike,
    endpoint: GameEndpoint<TMessage>,
    incoming: unknown
  ): Promise<void> =>
    handleGameMessage(ws, endpoint.parse(incoming), dedup, {
      serviceName: endpoint.serviceName,
      execute: async (connectionId, message) => {
        assertModeOpen(endpoint, message, siteFeatures);
        return endpoint.service.execute(connectionId, message);
      },
    });

  /**
   * 统一入口的消息分发：站点命令 → 判定游戏 → 该游戏的严格解析 → 交给对应服务执行。
   *
   * 解析必须在分发之后做：三张命令表的信封都拒绝未知字段，先统一校验会把 `game`
   * 与另外两款游戏的字段判成非法。错误回包沿用旧入口的形状（同上，带 traceId）。
   */
  const handleUnifiedMessage = async (ws: GameSocketLike, incoming: unknown): Promise<void> => {
    const identity = salvageMessageIdentity(incoming);
    const respondError = (code: string, text: string) =>
      sendPacket(
        ws,
        createErrorPacket(identity?.id ?? "unknown", code, text, undefined, identity?.traceId)
      );
    try {
      if (!isRecord(incoming) || typeof incoming.type !== "string")
        throw new AppError("INVALID_MESSAGE", "消息必须为 JSON 对象");
      if (await handleTabSessionCommand(ws, incoming)) return;
      if (handleSiteCommand(ws, incoming)) return;
      const game = gameOfMessage(incoming);
      ensureGameConnection(ws, game);
      // 按共有形状放宽：同一个端点的解析与执行仍成对使用，只是不在联合类型上重新推断。
      const endpoint: GameEndpoint<GameMessage> = endpoints[game];
      await runOn(ws, endpoint, incoming);
    } catch (error) {
      if (isAppError(error)) {
        // 只在解析类失败上补原始帧的形状诊断：业务拒绝已经有 code 与消息。
        if (error.code === "INVALID_MESSAGE" || error.code === "UNKNOWN_MESSAGE_TYPE")
          logger.warn("统一 WS 消息解析失败", {
            ...describeRawMessage(incoming),
            message: error.message,
          });
        respondError(error.code, error.message);
        return;
      }
      logger.error("统一 WS 内部异常", describeError(error));
      respondError("INTERNAL_ERROR", "服务器内部错误");
    }
  };

  const unifiedSocketHandlers = {
    upgrade: (context: GameUpgradeContext) =>
      applyHandshakeGates(context, { env, logger, account, handshakeQuota, clientChannel }),
    open: (ws: GameSocketLike) => {
      confirmHandshakeLease(ws);
      connectionIdFor(ws);
    },
    message: (ws: GameSocketLike, incoming: unknown) => handleUnifiedMessage(ws, incoming),
    close: async (ws: GameSocketLike) => {
      releaseHandshakeLease(ws);
      (ws.data as { socketClosed?: boolean }).socketClosed = true;
      const connectionId = connectionIdOf(ws);
      if (!connectionId) return;
      tabSessions.release(connectionId);
      sitePresence.unsubscribe(connectionId);
      // 配对码随连接作废；已接管的租约按身份记账，等同一身份回来，超时才结束。
      sitePages.dropConnection(connectionId);
      const registered = (ws.data as { registeredGames?: Set<GameId> }).registeredGames;
      for (const game of registered ?? []) {
        try {
          await endpoints[game].service.unregisterConnection(connectionId);
        } catch (error) {
          logger.error("统一 WS 连接注销失败", { ...describeError(error), game, connectionId });
        }
      }
    },
  };

  return unifiedSocketHandlers;
};
