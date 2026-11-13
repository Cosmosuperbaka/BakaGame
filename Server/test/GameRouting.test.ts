import { expect, test } from "bun:test";

import type { GameServices } from "../src/application/GameRegistry";
import type { AppEnv } from "../src/config/Env";
import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { GAME_IDS, type GameId } from "../src/shared/Protocol";
import { createTestApp } from "./AppFixtures";

/**
 * 统一入口对三款游戏的按款路由：连接登记与注销、站点页准入与发布。
 * 全部经真实应用与真实连接驱动，断言落在各款服务的连接计数、认领结果与下行帧上；
 * 把任何一处写死成别的款，或少访问一款，都必须让对应用例变红。
 */
const baseEnv = (): AppEnv => ({
  maintenanceToken: "test-maintenance-token",
  clientUrl: "http://localhost:5173",
  serverUrl: "http://127.0.0.1",
  serverListenHost: "127.0.0.1",
  serverPort: 0,
  bangumiApiUrl: "https://api.bgm.tv",
  bangumiImageUrl: "",
  mcpEnabled: true,
});

const start = () => {
  const logger = new EventLogger();
  const { app, games } = createTestApp({
    env: baseEnv(),
    games: { faker: new WhoIsFakerService({ eventLogger: logger }) },
    logger,
  });
  const started = app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = started.server?.port;
  if (!port) throw new Error("未能获取测试端口");
  return { port, games: games as GameServices, stop: () => started.stop(true) };
};

interface Envelope {
  type: string;
  id?: string;
  payload?: Record<string, unknown>;
  error?: { code?: string };
}

const openSocket = (port: number) =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    socket.addEventListener("open", () => resolve(socket));
    socket.addEventListener("error", () => reject(new Error("连接失败")));
  });

/** 先挂监听再发送：服务器的第一帧可能比断言代码更早到达。 */
const nextMessage = (socket: WebSocket, predicate: (message: Envelope) => boolean, ms = 3_000) =>
  new Promise<Envelope>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("等待消息超时"));
    }, ms);
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as Envelope;
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
  });

let counter = 0;
const request = (socket: WebSocket, type: string, payload: object) => {
  const id = `r-${(counter += 1)}`;
  const reply = nextMessage(
    socket,
    (message) => (message.type === "ack" || message.type === "error") && message.id === id
  );
  socket.send(JSON.stringify({ id, type, payload }));
  return reply;
};

const closeSocket = (socket: WebSocket) =>
  new Promise<void>((resolve) => {
    socket.addEventListener("close", () => setTimeout(resolve, 20));
    socket.close();
  });

const until = async (condition: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
};

/** 一张标签页：站点连接领取身份，游戏连接挂上同一身份。 */
const openTab = async (port: number) => {
  const site = await openSocket(port);
  const claim = await request(site, "site.session.claim", {});
  const game = await openSocket(port);
  await request(game, "site.session.attach", { token: claim.payload?.token });
  return { site, game };
};

const LOBBY: Record<GameId, string> = {
  faker: "lobby.subscribeRooms",
  song: "song.lobby.subscribeRooms",
  cee: "cee.lobby.subscribeRooms",
};

const CREATE: Record<GameId, string> = {
  faker: "room.create",
  song: "song.room.create",
  cee: "cee.room.create",
};

const createRoom = (socket: WebSocket, game: GameId, allowAgents: boolean) =>
  request(socket, CREATE[game], {
    ...(game === "cee" ? { source: "native" } : {}),
    roomId: "1234",
    name: "房间",
    visibility: "public",
    allowSpectators: true,
    userName: "房主",
    allowAgents,
  });

const callTool = async (port: number, name: string, args: object) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return (await response.json()) as { result?: { isError?: boolean; content?: unknown[] } };
};

for (const game of GAME_IDS) {
  test(`统一入口：${game} 的连接登记进本款，断开后只从本款注销`, async () => {
    const { port, games, stop } = start();
    try {
      const counts = () =>
        Object.fromEntries(
          GAME_IDS.map((id) => [id, games[id].getHealthSnapshot().connectionCount])
        );
      const socket = await openSocket(port);
      expect((await request(socket, LOBBY[game], {})).type).toBe("ack");
      expect(counts()).toEqual({ faker: 0, song: 0, cee: 0, [game]: 1 });
      await closeSocket(socket);
      await until(() => Object.values(counts()).every((count) => count === 0));
      expect(counts()).toEqual({ faker: 0, song: 0, cee: 0 });
    } finally {
      await stop();
    }
  });

  test(`站点页准入：坐在未开 MCP 的 ${game} 房间里的标签页，认领被拒`, async () => {
    const { port, stop } = start();
    try {
      const tab = await openTab(port);
      expect((await createRoom(tab.game, game, false)).type).toBe("ack");
      const opened = await request(tab.site, "site.page.open", {});
      const code = String(opened.payload?.code);
      const reply = await callTool(port, "control_page", { code });
      expect(JSON.stringify(reply)).toContain("未开启 MCP");
    } finally {
      await stop();
    }
  });

  test(`站点页发布：${game} 房间里的标签页被接管后，同房立刻收到座位徽标`, async () => {
    const { port, stop } = start();
    try {
      const tab = await openTab(port);
      expect((await createRoom(tab.game, game, true)).type).toBe("ack");
      const opened = await request(tab.site, "site.page.open", {});
      // 全量与补丁两种下行形态都算：补丁把徽标写成 `…/mcpControlled` 加 `value: true`。
      const badge = nextMessage(tab.game, (message) =>
        /mcpControlled.{0,12}true/.test(JSON.stringify(message))
      );
      // 认领后工具还会等页面回读，这里不等它返回：徽标在认领那一刻就已发布。
      void callTool(port, "control_page", { code: String(opened.payload?.code) }).catch(
        () => undefined
      );
      await badge;
    } finally {
      await stop();
    }
  });
}

test("停机广播：运维接口通知到三款游戏各自的在线连接，一款都不漏", async () => {
  const { port, stop } = start();
  try {
    const sockets = await Promise.all(
      GAME_IDS.map(async (game) => {
        const socket = await openSocket(port);
        await request(socket, LOBBY[game], {});
        return {
          game,
          socket,
          shutdown: nextMessage(
            socket,
            (m) => m.id === undefined && JSON.stringify(m).includes("server.shutdown")
          ),
        };
      })
    );
    const response = await fetch(`http://127.0.0.1:${port}/api/system/notify-shutdown`, {
      method: "POST",
      headers: { authorization: "Bearer test-maintenance-token" },
    });
    expect(response.status).toBe(200);
    for (const { shutdown } of sockets) expect((await shutdown).type).toBe("event");
  } finally {
    await stop();
  }
});
