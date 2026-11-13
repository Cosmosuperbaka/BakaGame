import { Elysia } from "elysia";

import type { AppEnv } from "../../config/Env";
import type { ClientChannel } from "../../infrastructure/ClientChannel";
import type { EventLogger } from "../../infrastructure/EventLogger";
import { normalizeCEEEnvelope } from "../../shared/CEE";
import { ServerMessageSchema } from "../../shared/PacketSchemas";
import type { SiteFeatures } from "../../shared/SiteFeatures";
import { CEEClientMessageSchema } from "../CEEProtocol";
import type { GameEndpoint, GameEndpoints, GameMessage } from "../GameEndpoints";
import { assertModeOpen } from "../ModeGate";
import type { AccountDependencies } from "../routes/Account";
import { SonGuessrClientMessageSchema } from "../SonGuessrProtocol";
import { WhoIsFakerClientMessageSchema } from "../WhoIsFakerProtocol";
import type { WsHandshakeQuota } from "../WsHandshakeQuota";
import { connectionIdOf, openGameConnection, type GameSocketLike } from "./ConnectionRecord";
import type { CommandDeduplicator } from "./Dedup";
import { decodeGameFrame, gameSocketError } from "./FrameDiagnostics";
import { handleGameMessage } from "./GameMessage";
import {
  applyHandshakeGates,
  confirmHandshakeLease,
  releaseHandshakeLease,
  type GameUpgradeContext,
} from "./Handshake";

const closeGameConnection = async (
  ws: GameSocketLike,
  unregister: (connectionId: string) => Promise<void>
): Promise<void> => {
  const connectionId = connectionIdOf(ws);
  if (connectionId) await unregister(connectionId);
};

interface GameSocketHandlersOptions<TMessage extends GameMessage> {
  /** 日志前缀、建房闸门的判定与承载命令的服务都取自端点表。 */
  endpoint: GameEndpoint<TMessage>;
  /** 各模式入口的生效值；未提供时不拦建房。 */
  siteFeatures?: () => SiteFeatures;
  env: AppEnv;
  logger: EventLogger;
  account: AccountDependencies | undefined;
  handshakeQuota: WsHandshakeQuota;
  dedup: CommandDeduplicator;
  /** 仅 CEE：握手时把壳带来的 ticket 换成通道证明。 */
  clientChannel?: ClientChannel;
  /** 仅 CEE：上游信封归一。 */
  normalizeMessage?: (incoming: TMessage) => TMessage;
}

/**
 * 三款游戏 ws 路由共用的四件套 handler（upgrade/open/message/close）。
 * 握手闸门顺序（Agent 标记 → 配额 → 登录身份，CEE 额外换通道证明）是安全语义，
 * 工厂化是为了不再出现三份手抄副本各自漂移；body/response/parse/error 与 schema 强相关，
 * 留在各路由字面量里交给 Elysia 推断。
 */
const gameSocketHandlers = <TMessage extends GameMessage>({
  endpoint,
  siteFeatures,
  env,
  logger,
  account,
  handshakeQuota,
  dedup,
  clientChannel,
  normalizeMessage,
}: GameSocketHandlersOptions<TMessage>) => ({
  upgrade: (context: GameUpgradeContext) =>
    applyHandshakeGates(context, { env, logger, account, handshakeQuota, clientChannel }),
  open: (ws: GameSocketLike) => {
    confirmHandshakeLease(ws);
    openGameConnection(ws, (connection) => endpoint.service.registerConnection(connection));
  },
  message: (ws: GameSocketLike, incoming: TMessage) =>
    handleGameMessage(ws, normalizeMessage ? normalizeMessage(incoming) : incoming, dedup, {
      serviceName: endpoint.serviceName,
      execute: async (connectionId, message) => {
        assertModeOpen(endpoint, message, siteFeatures);
        return endpoint.service.execute(connectionId, message);
      },
    }),
  close: (ws: GameSocketLike) => {
    releaseHandshakeLease(ws);
    return closeGameConnection(ws, (connectionId) =>
      endpoint.service.unregisterConnection(connectionId)
    );
  },
});

export interface LegacySocketDependencies {
  env: AppEnv;
  logger: EventLogger;
  endpoints: GameEndpoints;
  account: AccountDependencies | undefined;
  handshakeQuota: WsHandshakeQuota;
  dedup: CommandDeduplicator;
  clientChannel?: ClientChannel;
  siteFeatures?: () => SiteFeatures;
}

/**
 * 旧入口：三款游戏各一条独立路径，只为已发布的桌面与移动壳、旧页面保留。
 * 移除条件与观测口径见 `Server/docs/Engineering.md` 的实时通道一节。
 */
export const legacyGameSocketRoutes = ({
  env,
  logger,
  endpoints,
  account,
  handshakeQuota,
  dedup,
  clientChannel,
  siteFeatures,
}: LegacySocketDependencies) =>
  new Elysia({ name: "legacy-game-sockets" })
    .ws("/api/whoisfaker/ws", {
      body: WhoIsFakerClientMessageSchema,
      response: ServerMessageSchema,
      parse: decodeGameFrame,
      error: gameSocketError(logger, endpoints.faker.serviceName, endpoints.faker.parse),
      ...gameSocketHandlers({
        endpoint: endpoints.faker,
        siteFeatures,
        env,
        logger,
        account,
        handshakeQuota,
        dedup,
      }),
    })
    .ws("/api/cee/ws", {
      body: CEEClientMessageSchema,
      response: ServerMessageSchema,
      parse: decodeGameFrame,
      error: gameSocketError(logger, endpoints.cee.serviceName, endpoints.cee.parse),
      ...gameSocketHandlers({
        endpoint: endpoints.cee,
        siteFeatures,
        env,
        logger,
        account,
        handshakeQuota,
        dedup,
        clientChannel,
        normalizeMessage: normalizeCEEEnvelope,
      }),
    })
    .ws("/api/songuessr/ws", {
      body: SonGuessrClientMessageSchema,
      response: ServerMessageSchema,
      parse: decodeGameFrame,
      error: gameSocketError(logger, endpoints.song.serviceName, endpoints.song.parse),
      ...gameSocketHandlers({
        endpoint: endpoints.song,
        siteFeatures,
        env,
        logger,
        account,
        handshakeQuota,
        dedup,
      }),
    });
