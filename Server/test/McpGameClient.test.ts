import { afterEach, describe, expect, test } from "bun:test";

import { AgentGameClient, applyStateSync, gameOfEvent } from "../src/mcp/GameClient";

interface Inbound {
  id?: string;
  type?: string;
  game?: string;
  roomId?: string;
  sessionToken?: string;
  payload?: Record<string, unknown>;
}

interface Outbound {
  /** 回给这条命令的 ack / error；返回 undefined 表示不回话，用于测超时。 */
  reply?: { type: "ack"; payload?: unknown } | { type: "error"; error: Record<string, unknown> };
  /** 回执之后顺带推给客户端的事件帧。 */
  events?: Array<{ event: string; payload?: unknown }>;
}

interface MockSocket {
  origin: string;
  inbound: Inbound[];
  /** 换掉命令应答；返回 undefined 即让命令悬着。 */
  route(handler: (message: Inbound) => Outbound | undefined): void;
  /** 服务端主动推一帧事件。 */
  push(event: string, payload?: unknown): void;
  /** 服务端掐断连接，模拟掉线。 */
  drop(): void;
  stop(): void;
}

const startMockSocket = async (): Promise<MockSocket> => {
  const inbound: Inbound[] = [];
  let clients: Array<{ send(data: string): void; close(): void }> = [];
  let handler: (message: Inbound) => Outbound | undefined = () => ({
    reply: { type: "ack", payload: { ok: true, ...roomAck() } },
  });

  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path !== "/api/ws") return new Response("not found", { status: 404 });
      if (new URL(request.url).searchParams.get("agent") !== "1")
        return new Response("upgrade denied", { status: 426 });
      const ok = server.upgrade(request);
      return ok ? undefined : new Response("upgrade failed", { status: 426 });
    },
    websocket: {
      open(socket) {
        clients = [...clients, socket as never];
      },
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as Inbound;
        inbound.push(message);
        const outcome = handler(message);
        if (!outcome) return;
        if (outcome.reply && message.id)
          socket.send(JSON.stringify({ ...outcome.reply, id: message.id }));
        for (const event of outcome.events ?? [])
          socket.send(
            JSON.stringify({ type: "event", event: event.event, payload: event.payload })
          );
      },
      close(socket) {
        clients = clients.filter((entry) => entry !== socket);
      },
    },
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    inbound,
    route: (next) => {
      handler = next;
    },
    push: (event, payload) => {
      for (const client of clients) client.send(JSON.stringify({ type: "event", event, payload }));
    },
    drop: () => {
      for (const client of clients) client.close();
      clients = [];
    },
    stop: () => {
      void server.stop(true);
    },
  };
};

const clients: AgentGameClient[] = [];
const sockets: MockSocket[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const socket of sockets.splice(0)) socket.stop();
});

const harness = async () => {
  const socket = await startMockSocket();
  sockets.push(socket);
  const client = new AgentGameClient({ serverUrl: socket.origin, agentName: "TestAgent" });
  clients.push(client);
  return { socket, client };
};

const roomAck = (overrides: Record<string, unknown> = {}) => ({
  roomId: "1234",
  sessionToken: "seat-token",
  playerId: "p1",
  privateState: { playerId: "p1", word: "苹果" },
  snapshot: { roomId: "1234", phase: "waiting" },
  ...overrides,
});

