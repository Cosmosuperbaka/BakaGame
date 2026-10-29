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
  sessionId?: string,
  clientKey = "198.51.100.7"
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
    body,
    clientKey
  );
};

const initialize = (clientKey: string) =>
  rpc(
    "http://127.0.0.1:9/api/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", clientInfo: { name: "cap-test" } },
    },
    undefined,
    clientKey
  );

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

test("写额度按来源跨会话共享：换会话拿不到新额度，另一来源不受影响", async () => {
  sessionsRef = new RemoteMcpSessions(logger);
  // control_page 是写工具，且没有页面端口时立刻失败，适合只数额度。
  const write = (clientKey: string, session: string) =>
    rpc(
      "http://127.0.0.1:9/api/mcp",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "control_page", arguments: { code: "ABCD2345" } },
      },
      session,
      clientKey
    );
  // 20 个会话各写 24 次 = 480，每个会话都没用完自己的 30 次，但来源额度到顶。
  const sessions: string[] = [];
  for (let index = 0; index < 20; index += 1)
    sessions.push((await initialize("203.0.113.5")).headers["mcp-session-id"]!);
  const texts: string[] = [];
  for (const session of sessions)
    for (let attempt = 0; attempt < 24; attempt += 1)
      texts.push((await write("203.0.113.5", session)).payload.result.content[0].text as string);
  expect(texts.every((text) => text.includes("页面接管只能经站内远程 MCP"))).toBe(true);
  const fresh = (await initialize("203.0.113.5")).headers["mcp-session-id"]!;
  expect((await write("203.0.113.5", fresh)).payload.result.content[0].text).toContain(
    "Agent 操作过于频繁"
  );
  const other = (await initialize("203.0.113.6")).headers["mcp-session-id"]!;
  expect((await write("203.0.113.6", other)).payload.result.content[0].text).toContain(
    "页面接管只能经站内远程 MCP"
  );
});

test("同来源满额时不踢正在用的会话：共享出口背后可能是别的用户", async () => {
  let clock = 1_000_000;
  sessionsRef = new RemoteMcpSessions(logger, () => clock);
  const own: string[] = [];
  for (let index = 0; index < 64; index += 1)
    own.push((await initialize("192.0.2.1")).headers["mcp-session-id"]!);
  const refused = await initialize("192.0.2.1");
  expect(refused.status).toBe(503);
  expect(own.every((id) => sessionsRef.get(id))).toBe(true);

  // 闲置够久的旧会话可以让位；刚用过的仍然保留。
  clock += 3 * 60_000;
  for (const id of own.slice(1)) sessionsRef.get(id);
  expect((await initialize("192.0.2.1")).status).toBe(200);
  expect(sessionsRef.get(own[0]!)).toBeUndefined();
  expect(own.slice(1).every((id) => sessionsRef.get(id))).toBe(true);
});

test("会话表满时拒绝新会话而不挤掉别人的会话", async () => {
  sessionsRef = new RemoteMcpSessions(logger);
  const ids: string[] = [];
  for (let index = 0; index < 256; index += 1)
    ids.push((await initialize(`10.0.${index >> 6}.${index & 63}`)).headers["mcp-session-id"]!);
  const refused = await initialize("192.0.2.99");
  expect(refused.status).toBe(503);
  expect(refused.payload.error.message).toContain("会话已满");
  expect(ids.every((id) => sessionsRef.get(id))).toBe(true);
});

test("页面接管只经站内远程 MCP：没有页面端口时四个工具都明确拒绝", async () => {
  // stdio 进程既没有浏览器连接、也无法证明自己持有配对码，因此页面能力是可选注入的窄接口。
  // 这里锁住「明确报错」这条底线：静默降级会让 Agent 以为自己在驱动页面，实际什么也没发生。
  sessionsRef = new RemoteMcpSessions(logger);
  const cases: Array<[string, Record<string, unknown>]> = [
    ["control_page", { code: "ABCD2345" }],
    ["page_state", {}],
    ["page_act", { action: "navigate", path: "/songuessr" }],
    ["release_page", {}],
  ];
  for (const [name, args] of cases) {
    const result = await rpc("http://127.0.0.1:9/api/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    expect(result.payload.result.isError).toBe(true);
    expect(result.payload.result.content[0].text).toContain("页面接管只能经站内远程 MCP");
  }
});
