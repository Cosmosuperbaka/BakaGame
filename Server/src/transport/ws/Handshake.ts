import { AppError } from "../../domain/Errors";
import type { AppEnv } from "../../config/Env";
import { describeError, type EventLogger } from "../../infrastructure/EventLogger";
import type { ClientChannel } from "../../infrastructure/ClientChannel";
import type { ClientChannelProof, PlayerAccount } from "../../shared/Index";
import { resolveClientIp } from "../ClientIp";
import type { AccountDependencies } from "../routes/Account";
import type { HandshakeLease, WsHandshakeQuota } from "../WsHandshakeQuota";
import type { GameSocketLike } from "./ConnectionRecord";

/**
 * RFC 6455 握手必需头：`Sec-WebSocket-Key` 是 16 字节随机数的 base64，版本只有 13。
 * 运行时对不合格的握手回 4xx 且不触发任何连接事件。
 */
const HANDSHAKE_KEY_PATTERN = /^[A-Za-z0-9+/]{22}==$/;
export const isValidHandshakeHeaders = (headers: Headers): boolean =>
  HANDSHAKE_KEY_PATTERN.test(headers.get("sec-websocket-key") ?? "") &&
  headers.get("sec-websocket-version") === "13";

/**
 * 握手阶段解析登录身份，结果挂到升级上下文上（Elysia 会把上下文展开进 `ws.data`）。
 * 账号系统故障只让本次连接以游客身份进入，绝不拦截游戏握手。
 */
const resolveSocketAccount = async (
  context: { request: Request; account?: PlayerAccount },
  account: AccountDependencies | undefined,
  logger: EventLogger
): Promise<void> => {
  if (!account || !context.request.headers.get("cookie")) return;
  try {
    context.account = await account.service.socketAccount(context.request.headers);
  } catch (error) {
    logger.warn("握手时解析登录状态失败，按游客处理", describeError(error));
  }
};

/**
 * 握手配额闸门：Origin 通过之后、真正接受连接之前占一个名额。
 *
 * 超限必须 **throw**（upgrade 钩子的返回值会被 Elysia 忽略）。
 * 抛 `RATE_LIMITED` 由全局错误钩子回 429；占位成功时把租约写进上下文，Elysia 会把它带进
 * `ws.data`：open 钩子确认、close 钩子归还；钩子之后升级若失败，租约到期自行归还。
 */
const reserveHandshakeSlot = (
  context: {
    request: Request;
    server?: { requestIP(request: Request): { address?: string } | null } | null;
    handshakeLease?: HandshakeLease;
    clientIp?: string;
  },
  quota: WsHandshakeQuota
): void => {
  const peerIp = context.server?.requestIP(context.request)?.address;
  const clientIp = resolveClientIp(context.request.headers, peerIp);
  const lease = quota.reserve(clientIp, peerIp ?? clientIp);
  if (!lease) throw new AppError("RATE_LIMITED", "连接过于频繁，请稍后重试");
  context.handshakeLease = lease;
  // 业务层的按地址配额要用同一个来源身份，不能到 application 层再反查 HTTP 头。
  context.clientIp = clientIp;
};

/**
 * 握手阶段把壳带来的 ticket 换成通道证明。
 *
 * 只有 CEE 入口调用：ticket 是一次性的，三个游戏都去消费会让先到的那个用掉它，
 * 而反作弊房只存在于 CEE。网页没有 ticket，`clientChannel` 即为空。
 */
const resolveSocketChannel = (
  context: { request: Request; clientIp?: string; clientChannel?: ClientChannelProof },
  channel: ClientChannel | undefined
): void => {
  if (!channel) return;
  const ticket = new URL(context.request.url).searchParams.get("ticket") ?? undefined;
  const proof = channel.consume(ticket, context.clientIp ?? "");
  if (proof) context.clientChannel = proof;
};

/**
 * Agent 身份标记：独立的 MCP server 在握手 URL 上带 `agent=1`（或用同名请求头）。
 * 这只是一个自报标记，不能防住人类伪装；它的用途是让房间设置能拒绝 Agent，并让界面明示。
 */
export const resolveAgentIdentity = (
  context: { request: Request; isAgent?: boolean },
  mcpEnabled?: boolean
): void => {
  const requested =
    context.request.headers.get("x-bakagame-agent") === "1" ||
    new URL(context.request.url).searchParams.get("agent") === "1";
  if (!requested) return;
  if (!mcpEnabled) throw new AppError("AGENTS_DISABLED", "Agent 接入未启用");
  context.isAgent = true;
};

/** 连接打开即确认租约：此后名额只由 close 归还。 */
export const confirmHandshakeLease = (ws: GameSocketLike): void => {
  (ws.data as { handshakeLease?: HandshakeLease }).handshakeLease?.confirm();
};

/** 连接断开必须归还握手名额，否则同一个来源地址的名额会被历史连接吃光。 */
export const releaseHandshakeLease = (ws: GameSocketLike): void => {
  (ws.data as { handshakeLease?: HandshakeLease }).handshakeLease?.release();
};

/** 三款游戏 ws 握手上下文的公共形状；Elysia 会把这里的字段展开进 `ws.data`。 */
export type GameUpgradeContext = {
  request: Request;
  headers: unknown;
  server?: { requestIP(request: Request): { address?: string } | null } | null;
  account?: PlayerAccount;
  isAgent?: boolean;
  handshakeLease?: HandshakeLease;
  clientIp?: string;
  clientChannel?: ClientChannelProof;
};

/**
 * 握手闸门：Agent 标记 → 配额 → 登录身份，CEE 额外换通道证明；Origin 与停机闸在全局 onRequest 统一判定。
 * 顺序是安全语义（拒绝不消耗配额、身份先于业务），旧入口与统一入口必须逐字一致。
 */
export const applyHandshakeGates = async (
  context: GameUpgradeContext,
  {
    env,
    logger,
    account,
    handshakeQuota,
    clientChannel,
  }: {
    env: AppEnv;
    logger: EventLogger;
    account: AccountDependencies | undefined;
    handshakeQuota: WsHandshakeQuota;
    clientChannel?: ClientChannel;
  }
): Promise<void> => {
  resolveAgentIdentity(context, env.mcpEnabled);
  reserveHandshakeSlot(context, handshakeQuota);
  try {
    // 查库放在占位之后：被配额拒绝的握手不该先打一次数据库。
    await resolveSocketAccount(context, account, logger);
    if (clientChannel) resolveSocketChannel(context, clientChannel);
  } catch (error) {
    // 占位之后的步骤抛错，升级随之失败，open/close 都不会触发：当场归还。
    context.handshakeLease?.release();
    throw error;
  }
};
