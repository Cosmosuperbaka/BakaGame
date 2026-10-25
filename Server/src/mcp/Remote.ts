import type { EventLogger } from "../infrastructure/EventLogger";
import { FOCUS_AFTER_TOOLS, publishToolFocus } from "./Focus";
import { AgentGameClient } from "./GameClient";
import { MCP_INSTRUCTIONS } from "./Policy";
import { TOOLS, withRemoteSessionSchema } from "./Tools";


const SERVER_INFO = { name: "bakagame-mcp", version: "1.0.0" };
const SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SESSION_IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 256;
const WRITE_WINDOW_MS = 60_000;
const WRITE_MAX = 30;

/** 不依赖房间状态、可以临时开一个会话就返回的工具。 */
const STATELESS_TOOLS = new Set(["list_rooms", "get_mcp_policy"]);
const SESSION_CREATING_TOOLS = new Set(["create_room", "join_room", "claim_seat"]);

export interface RemoteSession {
  id: string;
  client: AgentGameClient;
  baseUrl: string;
  agentName: string;
  createdAt: number;
  lastUsedAt: number;
  writes: number[];
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sanitizeName = (value: unknown): string => {
  if (typeof value !== "string") return "BakaAgent";
  const trimmed = value.trim().slice(0, 24);
  return trimmed || "BakaAgent";
};

export class RemoteMcpSessions {
  private readonly sessions = new Map<string, RemoteSession>();

  constructor(private readonly logger: EventLogger) {}

  create(baseUrl: string, agentName: string): RemoteSession {
    this.prune();
    const session: RemoteSession = {
      id: crypto.randomUUID(),
      client: new AgentGameClient({ serverUrl: baseUrl, agentName }),
      baseUrl,
      agentName,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      writes: [],
    };
    this.sessions.set(session.id, session);
    this.logger.info("mcp.remote.session", { session: session.id, agent: agentName });
    return session;
  }

  get(id: string): RemoteSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    session.lastUsedAt = Date.now();
    return session;
  }

  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.client.close();
    this.sessions.delete(id);
    return true;
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.client.close();
    this.sessions.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsedAt > SESSION_IDLE_MS) {
        session.client.close();
        this.sessions.delete(id);
      }
    }
    if (this.sessions.size < MAX_SESSIONS) return;
    const oldest = [...this.sessions.values()].sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    for (const session of oldest.slice(0, this.sessions.size - MAX_SESSIONS + 1)) {
      session.client.close();
      this.sessions.delete(session.id);
    }
  }

  consumeWrite(session: RemoteSession): boolean {
    const now = Date.now();
    session.writes = session.writes.filter((at) => now - at < WRITE_WINDOW_MS);
    if (session.writes.length >= WRITE_MAX) return false;
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

const protocolVersionOf = (requested: unknown): string => {
  if (
    typeof requested === "string" &&
    (SUPPORTED_VERSIONS as readonly string[]).includes(requested)
  ) {
    return requested;
  }
  return DEFAULT_PROTOCOL_VERSION;
};

export interface RemoteMcpHandlerOptions {
  enabled: boolean;
  sessions: RemoteMcpSessions;
  logger: EventLogger;
}

/** 远程 MCP 的 JSON-RPC 核心；HTTP 路由只负责取 Origin、Session 头与状态码。 */
export async function handleRemoteMcp(
  options: RemoteMcpHandlerOptions,
  request: Request,
  body: unknown
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
  const baseUrl = originOf(request);
  const headers: Record<string, string> = {};

  switch (message.method) {
    case "initialize": {
      const clientInfo = isRecord(params.clientInfo) ? params.clientInfo : {};
      const session = sessions.create(baseUrl, sanitizeName(clientInfo.name));
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
          supportedVersions: [...SUPPORTED_VERSIONS],
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
        baseUrl,
        headerSessionId: request.headers.get("mcp-session-id")?.trim() || "",
        id,
        params,
        headers,
      });
    default:
      return {
        status: 200,
        headers,
        payload: rpcError(id ?? null, -32601, `不支持的方法：${message.method}`),
      };
  }
}

const originOf = (request: Request): string => {
  try {
    return new URL(request.url).origin;
  } catch {
    return "http://127.0.0.1:4850";
  }
};

interface ToolCallContext {
  baseUrl: string;
  headerSessionId: string;
  id: unknown;
  params: Record<string, unknown>;
  headers: Record<string, string>;
}

const resolveToolSession = (
  sessions: RemoteMcpSessions,
  toolName: string,
  context: ToolCallContext,
  args: Record<string, unknown>
): { session: RemoteSession; ephemeral: boolean } | { error: string } => {
  const argSession = typeof args.session === "string" ? args.session.trim() : "";
  const sessionId = context.headerSessionId || argSession;
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing) return { session: existing, ephemeral: false };
  if (!SESSION_CREATING_TOOLS.has(toolName) && !STATELESS_TOOLS.has(toolName)) {
    return {
      error:
        "缺少 Agent 会话：先调用 create_room 或 join_room，后续工具调用带上返回的 session（或让客户端回传 Mcp-Session-Id）。",
    };
  }
  const session = sessions.create(context.baseUrl, "BakaAgent");
  if (!context.headerSessionId) context.headers["mcp-session-id"] = session.id;
  return { session, ephemeral: STATELESS_TOOLS.has(toolName) };
};

async function handleRemoteToolCall(
  options: RemoteMcpHandlerOptions,
  context: ToolCallContext
): Promise<{ status: number; headers: Record<string, string>; payload: unknown }> {
  const { sessions, logger } = options;
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

  const resolved = resolveToolSession(sessions, tool.name, context, args);
  if ("error" in resolved) {
    return {
      status: 200,
      headers: context.headers,
      payload: rpcResult(context.id, toolFailure(resolved.error)),
    };
  }
  const { session, ephemeral } = resolved;
  const startedAt = performance.now();
  try {
    if (tool.write && !sessions.consumeWrite(session)) {
      throw Object.assign(new Error("Agent 操作过于频繁，请稍后再试"), { code: "RATE_LIMITED" });
    }
    await publishToolFocus(session.client, session.agentName, tool.name, args);
    const result = await tool.handler(args, {
      client: session.client,
      agentName: session.agentName,
    });
    if (FOCUS_AFTER_TOOLS.has(tool.name))
      await publishToolFocus(session.client, session.agentName, tool.name, args);
    const enriched =
      SESSION_CREATING_TOOLS.has(tool.name) && isRecord(result)
        ? { ...result, session: session.id }
        : result;
    const stepFailed = isRecord(enriched) && enriched.ok === false;
    logger.info("mcp.remote.tool", {
      session: session.id,
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
      session: session.id,
      agent: session.agentName,
      tool: tool.name,
      code,
      message: messageText,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return {
      status: 200,
      headers: context.headers,
      payload: rpcResult(
        context.id,
        toolFailure(code ? `${code}：${messageText}` : messageText)
      ),
    };
  } finally {
    if (ephemeral) sessions.close(session.id);
  }
}
