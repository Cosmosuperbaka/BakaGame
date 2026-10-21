import { createInterface } from "node:readline";
import { AgentGameClient, GAME_IDS, type GameId } from "./GameClient";
import { TOOLS } from "./Tools";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const writeStderr = (record: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

const writeStdout = (message: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const mcpEnabled = process.env.MCP_ENABLED === "true";
if (!mcpEnabled) {
  writeStderr({
    time: new Date().toISOString(),
    level: "error",
    msg: "MCP_ENABLED 未开启；Agent 接入默认关闭",
  });
  process.exit(1);
}

const agentName = process.env.MCP_AGENT_NAME?.trim() || "BakaAgent";
const client = new AgentGameClient({
  serverUrl: process.env.SERVER_URL?.trim() || "http://127.0.0.1:4850",
  agentName,
});

/** 按「Agent + 游戏 + 房间」限制写操作：窗口 60 秒最多 30 次。 */
const WRITE_WINDOW_MS = 60_000;
const WRITE_MAX = 30;
const writeBuckets = new Map<string, number[]>();

const consumeWrite = (key: string): boolean => {
  const now = Date.now();
  const bucket = (writeBuckets.get(key) ?? []).filter((at) => now - at < WRITE_WINDOW_MS);
  if (bucket.length >= WRITE_MAX) {
    writeBuckets.set(key, bucket);
    return false;
  }
  bucket.push(now);
  writeBuckets.set(key, bucket);
  return true;
};

const toolGame = (args: Record<string, unknown>): GameId | undefined => {
  if (typeof args.game === "string" && GAME_IDS.includes(args.game as GameId))
    return args.game as GameId;
  const joined = GAME_IDS.filter((game) => client.currentRoom(game));
  return joined.length === 1 ? joined[0] : undefined;
};

const handleToolCall = async (
  id: unknown,
  params: unknown
): Promise<void> => {
  const call = isRecord(params) ? params : {};
  const name = typeof call.name === "string" ? call.name : "";
  const args = isRecord(call.arguments) ? call.arguments : {};
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) {
    writeStdout({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `未知工具：${name}` }],
        isError: true,
      },
    });
    return;
  }

  const game = toolGame(args);
  const roomId =
    typeof args.roomId === "string" ? args.roomId : game ? client.currentRoom(game) : undefined;
  const bucketKey = `${agentName}:${game ?? "auto"}:${roomId ?? "lobby"}`;
  const action = typeof args.action === "string" ? args.action : undefined;
  const startedAt = performance.now();
  try {
    if (tool.write && !consumeWrite(bucketKey)) {
      throw Object.assign(new Error("Agent 操作过于频繁，请稍后再试"), { code: "RATE_LIMITED" });
    }
    const result = await tool.handler(args, { client, agentName });
    writeStdout({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false },
    });
    writeStderr({
      time: new Date().toISOString(),
      level: "info",
      msg: "mcp.tool",
      context: {
        agent: agentName,
        tool: name,
        action,
        game,
        roomId,
        ok: true,
        durationMs: Math.round(performance.now() - startedAt),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    writeStdout({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: code ? `${code}：${message}` : message }],
        isError: true,
      },
    });
    writeStderr({
      time: new Date().toISOString(),
      level: "warn",
      msg: "mcp.tool_failed",
      context: {
        agent: agentName,
        tool: name,
        action,
        game,
        roomId,
        code,
        message,
        durationMs: Math.round(performance.now() - startedAt),
      },
    });
  }
};

const handleLine = async (line: string): Promise<void> => {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    writeStdout({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } });
    return;
  }
  if (!isRecord(message)) {
    writeStdout({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "无效请求" } });
    return;
  }
  const { id, method, params } = message;
  const hasId = id !== undefined;

  if (method === "initialize") {
    const requested = isRecord(params) && typeof params.protocolVersion === "string"
      ? params.protocolVersion
      : "2024-11-05";
    writeStdout({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "bakagame-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") {
    if (hasId) writeStdout({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    if (!hasId) return;
    writeStdout({
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      },
    });
    return;
  }
  if (method === "tools/call") {
    if (!hasId) return;
    await handleToolCall(id, params);
    return;
  }
  if (hasId) {
    writeStdout({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `不支持的方法：${String(method)}` },
    });
  }
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  void handleLine(trimmed).catch((error: unknown) => {
    writeStderr({
      time: new Date().toISOString(),
      level: "error",
      msg: "MCP 请求处理失败",
      context: { error: error instanceof Error ? error.message : String(error) },
    });
  });
});

const shutdown = () => {
  client.close();
  rl.close();
  process.exit(0);
};
rl.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