describe("MCP 游戏客户端（真实 WebSocket）", () => {
  test("大厅列表先订阅再读取，事件帧落到对应游戏的会话上", async () => {
    const { socket, client } = await harness();
    socket.route((message) =>
      message.type === "song.lobby.subscribeRooms"
        ? {
            reply: { type: "ack", payload: { ok: true } },
            events: [
              {
                event: "song.lobby.rooms",
                payload: [
                  { roomId: "1234", name: "开放房", allowAgents: true },
                  { roomId: "5678", name: "人类房", allowAgents: false },
                ],
              },
            ],
          }
        : { reply: { type: "ack", payload: {} } }
    );

    const rooms = await client.listRooms("song");
    expect(rooms).toHaveLength(2);
    expect(socket.inbound[0]).toMatchObject({ type: "song.lobby.subscribeRooms", game: "song" });
    expect(socket.inbound[0]?.id).toEqual(expect.any(String));
    expect(socket.inbound[0]?.payload).toEqual({});
  });

  test("建房带上房间号与座位凭据，公开快照随后作为事件补上", async () => {
    const { socket, client } = await harness();
    socket.route((message) =>
      message.type === "song.room.create"
        ? {
            reply: { type: "ack", payload: roomAck({ snapshot: undefined }) },
            events: [
              { event: "song.room.snapshot", payload: { roomId: "1234", phase: "waiting" } },
            ],
          }
        : { reply: { type: "ack", payload: {} } }
    );

    const joined = await client.create("song", "1234", {
      name: "测试房",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
      solo: true,
      password: "pw",
    });
    expect(joined).toMatchObject({ game: "song", roomId: "1234", playerId: "p1" });
    expect(client.currentRoom("song")).toBe("1234");
    expect(client.currentSnapshot("song")).toMatchObject({ phase: "waiting" });
    expect(client.currentPrivateState("song")).toMatchObject({ word: "苹果" });

    const payload = socket.inbound[0]?.payload;
    expect(payload).toMatchObject({ solo: true, password: "pw", roomId: "1234" });
  });

  test("猜角色建房固定走原生题库来源，卧底建房才带角色配置", async () => {
    const { socket, client } = await harness();
    await client.create("cee", "1234", {
      name: "c",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
    });
    expect(socket.inbound[0]?.payload).toMatchObject({ source: "native" });
    expect(socket.inbound[0]?.type).toBe("cee.room.create");

    socket.inbound.length = 0;
    await client.create("faker", "1234", {
      name: "f",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
      roleConfig: { undercoverCount: 2 },
    });
    expect(socket.inbound[0]?.payload).toMatchObject({ roleConfig: { undercoverCount: 2 } });
    expect(socket.inbound[0]?.payload).not.toMatchObject({ solo: true });
  });

  test("同一房间重复加入直接复用座位，换房先离开", async () => {
    const { socket, client } = await harness();
    await client.create("faker", "1234", {
      name: "f",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
    });
    const again = await client.join("faker", "1234");
    expect(again.roomId).toBe("1234");
    expect(socket.inbound.map((message) => message.type)).toEqual(["room.create"]);

    await client.join("faker", "5678", { name: "改名", password: "pw" });
    expect(socket.inbound.map((message) => message.type)).toEqual([
      "room.create",
      "room.leave",
      "room.join",
    ]);
    expect(socket.inbound[2]?.payload).toMatchObject({ userName: "改名", password: "pw" });
    expect(socket.inbound[2]?.roomId).toBe("5678");
  });

  test("离开房间清掉座位，未进房时离开是空操作", async () => {
    const { client } = await harness();
    expect(await client.leave("faker")).toBe(false);

    await client.create("faker", "1234", {
      name: "f",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
    });
    expect(await client.leave("faker")).toBe(true);
    expect(client.currentRoom("faker")).toBeUndefined();
    expect(client.currentSnapshot("faker")).toBeUndefined();
  });

  test("进房回执缺少凭据时报错，不把无座位的连接当已加入", async () => {
    const { socket, client } = await harness();
    socket.route(() => ({ reply: { type: "ack", payload: null } }));
    await expect(
      client.create("faker", "1234", {
        name: "f",
        visibility: "public",
        allowSpectators: true,
        allowAgents: true,
        userName: "TestAgent",
      })
    ).rejects.toThrow("进入房间没有返回会话凭据");
  });

  test("认领人类座位后凭据登记在案，回缺房间号时报错", async () => {
    const { socket, client } = await harness();
    socket.route((message) =>
      message.type === "mcp.claim"
        ? {
            reply: {
              type: "ack",
              payload: { roomId: "1234", playerId: "p9", sessionToken: "t9", snapshot: { a: 1 } },
            },
          }
        : { reply: { type: "ack", payload: {} } }
    );
    const claimed = await client.claimSeat("faker", "1234", "human-token");
    expect(claimed).toMatchObject({ roomId: "1234", playerId: "p9" });
    expect(client.currentSnapshot("faker")).toEqual({ a: 1 });
    expect(socket.inbound[0]?.payload).toMatchObject({ sessionToken: "human-token" });

    socket.route(() => ({ reply: { type: "ack", payload: { ok: true } } }));
    await expect(client.claimSeat("faker", "5678", "t")).rejects.toThrow("没有返回房间凭据");
  });

  test("游戏命令带座位信封，未进房时拒绝发送", async () => {
    const { socket, client } = await harness();
    await expect(client.sendInRoom("song", "song.game.start")).rejects.toThrow(
      "尚未加入该游戏的房间"
    );

    await client.create("song", "1234", {
      name: "s",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
    });
    socket.inbound.length = 0;
    await client.sendInRoom("song", "song.game.guess", { songId: "netease:1" });
    expect(socket.inbound[0]).toMatchObject({
      type: "song.game.guess",
      game: "song",
      roomId: "1234",
      sessionToken: "seat-token",
    });
  });

  test("服务端拒绝命令时把错误码带到异常上", async () => {
    const { socket, client } = await harness();
    socket.route(() => ({
      reply: { type: "error", error: { code: "ROOM_CLOSED", message: "房间已关闭" } },
    }));
    const failure = await client
      .create("faker", "1234", {
        name: "f",
        visibility: "public",
        allowSpectators: true,
        allowAgents: true,
        userName: "TestAgent",
      })
      .catch((error: unknown) => error as Error & { code?: string });
    if (!(failure instanceof Error)) throw new Error("进房应当以异常失败");
    expect(failure.message).toBe("房间已关闭");
    expect(failure.code).toBe("ROOM_CLOSED");
  });

  test("拒绝帧没有可读消息时退回统一文案", async () => {
    const { socket, client } = await harness();
    await client.create("faker", "1234", {
      name: "f",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
    });
    socket.route(() => ({ reply: { type: "error", error: { code: "NOPE" } } }));
    await expect(client.sendInRoom("faker", "game.advancePhase")).rejects.toThrow(
      "游戏服务拒绝了命令"
    );
  });

  test("命令悬空时按超时失败，不留下待回执登记", async () => {
    const { socket, client } = await harness();
    await client.create("faker", "1234", {
      name: "f",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
    });
    socket.route(() => undefined);
    const started = client.stateVersion("faker");
    await expect(client.waitForStateChange("faker", started, 40)).resolves.toBe(false);
    // 悬空命令不会把后续操作一起拖死：换一条仍然能正常回执。
    socket.route(() => ({ reply: { type: "ack", payload: { ok: true } } }));
    await expect(client.sendInRoom("faker", "game.advancePhase")).resolves.toMatchObject({
      ok: true,
    });
  });

  test("主动同步会等到本人私有状态再返回", async () => {
    const { socket, client } = await harness();
    await client.create("song", "1234", {
      name: "s",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
    });
    socket.route((message) =>
      message.type === "song.room.requestSync"
        ? {
            reply: { type: "ack", payload: { synced: true } },
            events: [
              { event: "song.game.privateState", payload: { roomId: "1234", canGuess: true } },
            ],
          }
        : { reply: { type: "ack", payload: {} } }
    );
    expect(await client.requestSync("song")).toEqual({ synced: true });
    expect(client.currentPrivateState("song")).toMatchObject({ canGuess: true });
  });

  test("界面焦点逐游戏上报，站点通道不带游戏归属", async () => {
    const { socket, client } = await harness();
    await client.create("song", "1234", {
      name: "s",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
    });
    socket.inbound.length = 0;
    await client.publishAgentFocus({
      agentName: "TestAgent",
      tool: "ui_run",
      action: "focus",
      kind: "state",
    });
    expect(socket.inbound[0]).toMatchObject({ type: "mcp.focus", game: "song", roomId: "1234" });

    socket.inbound.length = 0;
    await client.publishSiteFocus({ page: "/abouts", kind: "page" } as never);
    expect(socket.inbound[0]).toMatchObject({ type: "site.focus" });
    expect(socket.inbound[0]).not.toHaveProperty("game");
  });

  test("焦点上报被拒绝也不阻断工具返回", async () => {
    const { socket, client } = await harness();
    await client.create("song", "1234", {
      name: "s",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
    });
    socket.route(() => ({ reply: { type: "error", error: { message: "拒绝" } } }));
    await expect(
      client.publishAgentFocus({
        agentName: "TestAgent",
        tool: "ui_run",
        action: "focus",
        kind: "state",
      })
    ).resolves.toBeUndefined();
  });

  test("掉线后靠座位凭据接回原位", async () => {
    const { socket, client } = await harness();
    await client.create("faker", "1234", {
      name: "f",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
    });
    socket.route((message) =>
      message.type === "room.reconnect"
        ? {
            reply: {
              type: "ack",
              payload: { roomId: "1234", sessionToken: "t2", privateState: { playerId: "p7" } },
            },
          }
        : { reply: { type: "ack", payload: { ok: true } } }
    );
    socket.drop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    socket.inbound.length = 0;

    await client.sendInRoom("faker", "game.advancePhase");
    const types = socket.inbound.map((message) => message.type);
    expect(types[0]).toBe("room.reconnect");
    expect(socket.inbound[0]?.payload).toMatchObject({ sessionToken: "seat-token" });
    expect(client.currentPlayerId("faker")).toBe("p7");
  });

  test("凭据失效时丢弃座位，下一次连接不再尝试接回", async () => {
    const { socket, client } = await harness();
    await client.create("faker", "1234", {
      name: "f",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
    });
    socket.route((message) =>
      message.type === "room.reconnect"
        ? { reply: { type: "error", error: { code: "SESSION_INVALID", message: "凭据失效" } } }
        : { reply: { type: "ack", payload: { ok: true } } }
    );
    socket.drop();
    await new Promise((resolve) => setTimeout(resolve, 60));

    await expect(client.sendInRoom("faker", "game.advancePhase")).rejects.toThrow("凭据失效");
    // 座位已被丢弃：下一次连接不再尝试接回，而是直接以无座位状态发命令。
    socket.inbound.length = 0;
    await client.sendInRoom("faker", "game.advancePhase");
    expect(socket.inbound.map((message) => message.type)).toEqual(["game.advancePhase"]);
  });

  test("网络抖动不算凭据失效，座位留给下一次重试", async () => {
    const { socket, client } = await harness();
    await client.create("faker", "1234", {
      name: "f",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
    });
    socket.route((message) =>
      message.type === "room.reconnect"
        ? { reply: { type: "error", error: { code: "UPSTREAM_BUSY", message: "上游繁忙" } } }
        : { reply: { type: "ack", payload: { ok: true, ...roomAck() } } }
    );
    socket.drop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(client.sendInRoom("faker", "game.advancePhase")).rejects.toThrow("上游繁忙");

    socket.inbound.length = 0;
    // 座位还在：下一次调用仍先尝试接回原位，而不是直接以无座位状态发命令。
    await expect(client.sendInRoom("faker", "game.advancePhase")).rejects.toThrow("上游繁忙");
    expect(socket.inbound[0]?.type).toBe("room.reconnect");
  });

  test("房间关闭事件清掉座位状态并推进版本", async () => {
    const { socket, client } = await harness();
    await client.create("song", "1234", {
      name: "s",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
    });
    const before = client.stateVersion("song");
    socket.push("song.room.closed", { roomId: "1234" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(client.currentRoom("song")).toBeUndefined();
    expect(client.stateVersion("song")).toBe(before + 1);
  });

  test("聊天增量按 id 合并并截断到窗口上限", async () => {
    const { socket, client } = await harness();
    await client.create("song", "1234", {
      name: "s",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
    });
    socket.push("song.room.snapshot", { mode: "full", state: { roomId: "1234", chat: [] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let index = 0; index < 205; index++)
      socket.push("song.chat.message", { message: { id: `m${index}`, text: `消息${index}` } });
    socket.push("song.chat.message", { message: { id: "m204", text: "改写最后一条" } });
    await new Promise((resolve) => setTimeout(resolve, 120));

    const chat = (client.currentSnapshot("song")?.chat ?? []) as Array<{
      id: string;
      text: string;
    }>;
    expect(chat).toHaveLength(200);
    expect(chat.at(-1)).toMatchObject({ id: "m204", text: "改写最后一条" });
    expect(chat[0]).toMatchObject({ id: "m5" });
  });

  test("没有快照时收到房间关闭帧不会凭空造出快照", async () => {
    const { socket, client } = await harness();
    socket.route((message) =>
      message.type === "cee.lobby.subscribeRooms"
        ? {
            reply: { type: "ack", payload: { ok: true } },
            events: [{ event: "cee.lobby.rooms", payload: [] }],
          }
        : { reply: { type: "ack", payload: { ok: true } } }
    );
    await client.listRooms("cee");
    expect(client.currentSnapshot("cee")).toBeUndefined();
    const before = client.stateVersion("cee");
    socket.push("cee.room.closed", { roomId: "1234" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(client.currentSnapshot("cee")).toBeUndefined();
    expect(client.stateVersion("cee")).toBe(before + 1);
  });

  test("状态版本等待在超时后如实回报未变化", async () => {
    const { client } = await harness();
    await client.create("faker", "1234", {
      name: "f",
      visibility: "public",
      allowSpectators: true,
      allowAgents: true,
      userName: "TestAgent",
    });
    expect(await client.waitForStateChange("cee", 0, 40)).toBe(false);
    expect(await client.waitForStateChange("faker", client.stateVersion("faker"), 40)).toBe(false);
    expect(client.stateVersion("cee")).toBe(0);
  });

  test("连接被服务端拒绝时报错指向 MCP 开关", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 500 }) });
    try {
      const client = new AgentGameClient({
        serverUrl: `http://127.0.0.1:${server.port}`,
        agentName: "TestAgent",
      });
      clients.push(client);
      await expect(client.listRooms("faker")).rejects.toThrow(/MCP_ENABLED|连接已关闭|无法连接/);
    } finally {
      void server.stop(true);
    }
  });

  test("站点地址与游戏事件归属按前缀判定", () => {
    const client = new AgentGameClient({ serverUrl: "https://example.com/", agentName: "A" });
    clients.push(client);
    expect(client.siteOrigin).toBe("https://example.com");
    expect(client.name).toBe("A");
    expect(gameOfEvent("song.game.start")).toBe("song");
    expect(gameOfEvent("cee.room.snapshot")).toBe("cee");
    expect(gameOfEvent("room.snapshot")).toBe("faker");
    expect(client.currentRoom("faker")).toBeUndefined();
    expect(client.currentPrivateState("faker")).toBeUndefined();
  });

  test("未连接时关闭连接与焦点上报都是安全的空操作", async () => {
    const client = new AgentGameClient({ agentName: "A" });
    clients.push(client);
    expect(() => client.close()).not.toThrow();
    await expect(
      client.publishSiteFocus({ page: "/", kind: "page" } as never)
    ).resolves.toBeUndefined();
  });
});

describe("快照合并", () => {
  test("整帧替换、差量应用与不认识的形状原样保留", () => {
    const base = { roomId: "1234", players: [{ id: "p1", score: 0 }], chat: [] };
    expect(
      applyStateSync(base, { mode: "full", state: { roomId: "1234", phase: "playing" } })
    ).toEqual({ roomId: "1234", phase: "playing" });
    expect(
      applyStateSync(base, {
        mode: "patch",
        operations: [{ op: "replace", path: "/players/0/score", value: 9 }],
      })
    ).toMatchObject({ players: [{ id: "p1", score: 9 }] });
    // 差量打不上时保留旧快照，不让一次坏帧把整屏清空。
    expect(
      applyStateSync(base, {
        mode: "patch",
        operations: [{ op: "replace", path: "/nope/x", value: 1 }],
      })
    ).toEqual(base);
    expect(applyStateSync(base, { roomId: "5678" })).toEqual({ roomId: "5678" });
    expect(applyStateSync(base, "not-a-record")).toBe(base);
    expect(applyStateSync(undefined, { mode: "patch", operations: [] })).toBeUndefined();
  });
});
