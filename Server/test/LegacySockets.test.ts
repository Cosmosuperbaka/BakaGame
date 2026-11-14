import { afterEach, expect, spyOn, test } from "bun:test";

import type { CEEService } from "../src/application/CEEService";
import type { SonGuessrService } from "../src/application/SonGuessrService";
import type { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import type { AppEnv } from "../src/config/Env";
import { EventLogger } from "../src/infrastructure/EventLogger";
import * as Sentry from "../src/infrastructure/Sentry";
import type { ConnectionRecord } from "../src/shared/Index";
import { LEGACY_WS_PATHS, UNIFIED_WS_PATH } from "../src/transport/UnifiedSocket";
import { createTestApp } from "./AppFixtures";

/**
 * 旧实时路径与统一入口的出站口径一致：服务端发出什么帧，客户端就收到什么帧，不再按结构校验替换。
 * 出站帧只经 `Packets` 工厂构造，结构正确由构造点保证，不在每次发送时重复校验。
 */

const env: AppEnv = {
  clientUrl: "http://localhost:5173",
  serverUrl: "http://127.0.0.1",
  serverListenHost: "127.0.0.1",
  serverPort: 0,
  bangumiApiUrl: "https://api.bgm.tv",
  bangumiImageUrl: "",
};

/** 故意不合 ServerMessage 结构的出站帧：旧路径的出站校验会把它换成一段校验错误文本。 */
const MALFORMED_FRAME = { type: "bogus", unexpected: 1 };

/** 连接一登记就发一帧畸形帧的替身服务：只实现传输层会调用的几个方法。 */
const stubService = <T>() =>
  ({
    registerConnection: (connection: ConnectionRecord) => connection.sendPacket?.(MALFORMED_FRAME),
    unregisterConnection: async () => undefined,
    execute: async () => ({}),
    close: async () => undefined,
  }) as unknown as T;

const startServer = () => {
  const logger = new EventLogger(() => undefined);
  const { app } = createTestApp({
    env,
    logger,
    games: {
      faker: stubService<WhoIsFakerService>(),
      song: stubService<SonGuessrService>(),
      cee: stubService<CEEService>(),
    },
  });
  const started = app.listen({ hostname: "127.0.0.1", port: 0 });
  const port = started.server?.port;
  if (!port) throw new Error("未能获取测试端口");
  return { port, stop: () => started.stop(true) };
};

/** 开一条连接，必要时发一条命令触发登记，返回收到的第一条文本帧。 */
const firstFrame = (port: number, path: string, command?: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const timer = setTimeout(() => reject(new Error(`${path} 等待首帧超时`)), 4000);
    socket.addEventListener("open", () => {
      if (command) socket.send(JSON.stringify({ id: "probe-1", type: command, payload: {} }));
    });
    socket.addEventListener("message", (event: MessageEvent<string>) => {
      clearTimeout(timer);
      socket.close();
      resolve(String(event.data));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${path} 打开失败`));
    });
  });

const CASES = [
  [UNIFIED_WS_PATH, "lobby.subscribeRooms"],
  [LEGACY_WS_PATHS.faker, undefined],
  [LEGACY_WS_PATHS.song, undefined],
  [LEGACY_WS_PATHS.cee, undefined],
] as const;

for (const [path, command] of CASES) {
  test(`${path}：服务端发出的帧原样送达，不做出站结构校验`, async () => {
    const { port, stop } = startServer();
    try {
      expect(JSON.parse(await firstFrame(port, path, command))).toEqual(MALFORMED_FRAME);
    } finally {
      await stop();
    }
  });
}

let metrics: ReturnType<typeof spyOn<typeof Sentry, "countServerMetric">> | undefined;
afterEach(() => metrics?.mockRestore());

test("旧路径建立连接时各打一个带路径标签的计数，统一入口不打", async () => {
  metrics = spyOn(Sentry, "countServerMetric");
  const { port, stop } = startServer();
  const legacyCalls = () =>
    metrics!.mock.calls
      .filter(([name]) => name === "bakagame.ws.legacy_path")
      .map(([, value, attributes]) => ({ value, attributes }));
  try {
    await firstFrame(port, UNIFIED_WS_PATH, "lobby.subscribeRooms");
    expect(legacyCalls()).toEqual([]);
    for (const path of Object.values(LEGACY_WS_PATHS)) await firstFrame(port, path);
    expect(legacyCalls()).toEqual(
      Object.values(LEGACY_WS_PATHS).map((path) => ({ value: 1, attributes: { path } }))
    );
  } finally {
    await stop();
  }
});

// 旧路径的消息体是联合类型：子应用若开着入站规范化，规范化库处理不了联合，装配时每条路径告警一次，
// 入站消息是否被改写也变成取决于那个库的降级行为。主应用一直关着它，拆出来的子应用必须同口径。
test("装配旧实时路径时规范化库不告警", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    createTestApp({
      env,
      logger: new EventLogger(() => undefined),
      games: {
        faker: stubService<WhoIsFakerService>(),
        song: stubService<SonGuessrService>(),
        cee: stubService<CEEService>(),
      },
    });
    const texts = warn.mock.calls.map((args) => args.map(String).join(" "));
    expect(texts.filter((text) => text.includes("exact-mirror"))).toEqual([]);
  } finally {
    warn.mockRestore();
  }
});
