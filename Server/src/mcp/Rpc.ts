import { isRecord } from "../shared/Json";
import { FOCUS_AFTER_TOOLS, focusGame, publishToolFocus } from "./Focus";
import { GAME_IDS, type AgentGameClient, type GameId } from "./GameClient";
import {
  DEFAULT_PROTOCOL_VERSION,
  MCP_INSTRUCTIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  protocolVersionOf,
} from "./Policy";
import { TOOLS, type McpTool, type ToolContext } from "./Tools";

/**
 * 两个入口（stdio 与站内远程 HTTP）共用的协议内核：方法路由、握手内容、工具清单、
 * 工具执行与审计字段。传输各自只负责取消息、解析会话、写出响应与落日志。
 */

const SERVER_INFO = { name: "bakagame-mcp", version: "1.0.0" };
const CAPABILITIES = { tools: { listChanged: false } };

/** 按「Agent + 游戏」或「会话」限制写操作：窗口 60 秒最多 30 次。 */
export const WRITE_WINDOW_MS = 60_000;
export const WRITE_MAX = 30;

/** 窗口内仍有效的写入时刻：滑动窗口的两处实现共用这一步修剪。 */
export const recentWrites = (bucket: readonly number[], now: number): number[] =>
  bucket.filter((at) => now - at < WRITE_WINDOW_MS);

export const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });

export const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

const toolText = (text: string, isError: boolean) => ({
  content: [{ type: "text", text }],
  isError,
});

export const toolResult = (text: string) => toolText(text, false);

export const toolFailure = (text: string) => toolText(text, true);

export const initializeResult = (params: Record<string, unknown>) => ({
  protocolVersion: protocolVersionOf(params.protocolVersion),
  capabilities: CAPABILITIES,
  serverInfo: SERVER_INFO,
  instructions: MCP_INSTRUCTIONS,
});

export const discoverResult = () => ({
  protocolVersion: DEFAULT_PROTOCOL_VERSION,
  supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
  capabilities: CAPABILITIES,
  serverInfo: SERVER_INFO,
  instructions: MCP_INSTRUCTIONS,
});

/** 工具清单；远程入口用 `decorate` 给每个 schema 补上会话参数。 */
export const toolListing = (
  decorate: (schema: Record<string, unknown>) => Record<string, unknown> = (schema) => schema
) => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema: decorate(inputSchema),
  })),
});

/** 方法路由对传输暴露的出口：每个出口产出该传输的响应形状 `R`。 */
export interface RpcHandlers<R> {
  /**
   * 这条消息要不要回响应。通知与不带 id 的请求按规范不回；两个入口对「不带 id 的
   * ping、server/discover、tools/list」与「id 为 null 的 tools/call」的处理历来不同，
   * 由各自声明，路由不替它们统一。
   */
  answers(method: unknown, id: unknown): boolean;
  silent(): R;
  reply(result: unknown): R;
  fail(code: number, message: string): R;
  initialize(params: Record<string, unknown>): R | Promise<R>;
  listTools(): R;
  callTool(params: Record<string, unknown>): R | Promise<R>;
}

export function routeRpc<R>(
  method: unknown,
  id: unknown,
  params: unknown,
  handlers: RpcHandlers<R>
): R | Promise<R> {
  const body = isRecord(params) ? params : {};
  switch (method) {
    case "initialize":
      return handlers.initialize(body);
    case "notifications/initialized":
    case "notifications/cancelled":
      return handlers.silent();
    case "server/discover":
      return handlers.answers(method, id) ? handlers.reply(discoverResult()) : handlers.silent();
    case "ping":
      return handlers.answers(method, id) ? handlers.reply({}) : handlers.silent();
    case "tools/list":
      return handlers.answers(method, id) ? handlers.listTools() : handlers.silent();
    case "tools/call":
      return handlers.answers(method, id) ? handlers.callTool(body) : handlers.silent();
    default:
      return handlers.answers(method, id)
        ? handlers.fail(-32601, `不支持的方法：${String(method)}`)
        : handlers.silent();
  }
}

/** `tools/call` 的入参：工具名与参数副本（参数不是对象时按空对象处理）。 */
export const toolCallOf = (
  params: Record<string, unknown>
): { name: string; args: Record<string, unknown>; tool: McpTool | undefined } => {
  const name = typeof params.name === "string" ? params.name : "";
  const args = isRecord(params.arguments) ? { ...params.arguments } : {};
  return { name, args, tool: TOOLS.find((entry) => entry.name === name) };
};

export const unknownToolText = (name: string): string => `未知工具：${name}`;

/** 审计与限流共用的调用目标：动作、游戏与房间。 */
export const auditTarget = (
  client: AgentGameClient,
  args: Record<string, unknown>,
  /** 没传 game 时是否按「只加入了一款游戏」推断；两个入口的审计口径历来不同。 */
  inferGame: boolean
): { action: string | undefined; game: GameId | undefined; roomId: string | undefined } => {
  const explicit =
    typeof args.game === "string" && (GAME_IDS as readonly string[]).includes(args.game)
      ? (args.game as GameId)
      : undefined;
  const game = inferGame ? focusGame(client, args) : explicit;
  return {
    action: typeof args.action === "string" ? args.action : undefined,
    game,
    roomId:
      typeof args.roomId === "string" ? args.roomId : game ? client.currentRoom(game) : undefined,
  };
};

export type ToolRun<T> =
  { ok: true; value: T } | { ok: false; message: string; code: string | undefined };

/** 失败回给调用方的文本：带错误码时前缀 `码：`。 */
export const failureText = (run: { message: string; code: string | undefined }): string =>
  run.code ? `${run.code}：${run.message}` : run.message;

export interface ToolRunPorts {
  client: AgentGameClient;
  agentName: string;
  /** 传给工具实现的上下文：stdio 没有会话与页面接管，远程入口带上它们。 */
  context: ToolContext;
  /** 写工具先扣额度，用尽即拒。 */
  consumeWrite(): boolean;
}

/**
 * 一次工具执行：写额度、站点焦点、执行、进房类工具的二次上报。
 * `format` 在同一个保护范围内把结果整理成回包（序列化失败也按工具失败回），不抛出。
 */
export async function runTool<T>(
  tool: McpTool,
  args: Record<string, unknown>,
  ports: ToolRunPorts,
  format: (result: unknown) => T
): Promise<ToolRun<T>> {
  const { client, agentName } = ports;
  try {
    if (tool.write && !ports.consumeWrite()) {
      throw Object.assign(new Error("Agent 操作过于频繁，请稍后再试"), { code: "RATE_LIMITED" });
    }
    publishToolFocus(client, agentName, tool.name, args);
    const result = await tool.handler(args, ports.context);
    if (FOCUS_AFTER_TOOLS.has(tool.name)) publishToolFocus(client, agentName, tool.name, args);
    return { ok: true, value: format(result) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      code: isRecord(error) && typeof error.code === "string" ? error.code : undefined,
    };
  }
}
