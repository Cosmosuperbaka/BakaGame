import { createInterface } from "node:readline";
import { AgentGameClient } from "./GameClient";
import {
  WRITE_MAX,
  auditTarget,
  failureText,
  initializeResult,
  recentWrites,
  routeRpc,
  rpcError,
  rpcResult,
  runTool,
  toolCallOf,
  toolFailure,
  toolListing,
  toolResult,
  unknownToolText,
  type RpcHandlers,
} from "./Rpc";
import { isRecord } from "../shared/Json";

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

/**
 * 键里不能放调用方可控的房号：每次换个房号就得到新桶，限流形同虚设，Map 也会无限增长。
 */
const writeBuckets = new Map<string, number[]>();

const consumeWrite = (key: string): boolean => {
  const now = Date.now();
  const bucket = recentWrites(writeBuckets.get(key) ?? [], now);
  if (bucket.length >= WRITE_MAX) {
    writeBuckets.set(key, bucket);
    return false;
  }
  bucket.push(now);
  writeBuckets.set(key, bucket);
  return true;
};

const handleToolCall = async (id: unknown, params: Record<string, unknown>): Promise<void> => {
  const { name, args, tool } = toolCallOf(params);
  if (!tool) {
    writeStdout(rpcResult(id, toolFailure(unknownToolText(name))));
    return;
  }

  const { action, game, roomId } = auditTarget(client, args, true);
  const bucketKey = `${agentName}:${game ?? "auto"}`;
  const startedAt = performance.now();
  const run = await runTool(
    tool,
    args,
    {
      client,
      agentName,
      context: { client, agentName },
      consumeWrite: () => consumeWrite(bucketKey),
    },
    (result) => toolResult(JSON.stringify(result))
  );
  const durationMs = Math.round(performance.now() - startedAt);
  if (run.ok) {
    writeStdout(rpcResult(id, run.value));
    writeStderr({
      time: new Date().toISOString(),
      level: "info",
      msg: "mcp.tool",
      context: { agent: agentName, tool: name, action, game, roomId, ok: true, durationMs },
    });
    return;
  }
  writeStdout(rpcResult(id, toolFailure(failureText(run))));
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
      code: run.code,
      message: run.message,
      durationMs,
    },
  });
};

/** stdio 只对带 id 的请求回响应；id 为 null 也算请求。 */
const stdioHandlers = (id: unknown): RpcHandlers<Record<string, unknown> | undefined> => ({
  answers: () => id !== undefined,
  silent: () => undefined,
  reply: (result) => rpcResult(id, result),
  fail: (code, message) => rpcError(id, code, message),
  initialize: (params) => rpcResult(id, initializeResult(params)),
  listTools: () => rpcResult(id, toolListing()),
  callTool: async (params) => {
    await handleToolCall(id, params);
    return undefined;
  },
});

const handleLine = async (line: string): Promise<void> => {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    writeStdout(rpcError(null, -32700, "JSON 解析失败"));
    return;
  }
  if (!isRecord(message)) {
    writeStdout(rpcError(null, -32600, "无效请求"));
    return;
  }
  const reply = await routeRpc(
    message.method,
    message.id,
    message.params,
    stdioHandlers(message.id)
  );
  if (reply) writeStdout(reply);
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
