import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { handleRemoteMcp, RemoteMcpSessions } from "../src/mcp/Remote";
import { mcpRemoteRoutes } from "../src/transport/routes/McpRemote";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) void server.stop(true);
});

const logger = new EventLogger(() => {});

const rpc = async (
  url: string,
  body: Record<string, unknown>,
  sessionId?: string
): Promise<{ status: number; headers: Record<string, string>; payload: any }> => {
  const sessions = sessionsRef;
  return handleRemoteMcp(
    { enabled: true, sessions, logger },
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
    }),
    body
  );
};

let sessionsRef: RemoteMcpSessions;

const fakeFakerServer = () => {
  /** 探针记录：升级路径与信封上的 `game`，用来看住「统一入口 + 显式归属」这两条契约。 */
  const seen = { paths: [] as string[], games: [] as Array<string | undefined> };
  const snapshot = {
    roomId: "1234",
    name: "远程 MCP 房",
    phase: "waiting",
    allowSpectators: true,
    settings: { allowAgents: true },
    players: [],
    chat: [],
  };
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      seen.paths.push(new URL(request.url).pathname);
      if (server.upgrade(request)) return;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw)) as {
          id: string;
          type: string;
          game?: string;
          payload?: Record<string, unknown>;
        };
        seen.games.push(message.game);
        const ack = (payload: unknown) =>
          ws.send(
            JSON.stringify({
              type: "ack",
              id: message.id,
              requestType: message.type,
              payload,
            })
          );
        if (message.type === "lobby.subscribeRooms") {
          ack({ subscribed: true });
          ws.send(
            JSON.stringify({
              type: "event",
              event: "lobby.rooms",
              payload: [{ ...snapshot, playerCount: 1, visibility: "public" }],
            })
          );
          return;
        }
        if (message.type === "room.create") {
          ack({
            roomId: "1234",
            playerId: "player-remote",
            sessionToken: "remote-session",
            snapshot,
            privateState: {
              playerId: "player-remote",
              sessionToken: "remote-session",
              role: "civilian",
              word: "苹果",
              isQuestioner: false,
            },
          });
          return;
        }
        ack({});
      },
    },
  });
  servers.push(server);
  return { server, seen };
};

test("远程 MCP 支持 initialize / 工具调用 / 本人私有状态，并随 initialize 下发反作弊声明", async () => {
  const { server, seen } = fakeFakerServer();
  sessionsRef = new RemoteMcpSessions(logger);
  const url = `http://127.0.0.1:${server.port}/api/mcp`;

  const initialized = await rpc(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", clientInfo: { name: "remote-test" } },
  });
  expect(initialized.status).toBe(200);
  const sessionId = initialized.headers["mcp-session-id"];
  expect(sessionId).toBeTruthy();
  expect(initialized.payload.result.serverInfo).toMatchObject({ name: "bakagame-mcp" });
  expect(initialized.payload.result.instructions).toContain("严禁用于辅助人类作弊");

  const tools = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId);
  const names = (tools.payload.result.tools as Array<{ name: string }>).map((tool) => tool.name);
  expect(names).toEqual(
    expect.arrayContaining(["create_room", "claim_seat", "get_screen", "ui_run"])
  );

  const created = await rpc(
    url,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "create_room",
        arguments: { game: "faker", roomId: "1234", name: "远程 MCP 房", allowAgents: true },
      },
    },
    sessionId
  );
  const createdText = created.payload.result.content[0].text as string;
  expect(createdText).toContain('"playerId":"player-remote"');
  expect(createdText).toContain(`"session":"${sessionId}"`);

  const mine = await rpc(
    url,
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_screen", arguments: { game: "faker" } },
    },
    sessionId
  );
  const mineText = mine.payload.result.content[0].text as string;
  expect(mineText).toContain("苹果");
  expect(mineText).toContain('"players"');
  expect(mineText).toContain('"chat"');
  expect(mineText).not.toContain("remote-session");

  // 统一入口 + 显式归属：Agent 只有一条 `/api/ws`，游戏命令都带信封 `game`，
  // 站点通道的命令反过来不带（它不属于任何游戏）。
  expect(new Set(seen.paths)).toEqual(new Set(["/api/ws"]));
  expect(seen.games).toContain("faker");
  expect(seen.games).toContain(undefined);

  const discovered = await rpc(url, {
    jsonrpc: "2.0",
    id: 5,
    method: "server/discover",
    params: {},
  });
  expect(discovered.payload.result.instructions).toContain("纯 Agent 自行游玩");
});

test("HTTP 路由回传 Mcp-Session-Id，GET 提示只接受 POST，DELETE 可关闭会话", async () => {
  const app = new Elysia({ normalize: false }).use(
    mcpRemoteRoutes({
      enabled: true,
      logger,
      sessions: new RemoteMcpSessions(logger),
    })
  );
  const initialized = await app.handle(
    new Request("https://game.example.com/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", clientInfo: { name: "route-test" } },
      }),
    })
  );
  expect(initialized.status).toBe(200);
  const sessionId = initialized.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();

  const notAllowed = await app.handle(
    new Request("https://game.example.com/api/mcp", { method: "GET" })
  );
  expect(notAllowed.status).toBe(405);
  expect(notAllowed.headers.get("allow")).toContain("POST");

  const closed = await app.handle(
    new Request("https://game.example.com/api/mcp", {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId! },
    })
  );
  expect(closed.status).toBe(204);
});

test("远程 MCP 自动为首次调用建立会话，未进房时给出可执行的下一步", async () => {
  sessionsRef = new RemoteMcpSessions(logger);
  const result = await rpc("http://127.0.0.1:9/api/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_screen", arguments: { game: "faker" } },
  });
  expect(result.payload.result.isError).toBe(true);
  // 会话不再要求先建房/进房：Agent 从首页开始就要有连接，站点活动才能出现。
  expect(result.payload.result.content[0].text).toContain("尚未加入 faker 的房间");
});
