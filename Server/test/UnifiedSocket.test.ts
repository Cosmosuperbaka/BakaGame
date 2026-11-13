import { expect, test } from "bun:test";

import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import type { AppEnv } from "../src/config/Env";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { CEEPayloadSchemas } from "../src/shared/CEE";
import { SonGuessrPayloadSchemas } from "../src/shared/SonGuessr";
import { WhoIsFakerPayloadSchemas } from "../src/shared/WhoIsFaker";
import { gameOfMessage } from "../src/transport/GameEndpoints";
import { createTestApp } from "./AppFixtures";

const baseEnv = (overrides: Partial<AppEnv> = {}): AppEnv => ({
  maintenanceToken: "test-maintenance-token",
  clientUrl: "http://localhost:5173",
  serverUrl: "http://127.0.0.1",
  serverListenHost: "127.0.0.1",
  serverPort: 0,
  bangumiApiUrl: "https://api.bgm.tv",
  bangumiImageUrl: "",
  ...overrides,
});

const start = (overrides: Partial<AppEnv> = {}) => {
  const logger = new EventLogger();
  const whoIsFakerService = new WhoIsFakerService({ eventLogger: logger });
  const { app } = createTestApp({
    env: baseEnv(overrides),
    games: { faker: whoIsFakerService },
    logger,
  });
  const started = app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = started.server?.port;
  if (!port) throw new Error("未能获取测试端口");
  return { port, stop: () => started.stop(true) };
};

const openSocket = (port: number, path = "/api/ws") =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    socket.addEventListener("open", () => resolve(socket));
    socket.addEventListener("error", () => reject(new Error("连接失败")));
  });

interface Envelope {
  type: string;
  id?: string;
  event?: string;
  payload?: Record<string, unknown>;
  error?: { code?: string };
}

/** 先挂监听再发送：服务器的第一帧可能比断言代码更早到达。 */
const nextMessage = (
  socket: WebSocket,
  predicate: (message: Envelope) => boolean,
  timeoutMs = 3_000
) =>
  new Promise<Envelope>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("等待消息超时"));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Envelope;
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
  });

const send = (socket: WebSocket, message: Record<string, unknown>) =>
  socket.send(JSON.stringify(message));

test("统一入口按命令前缀分发：同一条连接先卧底后猜歌都能拿到大厅回执", async () => {
  const { port, stop } = start();

  try {
    const socket = await openSocket(port);
    const fakerAck = nextMessage(socket, (m) => m.type === "ack" && m.id === "faker-1");
    send(socket, { id: "faker-1", type: "lobby.subscribeRooms", payload: {} });
    expect((await fakerAck).payload).toEqual({ subscribed: true });

    const songAck = nextMessage(socket, (m) => m.type === "ack" && m.id === "song-1");
    send(socket, { id: "song-1", type: "song.lobby.subscribeRooms", payload: {} });
    expect((await songAck).payload).toEqual({ subscribed: true });

    const ceeAck = nextMessage(socket, (m) => m.type === "ack" && m.id === "cee-1");
    send(socket, { id: "cee-1", type: "cee.lobby.subscribeRooms", payload: {} });
    expect((await ceeAck).payload).toMatchObject({ originalAvailable: false, rooms: [] });

    socket.close();
  } finally {
    await stop();
  }
});

interface TabClaimPayload {
  token: string;
  rotated: boolean;
  serverEpoch: string;
}

let requestCounter = 0;

/** 发一条命令并等它的 ack 或 error；用例关心的是回包，不关心中间的事件。 */
const request = async (socket: WebSocket, type: string, payload: object, roomId?: string) => {
  const id = `tab-${(requestCounter += 1)}`;
  const reply = nextMessage(socket, (m) => (m.type === "ack" || m.type === "error") && m.id === id);
  send(socket, { id, type, payload, ...(roomId ? { roomId } : {}) });
  return reply;
};

const claimTab = async (socket: WebSocket, token?: string) => {
  const reply = await request(socket, "site.session.claim", token ? { token } : {});
  return reply.payload as unknown as TabClaimPayload;
};

/** 一张标签页：站点连接领取身份，游戏连接挂上同一身份。 */
const openTab = async (port: number, token?: string) => {
  const site = await openSocket(port);
  const claim = await claimTab(site, token);
  const game = await openSocket(port);
  const attached = await request(game, "site.session.attach", { token: claim.token });
  expect(attached.payload).toEqual({ attached: true, serverEpoch: claim.serverEpoch });
  return { site, game, claim };
};

const closeSocket = (socket: WebSocket) =>
  new Promise<void>((resolve) => {
    socket.addEventListener("close", () => setTimeout(resolve, 20));
    socket.close();
  });

const createFakerRoom = (socket: WebSocket, roomId: string) =>
  request(socket, "room.create", {
    roomId,
    name: "房间",
    visibility: "public",
    allowSpectators: true,
    userName: "房主",
  });

