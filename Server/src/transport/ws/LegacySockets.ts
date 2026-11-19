import { Elysia } from "elysia";

import type { AppEnv } from "../../config/Env";
import type { ClientChannel } from "../../infrastructure/ClientChannel";
import type { EventLogger } from "../../infrastructure/EventLogger";
import { countServerMetric } from "../../infrastructure/Sentry";
import { normalizeCEEEnvelope } from "../../shared/CEE";
import type { SiteFeatures } from "../../shared/SiteFeatures";
import { CEEClientMessageSchema } from "../CEEProtocol";
import type { GameEndpoint, GameEndpoints, GameMessage } from "../GameEndpoints";
import { assertModeOpen } from "../ModeGate";
import { LEGACY_WS_PATHS } from "../UnifiedSocket";
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

/** 旧路径建连计数的指标名；移除条件见 Engineering 的实时通道一节。 */
const LEGACY_CONNECTION_METRIC = "bakagame.ws.legacy_path";

/**
 * 三款游戏 ws 路由共用的四件套 handler（upgrade/open/message/close）。
 * 握手闸门顺序（Agent 标记 → 配额 → 登录身份，CEE 额外换通道证明）是安全语义，
 * 工厂化是为了不再出现三份手抄副本各自漂移；body/parse/error 与 schema 强相关，
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
    // 旧路径还有多少连接是删除它的唯一证据：按路径各记一次，不带任何用户维度。
    countServerMetric(LEGACY_CONNECTION_METRIC, 1, { path: LEGACY_WS_PATHS[endpoint.game] });
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
  // 入站规范化与主应用同样关闭：消息体是联合类型，规范化库处理不了，只会在装配时告警；
  // 入站消息一律原样交给处理函数。
  new Elysia({ name: "legacy-game-sockets", normalize: false })
    .ws(LEGACY_WS_PATHS.faker, {
      body: WhoIsFakerClientMessageSchema,
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
    .ws(LEGACY_WS_PATHS.cee, {
      body: CEEClientMessageSchema,
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
    .ws(LEGACY_WS_PATHS.song, {
      body: SonGuessrClientMessageSchema,
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
