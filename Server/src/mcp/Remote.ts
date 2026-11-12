import { createHash } from "node:crypto";
import type { EventLogger } from "../infrastructure/EventLogger";
import { assertTextAllowed } from "../infrastructure/SensitiveText";
import { SlidingWindowRateLimiter } from "../infrastructure/RateLimiter";
import { FOCUS_AFTER_TOOLS, publishToolFocus } from "./Focus";
import { AgentGameClient } from "./GameClient";
import {
  DEFAULT_PROTOCOL_VERSION,
  MCP_INSTRUCTIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  protocolVersionOf,
} from "./Policy";
import { TOOLS, withRemoteSessionSchema, type PageControlPort } from "./Tools";
import { isRecord } from "../shared/Json";

const SERVER_INFO = { name: "bakagame-mcp", version: "1.0.0" };
const SESSION_IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 256;
/**
 * 同一来源最多同时持有的会话数。云端 Agent 平台从共享出口发起调用，一个「来源」背后
 * 可能是许多互不相识的用户，所以按全表的四分之一给：单个来源占不满全表，又不至于让
 * 同一平台的正常用户刚到几个人就被拒。
 */
const MAX_SESSIONS_PER_CLIENT = MAX_SESSIONS / 4;
/** 同来源满额时，只有闲置超过这么久的旧会话才可被新会话回收。 */
const RECYCLE_IDLE_MS = 2 * 60_000;
/**
 * 同一会话的工具调用串行执行：焦点、草稿、搜索与座位状态都挂在会话上，并行调用会互相踩踏，
 * 双发的 join 还会重复入房。等待与持有都有上限，一个挂起的调用不能永久堵死后续调用。
 */
const CALL_WAIT_MS = 30_000;
const CALL_HOLD_MAX_MS = 4 * 60_000;
const CALL_QUEUE_MAX = 8;
const WRITE_WINDOW_MS = 60_000;
const WRITE_MAX = 30;
/**
 * 同一来源跨会话的写操作额度。会话号由调用方决定、可随手新开，只按会话计数等于
 * 不设限：不带会话号的每次调用都会落进一个新会话、拿到一份新额度。
 */
const CLIENT_WRITE_MAX = WRITE_MAX * 16;

/**
 * 真正无状态的工具：不读房间也不上报活动，临时开一个客户端就返回。
 * 其余工具都绑定 Agent 会话——站点活动靠这条连接广播到首页，
 * 临开临关会让首页指示器闪一下就没。
 */
const EPHEMERAL_TOOLS = new Set(["get_mcp_policy"]);

const SESSIONS_FULL = "远程 MCP 会话已满，请稍后再试";

export interface RemoteSession {
  id: string;
  client: AgentGameClient;
  agentName: string;
  /** 建会话的来源（真实客户端 IP），用于按来源封顶会话数与写额度。 */
  clientKey: string;
  createdAt: number;
  lastUsedAt: number;
  writes: number[];
  /** 当前持有串行锁的调用结束（或被强制释放）后落定。 */
  tail: Promise<void>;
  queued: number;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/**
 * 会话号既是 Mcp-Session-Id 也是座位与页面租约的承载凭证，日志读者拿到它就能接管 Agent。
 * 日志里只留不可逆的短摘要，足够把同一会话的几条记录串起来。
 */
const refOf = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 8);

const sanitizeName = (value: unknown): string => {
  if (typeof value !== "string") return "BakaAgent";
  const trimmed = value.trim().slice(0, 24);
  // Agent 名字会作为玩家昵称和活动提示展示给其他玩家，与人类昵称同一口径。
  assertTextAllowed(trimmed);
  return trimmed || "BakaAgent";
};

export interface RemoteMcpSessionsOptions {
  /**
   * 服务端自己的回环地址：Agent 的游戏连接只能连它。目标必须来自服务端配置，
   * 请求的 Host 由调用方决定，拿来当出站目标等于让匿名请求指挥服务端去连任意主机。
   */
  selfUrl: string;
  /** 站点对外基址：只用来给 Agent 拼人类可达的页面链接，不参与任何出站连接。 */
  siteUrl: string;
  /** 串行锁的等待与持有上限；缺省取生产值，测试里压短。 */
  callWaitMs?: number;
  callHoldMaxMs?: number;
}