test("站点连接分配身份，游戏连接挂上后刷新回到原座位", async () => {
  const { port, stop } = start();

  try {
    const hostTab = await openTab(port);
    await createFakerRoom(hostTab.game, "1234");

    const tab = await openTab(port);
    const joined = await request(tab.game, "room.join", { userName: "访客" }, "1234");
    expect(joined.payload?.playerId).toMatch(/^tab_/);

    // 刷新：两条连接都断开，新页面带原令牌回来。
    await closeSocket(tab.game);
    await closeSocket(tab.site);
    const refreshed = await openTab(port, tab.claim.token);
    expect(refreshed.claim).toMatchObject({ token: tab.claim.token, rotated: false });

    const resumed = await request(refreshed.game, "room.reconnect", {
      roomId: "1234",
      sessionToken: joined.payload?.sessionToken,
    });
    expect(resumed.payload?.playerId).toBe(joined.payload?.playerId);
  } finally {
    await stop();
  }
});

test("复制标签页：两条站点连接同时在线时，后来者换新身份且不影响原标签页的座位", async () => {
  const { port, stop } = start();

  try {
    const original = await openTab(port);
    await createFakerRoom(original.game, "1234");

    // 原页面按协议应答探测：这正是「还开着」与「刷新残留」的区别。
    original.site.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Envelope;
      if (message.event !== "site.session.probe") return;
      send(original.site, {
        id: "alive-1",
        type: "site.session.alive",
        payload: { nonce: message.payload?.nonce },
      });
    });

    const copied = await openSocket(port);
    const claim = await claimTab(copied, original.claim.token);
    expect(claim.rotated).toBe(true);
    expect(claim.token).not.toBe(original.claim.token);

    const ping = await request(original.game, "room.requestSync", {});
    expect(ping.type).toBe("ack");
  } finally {
    await stop();
  }
});

test("身份绑定有边界：畸形令牌被拒、一条连接只绑一次、Agent 不持有标签页身份", async () => {
  const { port, stop } = start({ mcpEnabled: true });

  try {
    const socket = await openSocket(port);
    const malformed = await request(socket, "site.session.claim", { token: "short" });
    expect(malformed.error?.code).toBe("INVALID_MESSAGE");

    const extra = await request(socket, "site.session.claim", { token: undefined, name: "x" });
    expect(extra.error?.code).toBe("INVALID_MESSAGE");

    const { token } = await claimTab(socket);
    const rebind = await request(socket, "site.session.attach", { token });
    expect(rebind.error?.code).toBe("TAB_SESSION_BOUND");

    const agent = await openSocket(port, "/api/ws?agent=1");
    const claimed = await request(agent, "site.session.claim", {});
    expect(claimed.error?.code).toBe("TAB_SESSION_FORBIDDEN");
    const attached = await request(agent, "site.session.attach", { token });
    expect(attached.error?.code).toBe("TAB_SESSION_FORBIDDEN");
  } finally {
    await stop();
  }
});

test("标签页令牌与身份键不随任何下行帧发给房间里的其他人", async () => {
  const { port, stop } = start();

  try {
    const hostTab = await openTab(port);
    await createFakerRoom(hostTab.game, "1234");
    const frames: string[] = [];
    hostTab.game.addEventListener("message", (event) => frames.push(String(event.data)));

    const tab = await openTab(port);
    const ownFrames: string[] = [];
    tab.game.addEventListener("message", (event) => ownFrames.push(String(event.data)));
    await request(tab.game, "room.join", { userName: "访客" }, "1234");
    const chatted = await request(tab.game, "chat.send", { text: "你好" }, "1234");
    expect(chatted.type).toBe("ack");
    await request(hostTab.game, "room.requestSync", {}, "1234");

    const { createHash } = await import("node:crypto");
    const key = createHash("sha256").update(tab.claim.token).digest("hex");
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of [...frames, ...ownFrames]) {
      expect(frame).not.toContain(tab.claim.token);
      expect(frame).not.toContain(key);
    }
    // 别人的座位凭证同样不随公开帧下发。
    const seatTokens = ownFrames
      .map((frame) => (JSON.parse(frame) as Envelope).payload?.sessionToken)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    expect(seatTokens.length).toBeGreaterThan(0);
    for (const frame of frames) for (const seat of seatTokens) expect(frame).not.toContain(seat);
  } finally {
    await stop();
  }
});

test("不带标签页身份的旧客户端在统一入口与旧路径上都照常入房", async () => {
  const { port, stop } = start();

  try {
    const legacy = await openSocket(port);
    const created = await createFakerRoom(legacy, "1234");
    expect(created.payload?.playerId).toMatch(/^player_/);

    const oldPath = await openSocket(port, "/api/whoisfaker/ws");
    const joined = await request(oldPath, "room.join", { userName: "访客" }, "1234");
    expect(joined.type).toBe("ack");
    expect(joined.payload?.playerId).toMatch(/^player_/);
  } finally {
    await stop();
  }
});

