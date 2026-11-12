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

/** 缺省的回环目标是一个没人监听的端口：不碰网络的用例不需要真服务端。 */
const newSessions = (selfUrl = "http://127.0.0.1:9", now?: () => number) =>
  new RemoteMcpSessions(logger, { selfUrl, siteUrl: "https://game.example.com" }, now);

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
  sessionsRef = newSessions(`http://127.0.0.1:${server.port}`);
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
    expect.arrayContaining(["create_room", "control_page", "page_act", "get_screen", "ui_run"])
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
      sessions: newSessions(),
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
  sessionsRef = newSessions();
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
  sessionsRef = newSessions();
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
  sessionsRef = newSessions(undefined, () => clock);
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
  sessionsRef = newSessions();
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
  sessionsRef = newSessions();
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

test("请求 Host 指向别处时，服务端仍只连自己的回环地址，不向该主机发起任何连接", async () => {
  const attacker = fakeFakerServer();
  const own = fakeFakerServer();
  sessionsRef = newSessions(`http://127.0.0.1:${own.server.port}`);
  // request.url 由 Host 头决定：这里模拟攻击者把 Host 设成自己控制的主机。
  const forged = `http://127.0.0.1:${attacker.server.port}/api/mcp`;
  const created = await rpc(forged, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "create_room",
      arguments: { game: "faker", roomId: "1234", name: "x", allowAgents: true },
    },
  });
  expect(created.payload.result.content[0].text).toContain('"playerId":"player-remote"');
  expect(attacker.seen.paths).toEqual([]);
  expect(own.seen.paths).toContain("/api/ws");
});

test("四个来源各占满自己的额度后，别的来源在占位会话闲置够久时仍能建会话", async () => {
  let clock = 1_000_000;
  sessionsRef = newSessions(undefined, () => clock);
  for (let source = 0; source < 4; source += 1)
    for (let index = 0; index < 64; index += 1)
      expect((await initialize(`198.51.100.${source}`)).status).toBe(200);
  // 刚占满时不挤任何人：占位会话可能正有人在用。
  expect((await initialize("192.0.2.50")).status).toBe(503);
  // 无座位、无页面租约、闲置够久：匿名占位不能把全表锁死。
  clock += 3 * 60_000;
  const admitted = await initialize("192.0.2.50");
  expect(admitted.status).toBe(200);
  expect(admitted.headers["mcp-session-id"]).toBeTruthy();
});

test("全表满额回收只动闲置的会话：正被页面接管的会话不会被淘汰", async () => {
  let clock = 1_000_000;
  sessionsRef = newSessions(undefined, () => clock);
  const controlling = new Set<string>();
  const pages = {
    isControlling: (id: string) => controlling.has(id),
    claim: () => ({ pageId: "p", agentName: "a" }),
    dispatch: async () => ({ ok: true }),
    closeByController: () => false,
  } as never;
  const ids: string[] = [];
  for (let source = 0; source < 4; source += 1)
    for (let index = 0; index < 64; index += 1) {
      const result = await handleRemoteMcp(
        { enabled: true, sessions: sessionsRef, logger, pages },
        new Request("http://127.0.0.1:9/api/mcp", { method: "POST" }),
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        `198.51.100.${source}`
      );
      ids.push(result.headers["mcp-session-id"]!);
    }
  // 最旧的一条正被接管：回收要跳过它，改动下一条最旧的闲置会话。
  controlling.add(ids[0]!);
  clock += 3 * 60_000;
  const admitted = await handleRemoteMcp(
    { enabled: true, sessions: sessionsRef, logger, pages },
    new Request("http://127.0.0.1:9/api/mcp", { method: "POST" }),
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    "192.0.2.50"
  );
  expect(admitted.status).toBe(200);
  expect(sessionsRef.get(ids[0]!)).toBeDefined();
  expect(sessionsRef.get(ids[1]!)).toBeUndefined();
});

