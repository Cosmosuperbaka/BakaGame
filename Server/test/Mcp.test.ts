import { afterEach, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyStateSync, type AgentGameClient } from "../src/mcp/GameClient";
import { TOOLS } from "../src/mcp/Tools";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(serverRoot, "src/mcp/Index.ts");

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) void server.stop(true);
});

const spawnMcp = (env: Record<string, string>) =>
  Bun.spawn([process.execPath, "run", entry], {
    cwd: serverRoot,
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

const readLine = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: { text: string }
): Promise<string | undefined> => {
  const decoder = new TextDecoder();
  for (;;) {
    const newline = buffered.text.indexOf("\n");
    if (newline >= 0) {
      const line = buffered.text.slice(0, newline);
      buffered.text = buffered.text.slice(newline + 1);
      return line;
    }
    const result = await reader.read();
    if (result.done) return buffered.text || undefined;
    buffered.text += decoder.decode(result.value, { stream: true });
  }
};

test(
  "MCP_ENABLED 关闭时进程拒绝启动",
  async () => {
    const process = spawnMcp({ MCP_ENABLED: "false" });
    const stderr = await new Response(process.stderr).text();
    const exitCode = await process.exited;
    expect(exitCode).toBe(1);
    expect(stderr).toContain("MCP_ENABLED");
  },
  15_000
);

test(
  "stdio MCP 可列房间、进房并按公开快照读取状态，审计日志可追溯",
  async () => {
    const roomSnapshot = {
      roomId: "1234",
      name: "Agent 测试房",
      phase: "waiting",
      allowSpectators: true,
      settings: { allowAgents: true },
      players: [
        {
          id: "player-1",
          name: "TestAgent",
          score: 0,
          online: true,
          isReady: false,
          isBot: false,
          isAgent: true,
          isHost: false,
          roundStatus: "waiting",
        },
      ],
      chat: [],
    };
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("upgrade required", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const message = JSON.parse(String(raw)) as {
            id: string;
            type: string;
            payload?: unknown;
          };
          const ack = (payload: unknown) =>
            ws.send(JSON.stringify({ type: "ack", id: message.id, requestType: message.type, payload }));
          if (message.type === "lobby.subscribeRooms") {
            ack({ subscribed: true });
            ws.send(
              JSON.stringify({
                type: "event",
                event: "lobby.rooms",
                payload: [
                  {
                    roomId: "1234",
                    name: "Agent 测试房",
                    phase: "waiting",
                    playerCount: 1,
                    visibility: "public",
                    allowSpectators: true,
                  },
                ],
              })
            );
            return;
          }
          if (message.type === "room.join") {
            ack({ roomId: "1234", playerId: "player-1", sessionToken: "agent-token" });
            ws.send(
              JSON.stringify({
                type: "event",
                event: "room.snapshot",
                payload: { mode: "full", revision: 1, state: roomSnapshot },
              })
            );
            return;
          }
          ack({});
        },
      },
    });
    servers.push(server);
    const port = server.port;
    const process = spawnMcp({
      MCP_ENABLED: "true",
      SERVER_URL: `http://127.0.0.1:${port}`,
      MCP_AGENT_NAME: "TestAgent",
    });
    const stdoutReader = process.stdout.getReader();
    const stderrPromise = new Response(process.stderr).text();
    const buffered = { text: "" };
    const send = async (message: Record<string, unknown>) => {
      await process.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const call = async (id: number, method: string, params?: unknown) => {
      await send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      const line = await readLine(stdoutReader, buffered);
      expect(line).toBeDefined();
      return JSON.parse(line!) as Record<string, unknown>;
    };

    try {
      const initialized = await call(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      expect(initialized.result).toMatchObject({
        protocolVersion: "2024-11-05",
        serverInfo: { name: "bakagame-mcp" },
      });

      const tools = await call(2, "tools/list");
      const names = (tools.result as { tools: Array<{ name: string }> }).tools.map(
        (tool) => tool.name
      );
      expect(names).toEqual(expect.arrayContaining(["list_rooms", "join_room", "get_room_state"]));

      const joined = await call(3, "tools/call", {
        name: "join_room",
        arguments: { game: "faker", roomId: "1234" },
      });
      expect(joined.result).toMatchObject({ isError: false });
      const joinedText = (
        joined.result as { content: Array<{ text: string }> }
      ).content[0]!.text;
      expect(joinedText).toContain('"isAgent":true');
      expect(joinedText).toContain('"playerId":"player-1"');

      const state = await call(4, "tools/call", {
        name: "get_room_state",
        arguments: { game: "faker" },
      });
      const stateText = (state.result as { content: Array<{ text: string }> }).content[0]!.text;
      expect(stateText).toContain("Agent 测试房");
      expect(stateText).not.toContain("privateState");
      expect(stateText).not.toContain('"answer"');
      expect(stateText).not.toContain('"words"');

      const rooms = await call(5, "tools/call", {
        name: "list_rooms",
        arguments: { game: "faker" },
      });
      const roomsText = (rooms.result as { content: Array<{ text: string }> }).content[0]!.text;
      expect(roomsText).toContain('"roomId":"1234"');
    } finally {
      await process.stdin.end();
      await process.exited;
      const stderr = await stderrPromise;
      expect(stderr).toContain('"msg":"mcp.tool"');
      expect(stderr).toContain('"agent":"TestAgent"');
      expect(stderr).toContain('"tool":"join_room"');
      expect(stderr).toContain('"roomId":"1234"');
    }
  },
  20_000
);