export class RemoteMcpSessions {
  private readonly sessions = new Map<string, RemoteSession>();
  private sessionClosed: (id: string) => void = () => undefined;
  private readonly clientWrites = new SlidingWindowRateLimiter({
    windowMs: WRITE_WINDOW_MS,
    maxRequests: CLIENT_WRITE_MAX,
  });

  constructor(
    private readonly logger: EventLogger,
    private readonly options: RemoteMcpSessionsOptions,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * 新建会话。全表或本来源已满时拒绝（返回 undefined），不挤掉正在用的会话：
   * 建会话不需要任何凭据，按全局最旧淘汰等于让匿名调用方把别人的 Agent 连同座位一起踢下线；
   * 同来源内也一样——共享出口背后的另一个用户同样是「别人」。只回收闲置够久、
   * 既无座位也无页面租约的旧会话：本来源的优先，全表满时再回收任何来源的，
   * 否则匿名方用少数来源占满全表后，其余人要等占位会话自然过期才能进来。
   */
  create(
    agentName: string,
    clientKey: string,
    pages?: Pick<PageControlPort, "isControlling">
  ): RemoteSession | undefined {
    this.prune();
    const own = [...this.sessions.values()]
      .filter((session) => session.clientKey === clientKey)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    if (own.length >= MAX_SESSIONS_PER_CLIENT) {
      const oldest = own[0]!;
      if (this.now() - oldest.lastUsedAt < RECYCLE_IDLE_MS) return undefined;
      this.close(oldest.id);
    }
    if (this.sessions.size >= MAX_SESSIONS && !this.recycleOneIdle(pages)) return undefined;
    const session: RemoteSession = {
      id: crypto.randomUUID(),
      client: new AgentGameClient({
        serverUrl: this.options.selfUrl,
        siteUrl: this.options.siteUrl,
        agentName,
      }),
      agentName,
      clientKey,
      createdAt: this.now(),
      lastUsedAt: this.now(),
      writes: [],
      tail: Promise.resolve(),
      queued: 0,
    };
    this.sessions.set(session.id, session);
    this.logger.info("mcp.remote.session", { session: refOf(session.id), agent: agentName });
    return session;
  }

  /** 全表满时回收一个最旧的可回收会话（闲置够久、无座位、无页面租约）；没有则返回 false。 */
  private recycleOneIdle(pages?: Pick<PageControlPort, "isControlling">): boolean {
    const now = this.now();
    let oldest: RemoteSession | undefined;
    for (const session of this.sessions.values()) {
      if (now - session.lastUsedAt < RECYCLE_IDLE_MS) continue;
      if (session.client.holdsSeat() || pages?.isControlling(session.id)) continue;
      if (!oldest || session.lastUsedAt < oldest.lastUsedAt) oldest = session;
    }
    if (!oldest) return false;
    this.close(oldest.id);
    return true;
  }

  /**
   * 按会话串行执行 `run`。前一个调用超过等待上限仍未结束就如实回 BUSY（由 `onBusy` 构造），
   * 不无限排队；持有方超过持有上限会被强制放行，后续调用不会被一个挂起的调用永久堵住。
   */
  async runExclusive<T>(session: RemoteSession, run: () => Promise<T>, onBusy: () => T): Promise<T> {
    if (session.queued >= CALL_QUEUE_MAX) return onBusy();
    session.queued += 1;
    const previous = session.tail;
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    session.tail = mine;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    const turn = await Promise.race([
      previous.then(() => true),
      new Promise<boolean>((resolve) => {
        waitTimer = setTimeout(() => resolve(false), this.options.callWaitMs ?? CALL_WAIT_MS);
      }),
    ]);
    clearTimeout(waitTimer);
    if (!turn) {
      // 没轮到：把自己的位置让回去，后面的调用只需等前面真正持有锁的那个。
      session.queued -= 1;
      void previous.then(release);
      return onBusy();
    }
    const holdTimer = setTimeout(release, this.options.callHoldMaxMs ?? CALL_HOLD_MAX_MS);
    try {
      return await run();
    } finally {
      clearTimeout(holdTimer);
      session.queued -= 1;
      release();
    }
  }

  /** 会话结束的回调：被它接管的标签页要立刻解锁，不能等租约到期。 */
  onSessionClosed(listener: (id: string) => void): void {
    this.sessionClosed = listener;
  }

  get(id: string): RemoteSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    session.lastUsedAt = this.now();
    return session;
  }

  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.dispose(session);
    return true;
  }

  closeAll(): void {
    for (const session of [...this.sessions.values()]) this.dispose(session);
  }

  private dispose(session: RemoteSession): void {
    session.client.close();
    this.sessions.delete(session.id);
    this.sessionClosed(session.id);
  }

  private prune(): void {
    const now = this.now();
    for (const session of [...this.sessions.values()])
      if (now - session.lastUsedAt > SESSION_IDLE_MS) this.dispose(session);
  }

  /** 写操作同时扣会话额度与来源额度；任一用完即拒。 */
  consumeWrite(session: RemoteSession): boolean {
    const now = this.now();
    session.writes = session.writes.filter((at) => now - at < WRITE_WINDOW_MS);
    if (session.writes.length >= WRITE_MAX) return false;
    if (!this.clientWrites.allow(session.clientKey, now)) return false;
    session.writes.push(now);
    return true;
  }
}

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