test("日志里只有会话号的短摘要，不出现可用来接管会话的完整会话号", async () => {
  const records: unknown[] = [];
  const spy = new EventLogger(() => {}, undefined, undefined, undefined, {
    sinks: [{ write: (record) => void records.push(record) }],
  });
  sessionsRef = newSessions();
  const call = (name: string, args: Record<string, unknown>, session?: string) =>
    handleRemoteMcp(
      { enabled: true, sessions: sessionsRef, logger: spy },
      new Request("http://127.0.0.1:9/api/mcp", {
        method: "POST",
        headers: session ? { "mcp-session-id": session } : {},
      }),
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      "198.51.100.7"
    );
  const first = await call("get_screen", { game: "faker" });
  const id = first.headers["mcp-session-id"]!;
  await call("get_screen", { game: "faker" }, id);
  await call("get_mcp_policy", {});
  const init = await handleRemoteMcp(
    { enabled: true, sessions: sessionsRef, logger: spy },
    new Request("http://127.0.0.1:9/api/mcp", { method: "POST" }),
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    "198.51.100.7"
  );
  const initId = init.headers["mcp-session-id"]!;
  const output = JSON.stringify(records);
  expect(output).toContain("mcp.remote");
  expect(output).not.toContain(id);
  expect(output).not.toContain(initId);
});

test("全表满额回收不动占着座位的会话", async () => {
  let clock = 1_000_000;
  const { server } = fakeFakerServer();
  sessionsRef = newSessions(`http://127.0.0.1:${server.port}`, () => clock);
  const url = `http://127.0.0.1:${server.port}/api/mcp`;
  const seated = await rpc(
    url,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_room",
        arguments: { game: "faker", roomId: "1234", name: "x", allowAgents: true },
      },
    },
    undefined,
    "203.0.113.1"
  );
  const seatedId = seated.headers["mcp-session-id"]!;
  const others: string[] = [];
  for (let source = 0; source < 4; source += 1)
    for (let index = 0; index < (source === 3 ? 63 : 64); index += 1)
      others.push((await initialize(`198.51.100.${source}`)).headers["mcp-session-id"]!);
  clock += 3 * 60_000;
  expect((await initialize("192.0.2.50")).status).toBe(200);
  expect(sessionsRef.get(seatedId)).toBeDefined();
  expect(others.filter((id) => sessionsRef.get(id)).length).toBe(254);
});

/** 建房回执延迟 ack、并记录收发先后的假服务端，用来看同一会话的调用是否交错。 */
const slowCreateServer = (ackDelayMs: number) => {
  const order: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      if (srv.upgrade(request)) return;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw)) as {
          id: string;
          type: string;
          payload?: { roomId?: string };
        };
        const reply = (payload: unknown) =>
          ws.send(JSON.stringify({ type: "ack", id: message.id, requestType: message.type, payload }));
        if (message.type === "room.create") {
          const roomId = message.payload?.roomId ?? "";
          order.push(`recv:${roomId}`);
          setTimeout(() => {
            order.push(`ack:${roomId}`);
            reply({
              roomId,
              playerId: `p-${roomId}`,
              sessionToken: `t-${roomId}`,
              snapshot: { roomId, phase: "waiting", players: [], chat: [] },
              privateState: { playerId: `p-${roomId}` },
            });
          }, ackDelayMs);
          return;
        }
        reply({});
      },
    },
  });
  servers.push(server);
  return { server, order };
};

const createRoomCall = (url: string, roomId: string, session?: string) =>
  rpc(
    url,
    {
      jsonrpc: "2.0",
      id: roomId,
      method: "tools/call",
      params: {
        name: "create_room",
        arguments: { game: "faker", roomId, name: "x", allowAgents: true },
      },
    },
    session
  );

test("同一会话并发的工具调用按到达顺序串行，不交错", async () => {
  const { server, order } = slowCreateServer(80);
  sessionsRef = newSessions(`http://127.0.0.1:${server.port}`);
  const url = `http://127.0.0.1:${server.port}/api/mcp`;
  const first = await createRoomCall(url, "1001");
  const session = first.headers["mcp-session-id"]!;
  order.length = 0;
  await Promise.all([createRoomCall(url, "2001", session), createRoomCall(url, "2002", session)]);
  // 串行：前一个建房的回执发出之后，后一个建房才会到达服务端。
  expect(order.filter((entry) => entry.startsWith("recv:") || entry.startsWith("ack:"))).toEqual([
    "recv:2001",
    "ack:2001",
    "recv:2002",
    "ack:2002",
  ]);
});