test("状态同步 full / patch 都能落到公开快照", () => {
  const full = applyStateSync(undefined, {
    mode: "full",
    revision: 1,
    state: { roomId: "1", players: [{ id: "p1", name: "A", score: 1 }] },
  });
  expect(full).toMatchObject({ roomId: "1" });

  const patched = applyStateSync(full, {
    mode: "patch",
    baseRevision: 1,
    revision: 2,
    operations: [{ op: "replace", path: "/players/0/score", value: 2 }],
  });
  expect((patched?.players as Array<{ score: number }>)[0]?.score).toBe(2);
});

test("结算记录工具只返回公开字段，不泄露答案、词对与私有身份", async () => {
  const fake = {
    currentRoom: () => "1234",
    currentPlayerId: () => "player-1",
    currentSnapshot: () => ({
      roomId: "1234",
      phase: "settled",
      players: [
        {
          id: "player-1",
          name: "Agent",
          score: 3,
          isAgent: true,
          // 快照里可能带私有字段时也不能原样透出。
          privateState: { answer: "秘密" },
        },
      ],
      roundSummary: {
        answer: { name: "秘密角色" },
        winners: [{ playerId: "player-1", rank: 1, score: 3 }],
        scores: [],
        guesses: [],
      },
    }),
    sendInRoom: async () => ({}),
  } as unknown as AgentGameClient;
  const tool = TOOLS.find((entry) => entry.name === "get_game_record")!;
  const result = await tool.handler({ game: "cee" }, { client: fake, agentName: "TestAgent" });
  const text = JSON.stringify(result);
  expect(text).toContain("player-1");
  expect(text).toContain("winners");
  expect(text).not.toContain("秘密");
  expect(text).not.toContain("privateState");
});

test("create_room 把房主规则参数交给游戏客户端", async () => {
  const calls: unknown[] = [];
  const fake = {
    create: async (...args: unknown[]) => {
      calls.push(args);
      return { game: "faker", roomId: "7777", playerId: "agent-1", snapshot: null };
    },
    currentRoom: () => undefined,
    currentPlayerId: () => undefined,
    currentSnapshot: () => undefined,
  } as unknown as AgentGameClient;
  const tool = TOOLS.find((entry) => entry.name === "create_room")!;
  const result = await tool.handler(
    {
      game: "faker",
      roomId: "7777",
      name: "Agent 房",
      allowAgents: true,
      allowSpectators: false,
    },
    { client: fake, agentName: "TestAgent" }
  );

  expect(calls[0]).toEqual([
    "faker",
    "7777",
    {
      name: "Agent 房",
      userName: "TestAgent",
      visibility: "public",
      allowSpectators: false,
      allowAgents: true,
    },
  ]);
  expect(result).toMatchObject({ game: "faker", roomId: "7777", isAgent: true });
});
