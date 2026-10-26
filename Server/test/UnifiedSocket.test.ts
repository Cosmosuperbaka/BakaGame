import { expect, test } from "bun:test";

import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import type { AppEnv } from "../src/config/Env";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { CEEPayloadSchemas } from "../src/shared/CEE";
import { SonGuessrPayloadSchemas } from "../src/shared/SonGuessr";
import { WhoIsFakerPayloadSchemas } from "../src/shared/WhoIsFaker";
import { gameOfMessage } from "../src/transport/UnifiedSocket";
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
  const { app } = createTestApp({ env: baseEnv(overrides), whoIsFakerService, logger });
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
    expect((await subscribed).payload).toEqual({ subscribed: true });
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
  expect(gameOfMessage({ type: "mcp.focus", game: "cee" })).toBe("cee");
  expect(gameOfMessage({ type: "song.room.join" })).toBe("song");
  expect(gameOfMessage({ type: "cee.game.guess" })).toBe("cee");
  expect(gameOfMessage({ type: "room.join" })).toBe("faker");
  expect(gameOfMessage(null)).toBe("faker");
});

/** 三款游戏同名、只能靠信封上的 `game` 区分的控制命令（客户端一条都不发，只有 Agent 用）。 */
const SHARED_CONTROL_COMMANDS = new Set(["mcp.claim", "mcp.release", "mcp.focus"]);

/**
 * 归属推断要么靠前缀，要么靠显式 `game`，没有第三条路。
 *
 * 这条断言的价值在将来：给歌或角色游戏加一条忘带前缀的命令，它会静默落到卧底服务里，
 * 症状是「命令发出去没反应」而不是报错。命令表是唯一真相源，所以直接拿表来断言。
 */
test("命令表与归属推断一致：无前缀的命令只允许出现在卧底", () => {
  for (const type of Object.keys(SonGuessrPayloadSchemas)) {
    if (SHARED_CONTROL_COMMANDS.has(type)) continue;
    expect({ type, game: gameOfMessage({ type }) }).toEqual({ type, game: "song" });
  }
  for (const type of Object.keys(CEEPayloadSchemas)) {
    if (SHARED_CONTROL_COMMANDS.has(type)) continue;
    expect({ type, game: gameOfMessage({ type }) }).toEqual({ type, game: "cee" });
  }
  for (const type of Object.keys(WhoIsFakerPayloadSchemas)) {
    if (SHARED_CONTROL_COMMANDS.has(type)) continue;
    expect({ type, game: gameOfMessage({ type }) }).toEqual({ type, game: "faker" });
  }
});