test("统一入口保留各游戏的严格校验与可归因错误包", async () => {
  const { port, stop } = start();

  try {
    const socket = await openSocket(port);
    const failed = nextMessage(socket, (m) => m.type === "error" && m.id === "bad-1");
    send(socket, { id: "bad-1", type: "song.room.join", payload: { roomId: "" } });
    const packet = await failed;
    expect(packet.error?.code).toBe("INVALID_MESSAGE");

    const unknown = nextMessage(socket, (m) => m.type === "error" && m.id === "bad-2");
    send(socket, { id: "bad-2", type: "song.notACommand", payload: {} });
    expect((await unknown).error?.code).toBe("UNKNOWN_MESSAGE_TYPE");

    socket.close();
  } finally {
    await stop();
  }
});

test("站点通道：订阅者收到快照，Agent 焦点广播到首页，且封闭字段拒绝输入内容", async () => {
  const { port, stop } = start({ mcpEnabled: true });

  try {
    const viewer = await openSocket(port);
    const snapshot = nextMessage(viewer, (m) => m.type === "event" && m.event === "site.agents");
    const subscribed = nextMessage(viewer, (m) => m.type === "ack" && m.id === "sub-1");
    send(viewer, { id: "sub-1", type: "site.subscribe", payload: {} });
    expect((await subscribed).payload).toEqual({ subscribed: true, controlled: false });
    expect((await snapshot).payload).toEqual({ agents: [] });

    const agent = await openSocket(port, "/api/ws?agent=1");
    const activity = nextMessage(viewer, (m) => m.type === "event" && m.event === "site.agent");
    const focused = nextMessage(agent, (m) => m.type === "ack" && m.id === "focus-1");
    send(agent, {
      id: "focus-1",
      type: "site.focus",
      payload: { agentName: "BakaAgent", tool: "visit_page", kind: "site", page: "/abouts" },
    });
    expect((await focused).payload).toEqual({ ok: true });
    expect((await activity).payload).toMatchObject({
      agentName: "BakaAgent",
      tool: "visit_page",
      kind: "site",
      page: "/abouts",
    });

    // 房间内的输入进度不属于站点广播：封闭 schema 直接拒绝，避免首页泄露搜索词。
    const leaked = nextMessage(agent, (m) => m.type === "error" && m.id === "focus-2");
    send(agent, {
      id: "focus-2",
      type: "site.focus",
      payload: { agentName: "BakaAgent", tool: "ui_run", kind: "guess", input: "答案" },
    });
    expect((await leaked).error?.code).toBe("INVALID_MESSAGE");

    agent.close();
    viewer.close();
  } finally {
    await stop();
  }
});

test("未声明为 Agent 的连接不能上报站点焦点", async () => {
  const { port, stop } = start({ mcpEnabled: true });

  try {
    const human = await openSocket(port);
    const refused = nextMessage(human, (m) => m.type === "error" && m.id === "focus-human");
    send(human, {
      id: "focus-human",
      type: "site.focus",
      payload: { agentName: "冒充者", tool: "visit_page", kind: "site" },
    });
    expect((await refused).error?.code).toBe("AGENT_REQUIRED");
    human.close();
  } finally {
    await stop();
  }
});

test("命令归属：显式 game 优先，其次按前缀推断，卧底命令无需前缀", () => {
  expect(gameOfMessage({ type: "room.join", game: "cee" })).toBe("cee");
  expect(gameOfMessage({ type: "song.room.join" })).toBe("song");
  expect(gameOfMessage({ type: "cee.game.guess" })).toBe("cee");
  expect(gameOfMessage({ type: "room.join" })).toBe("faker");
  expect(gameOfMessage(null)).toBe("faker");
});

/**
 * 归属推断要么靠前缀，要么靠显式 `game`，没有第三条路。
 *
 * 这条断言的价值在将来：给歌或角色游戏加一条忘带前缀的命令，它会静默落到卧底服务里，
 * 症状是「命令发出去没反应」而不是报错。命令表是唯一真相源，所以直接拿表来断言。
 */
test("命令表与归属推断一致：无前缀的命令只允许出现在卧底", () => {
  for (const type of Object.keys(SonGuessrPayloadSchemas)) {
    expect({ type, game: gameOfMessage({ type }) }).toEqual({ type, game: "song" });
  }
  for (const type of Object.keys(CEEPayloadSchemas)) {
    expect({ type, game: gameOfMessage({ type }) }).toEqual({ type, game: "cee" });
  }
  for (const type of Object.keys(WhoIsFakerPayloadSchemas)) {
    expect({ type, game: gameOfMessage({ type }) }).toEqual({ type, game: "faker" });
  }
});