const toolResult = (text: string) => ({
  content: [{ type: "text", text }],
  isError: false,
});

const toolFailure = (text: string) => ({
  content: [{ type: "text", text }],
  isError: true,
});

export interface RemoteMcpHandlerOptions {
  enabled: boolean;
  sessions: RemoteMcpSessions;
  logger: EventLogger;
  /** 标签页接管端口；stdio 入口没有它，control_page 会明确拒绝。 */
  pages?: PageControlPort;
}

/**
 * 远程 MCP 的 JSON-RPC 核心；HTTP 路由只负责取 Origin、Session 头、来源 IP 与状态码。
 * `clientKey` 是调用方的真实来源（边缘写入的客户端 IP），会话数与写额度按它封顶。
 */
export async function handleRemoteMcp(
  options: RemoteMcpHandlerOptions,
  request: Request,
  body: unknown,
  clientKey: string
): Promise<{ status: number; headers: Record<string, string>; payload: unknown }> {
  const { enabled, sessions } = options;
  if (!enabled) {
    return {
      status: 503,
      headers: {},
      payload: rpcError(null, -32000, "MCP 接入未启用（MCP_ENABLED=false）"),
    };
  }
  if (!isRecord(body)) {
    return { status: 400, headers: {}, payload: rpcError(null, -32600, "无效请求") };
  }
  const message = body as JsonRpcRequest;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return { status: 400, headers: {}, payload: rpcError(message.id, -32600, "无效请求") };
  }
  const id = message.id;
  const params = isRecord(message.params) ? message.params : {};
  const headers: Record<string, string> = {};

  switch (message.method) {
    case "initialize": {
      const clientInfo = isRecord(params.clientInfo) ? params.clientInfo : {};
      const session = sessions.create(sanitizeName(clientInfo.name), clientKey, options.pages);
      if (!session) return { status: 503, headers, payload: rpcError(id, -32000, SESSIONS_FULL) };
      headers["mcp-session-id"] = session.id;
      return {
        status: 200,
        headers,
        payload: rpcResult(id, {
          protocolVersion: protocolVersionOf(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: MCP_INSTRUCTIONS,
        }),
      };
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return { status: 202, headers, payload: null };
    case "server/discover":
      return {
        status: 200,
        headers,
        payload: rpcResult(id, {
          protocolVersion: DEFAULT_PROTOCOL_VERSION,
          supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: MCP_INSTRUCTIONS,
        }),
      };
    case "ping":
      return { status: 200, headers, payload: rpcResult(id, {}) };
    case "tools/list":
      return {
        status: 200,
        headers,
        payload: rpcResult(id, {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema: withRemoteSessionSchema(inputSchema),
          })),
        }),
      };
    case "tools/call":
      if (id === undefined || id === null) return { status: 202, headers, payload: null };
      return handleRemoteToolCall(options, {
        clientKey,
        headerSessionId: request.headers.get("mcp-session-id")?.trim() || "",
        id,
        params,
        headers,
      });
    default:
      // 通知没有 id，规范要求不回任何响应；对它回错误响应会被合规客户端当成协议错误。
      if (id === undefined) return { status: 202, headers, payload: null };
      return {
        status: 200,
        headers,
        payload: rpcError(id ?? null, -32601, `不支持的方法：${message.method}`),
      };
  }
}

