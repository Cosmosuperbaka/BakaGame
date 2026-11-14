import { connect } from "node:net";

import { WhoIsFakerService } from "../../src/application/WhoIsFakerService";
import type { AppEnv } from "../../src/config/Env";
import { EventLogger } from "../../src/infrastructure/EventLogger";
import { ClientChannel } from "../../src/infrastructure/ClientChannel";
import type { AccountDependencies } from "../../src/transport/routes/Account";
import { WsHandshakeQuota } from "../../src/transport/WsHandshakeQuota";
import type { SiteFeatures } from "../../src/shared/SiteFeatures";
import { WS_HANDSHAKE_IP_MAX_CONNECTIONS } from "../../src/config/Constants";
import { createTestApp as createApp } from "../AppFixtures";

// 收集测试期间的 WebSocket 推送，便于按事件类型断言。
export const createSocketCollector = (socket: WebSocket) => {
  const queue: unknown[] = [];
  socket.addEventListener("message", (event: MessageEvent<string>) => {
    queue.push(JSON.parse(event.data));
  });

  return async (predicate: (payload: unknown) => boolean, timeoutMs = 3000) =>
    new Promise<unknown>((resolve, reject) => {
      const startedAt = Date.now();

      const tick = () => {
        const matched = queue.find((payload) => predicate(payload));

        if (matched) {
          resolve(matched);
          return;
        }

        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error("等待 WebSocket 消息超时"));
          return;
        }

        setTimeout(tick, 20);
      };

      tick();
    });
};

export const openSocket = async (port: number, game = "whoisfaker") =>
  openSocketAt(port, `/api/${game}/ws`);

export const openSocketAt = async (port: number, path: string) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket 打开失败")), {
      once: true,
    });
  });
  return socket;
};

export const startTestServer = (options?: {
  onTriggerShutdown?: () => Promise<void> | void;
  isShuttingDown?: () => boolean;
  logger?: EventLogger;
  siteFeatures?: () => SiteFeatures;
  handshakeQuota?: WsHandshakeQuota;
  clientChannel?: ClientChannel;
  account?: AccountDependencies;
}) => {
  const env: AppEnv = {
    maintenanceToken: "test-maintenance-token",
    clientUrl: "http://localhost:5173",
    serverUrl: "http://127.0.0.1",
    serverListenHost: "127.0.0.1",
    serverPort: 0,
    bangumiApiUrl: "https://api.bgm.tv",
    bangumiImageUrl: "",
  };
  let shuttingDown = false;
  const logger = options?.logger ?? new EventLogger();
  const whoIsFakerService = new WhoIsFakerService({
    eventLogger: logger,
  });
  const { app } = createApp({
    env,
    games: { faker: whoIsFakerService },
    logger,
    isShuttingDown: options?.isShuttingDown ?? (() => shuttingDown),
    siteFeatures: options?.siteFeatures,
    handshakeQuota: options?.handshakeQuota,
    clientChannel: options?.clientChannel,
    account: options?.account,
    onTriggerShutdown: async () => {
      shuttingDown = true;
      if (options?.onTriggerShutdown) {
        await options.onTriggerShutdown();
      }
    },
  });
  const started = app.listen({
    hostname: env.serverListenHost,
    port: env.serverPort,
  });
  const port = started.server?.port;

  if (!port) {
    throw new Error("未能获取测试端口");
  }

  return {
    port,
    app,
    whoIsFakerService,
    stop: async () => {
      await started.stop(true);
    },
  };
};

/**
 * 跨站 WebSocket 劫持（CSWSH）防护的回归用例。
 *
 * WebSocket **不受浏览器同源策略约束**，服务端的 Origin 白名单是唯一防线。
 * 这里曾经写成 `return { status: 403 }`，而 Elysia `.ws()` 的 `upgrade` 钩子
 * **忽略返回值**（1.4.29 与 1.4.30 实测：任意 Origin 照样 101 完成握手），
 * 整道防线形同虚设却无人发现——因为当时没有任何用例覆盖它。现在改为 throw，
 * 并用下面这条钉死：改回 return 会立刻失败。
 */
export const VALID_HANDSHAKE_HEADERS = [
  "Upgrade: websocket",
  "Connection: Upgrade",
  "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version: 13",
];

/** 原始 TCP 发一条升级请求，返回响应状态行；`headers` 默认是一份合法握手头，可整组替换来构造畸形升级。 */
export const upgradeStatusLine = (
  port: number,
  origin?: string,
  options: { path?: string; headers?: readonly string[] } = {}
) =>
  new Promise<string>((resolve) => {
    const lines = [
      `GET ${options.path ?? "/api/whoisfaker/ws"} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      ...(options.headers ?? VALID_HANDSHAKE_HEADERS),
    ];
    if (origin) lines.push(`Origin: ${origin}`);
    lines.push("", "");
    let buffer = "";
    let done = false;
    const socket = connect({ host: "127.0.0.1", port }, () => socket.write(lines.join("\r\n")));
    const timer = setTimeout(() => finish("TIMEOUT"), 3000);
    const finish = (value: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\r\n\r\n")) finish(buffer.split("\r\n")[0]);
    });
    socket.on("error", (error) => finish(`ERR ${error.message}`));
  });

/** 只实现握手用得到的 `socketAccount`；其余账号能力在握手测试里不会被触达。 */
export const accountWithLookup = (lookup: () => Promise<undefined>) =>
  ({ service: { socketAccount: lookup } }) as unknown as AccountDependencies;

export const quotaOf = (
  overrides: Partial<ConstructorParameters<typeof WsHandshakeQuota>[0]> = {}
) =>
  new WsHandshakeQuota({
    windowMs: 60_000,
    ipMaxRequests: 1_000,
    globalMaxRequests: 10_000,
    ipMaxConnections: WS_HANDSHAKE_IP_MAX_CONNECTIONS,
    ...overrides,
  });