test("挂起的调用不会永久堵住同一会话：等待超时回 BUSY，持有超时后放行", async () => {
  const { server } = slowCreateServer(400);
  sessionsRef = new RemoteMcpSessions(logger, {
    selfUrl: `http://127.0.0.1:${server.port}`,
    siteUrl: "https://game.example.com",
    callWaitMs: 50,
    callHoldMaxMs: 120,
  });
  const url = `http://127.0.0.1:${server.port}/api/mcp`;
  const session = (await initialize("198.51.100.9")).headers["mcp-session-id"]!;
  const slow = createRoomCall(url, "3001", session);
  await Bun.sleep(10);
  const waiter = await createRoomCall(url, "3002", session);
  expect(waiter.payload.result.isError).toBe(true);
  expect(waiter.payload.result.content[0].text).toContain("BUSY");
  await slow;
  // 持有方结束后后续调用恢复正常，不留下死锁。
  const after = await createRoomCall(url, "3003", session);
  expect(after.payload.result.content[0].text).not.toContain("BUSY");
});

test("持有方超过持有上限会被强制放行，后续调用不必等它真正返回", async () => {
  const { server, order } = slowCreateServer(600);
  sessionsRef = new RemoteMcpSessions(logger, {
    selfUrl: `http://127.0.0.1:${server.port}`,
    siteUrl: "https://game.example.com",
    callWaitMs: 1000,
    callHoldMaxMs: 100,
  });
  const url = `http://127.0.0.1:${server.port}/api/mcp`;
  const session = (await initialize("198.51.100.9")).headers["mcp-session-id"]!;
  const stuck = createRoomCall(url, "4001", session);
  await Bun.sleep(10);
  const startedAt = performance.now();
  const next = createRoomCall(url, "4002", session);
  await Bun.sleep(250);
  // 第二个调用在持有上限（100ms）后就已发到服务端，而不是等满第一个的 600ms。
  expect(order).toContain("recv:4002");
  expect(performance.now() - startedAt).toBeLessThan(600);
  await Promise.all([stuck, next]);
});

test("JSON-RPC 通知不回响应，带 id 的未知方法才回错误；不认识的协议版本回默认版本", async () => {
  sessionsRef = newSessions();
  const url = "http://127.0.0.1:9/api/mcp";
  const notification = await rpc(url, { jsonrpc: "2.0", method: "notifications/roots/list_changed" });
  expect(notification.status).toBe(202);
  expect(notification.payload).toBeNull();

  const request = await rpc(url, { jsonrpc: "2.0", id: 7, method: "nope/nothing" });
  expect(request.payload.error).toMatchObject({ code: -32601 });
  expect(request.payload.id).toBe(7);

  const negotiated = await rpc(url, {
    jsonrpc: "2.0",
    id: 8,
    method: "initialize",
    params: { protocolVersion: "1999-01-01", clientInfo: { name: "v" } },
  });
  expect(negotiated.payload.result.protocolVersion).toBe("2025-06-18");
});

test("远程审计日志带动作、游戏、房间与来源摘要，不含原始来源地址", async () => {
  const records: unknown[] = [];
  const spy = new EventLogger(() => {}, undefined, undefined, undefined, {
    sinks: [{ write: (record) => void records.push(record) }],
  });
  const { server } = fakeFakerServer();
  sessionsRef = newSessions(`http://127.0.0.1:${server.port}`);
  await handleRemoteMcp(
    { enabled: true, sessions: sessionsRef, logger: spy },
    new Request("http://127.0.0.1:9/api/mcp", { method: "POST" }),
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_room",
        arguments: { game: "faker", roomId: "1234", name: "x", allowAgents: true },
      },
    },
    "198.51.100.7"
  );
  const entry = JSON.stringify(
    records.find((record) => JSON.stringify(record).includes("mcp.remote.tool\""))
  );
  expect(entry).toContain('"game":"faker"');
  expect(entry).toContain('"roomId":"1234"');
  expect(entry).toMatch(/"client":"[0-9a-f]{8}"/);
  expect(entry).not.toContain("198.51.100.7");
});