interface ToolCallContext {
  clientKey: string;
  headerSessionId: string;
  id: unknown;
  params: Record<string, unknown>;
  headers: Record<string, string>;
}

const resolveToolSession = (
  sessions: RemoteMcpSessions,
  pages: PageControlPort | undefined,
  toolName: string,
  context: ToolCallContext,
  args: Record<string, unknown>
): { session: RemoteSession; ephemeral: boolean } | undefined => {
  const argSession = typeof args.session === "string" ? args.session.trim() : "";
  const sessionId = context.headerSessionId || argSession;
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing) return { session: existing, ephemeral: false };
  const session = sessions.create(sanitizeName(args.agentName), context.clientKey, pages);
  if (!session) return undefined;
  if (!context.headerSessionId) context.headers["mcp-session-id"] = session.id;
  return { session, ephemeral: EPHEMERAL_TOOLS.has(toolName) };
};

async function handleRemoteToolCall(
  options: RemoteMcpHandlerOptions,
  context: ToolCallContext
): Promise<{ status: number; headers: Record<string, string>; payload: unknown }> {
  const { sessions } = options;
  const name = typeof context.params.name === "string" ? context.params.name : "";
  const args = isRecord(context.params.arguments) ? { ...context.params.arguments } : {};
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) {
    return {
      status: 200,
      headers: context.headers,
      payload: rpcResult(context.id, toolFailure(`未知工具：${name}`)),
    };
  }

  const resolved = resolveToolSession(sessions, options.pages, tool.name, context, args);
  if (!resolved) {
    return {
      status: 200,
      headers: context.headers,
      payload: rpcResult(context.id, toolFailure(SESSIONS_FULL)),
    };
  }
  return sessions.runExclusive(
    resolved.session,
    () => runRemoteTool(options, context, tool, resolved, args),
    () => ({
      status: 200,
      headers: context.headers,
      payload: rpcResult(
        context.id,
        toolFailure("BUSY：同一会话上一个调用仍在执行，请等它返回后再发下一个")
      ),
    })
  );
}

/** 已解析出会话后的一次工具执行：扣额度、发焦点、执行、写审计日志。 */
async function runRemoteTool(
  options: RemoteMcpHandlerOptions,
  context: ToolCallContext,
  tool: (typeof TOOLS)[number],
  { session, ephemeral }: { session: RemoteSession; ephemeral: boolean },
  args: Record<string, unknown>
): Promise<{ status: number; headers: Record<string, string>; payload: unknown }> {
  const { sessions, logger, pages } = options;
  const startedAt = performance.now();
  try {
    if (tool.write && !sessions.consumeWrite(session)) {
      throw Object.assign(new Error("Agent 操作过于频繁，请稍后再试"), { code: "RATE_LIMITED" });
    }
    await publishToolFocus(session.client, session.agentName, tool.name, args);
    const result = await tool.handler(args, {
      client: session.client,
      agentName: session.agentName,
      controllerId: session.id,
      ...(pages ? { pages } : {}),
    });
    if (FOCUS_AFTER_TOOLS.has(tool.name))
      await publishToolFocus(session.client, session.agentName, tool.name, args);
    // 每个绑定会话的调用都把会话号带回给 Agent：无状态客户端要把它放进下一次 arguments.session。
    const enriched = !ephemeral && isRecord(result) ? { ...result, session: session.id } : result;
    const stepFailed = isRecord(enriched) && enriched.ok === false;
    logger.info("mcp.remote.tool", {
      session: refOf(session.id),
      agent: session.agentName,
      tool: tool.name,
      ok: !stepFailed,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return {
      status: 200,
      headers: context.headers,
      payload: rpcResult(
        context.id,
        stepFailed ? toolFailure(JSON.stringify(enriched)) : toolResult(JSON.stringify(enriched))
      ),
    };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    logger.warn("mcp.remote.tool_failed", {
      session: refOf(session.id),
      agent: session.agentName,
      tool: tool.name,
      code,
      message: messageText,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return {
      status: 200,
      headers: context.headers,
      payload: rpcResult(context.id, toolFailure(code ? `${code}：${messageText}` : messageText)),
    };
  } finally {
    if (ephemeral) sessions.close(session.id);
  }
}
