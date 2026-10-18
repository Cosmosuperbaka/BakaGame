import { CEEService } from "../../src/application/CEEService";
import { SonGuessrService } from "../../src/application/SonGuessrService";
import { WhoIsFakerService } from "../../src/application/WhoIsFakerService";
import { readEnv } from "../../src/config/Env";
import { EventLogger } from "../../src/infrastructure/EventLogger";
import { createApp } from "../../src/transport/App";
import { WsHandshakeQuota } from "../../src/transport/WsHandshakeQuota";
import {
  createStubBangumiProvider,
  createStubCEEDataProvider,
  createStubMusicProvider,
} from "./Stubs";

/**
 * 压测目标进程：与 `src/Index.ts` 同一条装配线（同一个 createApp、同一套三个游戏服务），
 * 只把外部数据源换成桩，使测得的吞吐完全落在服务端自身 CPU / 内存 / 扇出上。
 *
 * 不接数据库、不打上游、不读 Meilisearch：账号路由缺席只会让 `/api/rpc` 回 503，
 * 实时玩法面（WS）不受影响 —— 那正是要测的部分。
 */

const env = readEnv();
const logger = new EventLogger();
const whoIsFakerService = new WhoIsFakerService({ eventLogger: logger });
const sonGuessrService = new SonGuessrService({
  eventLogger: logger,
  musicProvider: createStubMusicProvider(),
  bangumiProvider: createStubBangumiProvider(),
});
const ceeService = new CEEService({ data: createStubCEEDataProvider(), eventLogger: logger });

// 握手配额按客户端地址分桶：压测的几百条连接都来自同一台机器，真实额度会先把它们挡在
// 闸门外，测到的就只是这条防御。放开额度只发生在本进程，生产装配线仍用常量默认值。
const handshakeQuota = new WsHandshakeQuota({
  windowMs: 60_000,
  ipMaxRequests: 10_000_000,
  globalMaxRequests: 10_000_000,
  ipMaxConnections: Number(Bun.env.LOADTEST_WS_MAX_CONNECTIONS ?? 200_000),
});

const { app, dispose } = createApp({
  env,
  logger,
  whoIsFakerService,
  sonGuessrService,
  ceeService,
  handshakeQuota,
  disposeResources: async () => {
    await ceeService.close();
  },
});

// 与 Index.ts 一致的 10 s 房务：不清房间就会让长测的内存曲线失真。
const housekeepingId = setInterval(() => {
  void whoIsFakerService.runHousekeeping().catch(() => {});
  void sonGuessrService.runHousekeeping().catch(() => {});
  void ceeService.runHousekeeping().catch(() => {});
}, 10_000);

const metricsPort = Number(Bun.env.LOADTEST_METRICS_PORT ?? env.serverPort + 1);
const startedAt = Date.now();
const cpuBase = process.cpuUsage();

/** 事件环延迟：100 ms 定时器的实际间隔漂移，是 Bun 单线程被打满最直接的信号。 */
const LAG_TICK_MS = 100;
let lagSamples: number[] = [];
let lastLagTick = Date.now();
const lagId = setInterval(() => {
  const now = Date.now();
  lagSamples.push(Math.max(0, now - lastLagTick - LAG_TICK_MS));
  lastLagTick = now;
  if (lagSamples.length > 4_000) lagSamples = lagSamples.slice(-2_000);
}, LAG_TICK_MS);
lagId.unref();

const snapshot = () => {
  const cpu = process.cpuUsage(cpuBase);
  const memory = process.memoryUsage();
  const health = (service: {
    getHealthSnapshot(): { roomCount: number; connectionCount: number; onlinePlayerCount: number };
  }) => service.getHealthSnapshot();
  return {
    at: Date.now(),
    uptimeMs: Date.now() - startedAt,
    cpuUserUs: cpu.user,
    cpuSystemUs: cpu.system,
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external ?? 0,
    arrayBuffersBytes: (memory as { arrayBuffers?: number }).arrayBuffers ?? 0,
    faker: health(whoIsFakerService),
    song: health(sonGuessrService),
    cee: health(ceeService),
  };
};

const metricsServer = Bun.serve({
  hostname: "127.0.0.1",
  port: metricsPort,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/metrics") return new Response("not found", { status: 404 });
    const samples = url.searchParams.has("reset") ? lagSamples.splice(0) : lagSamples.slice(-200);
    return Response.json({ ...snapshot(), lagSamples: samples });
  },
});

console.log(`READY target port=${env.serverPort} metrics=${metricsServer.port}`);

const shutdown = async () => {
  clearInterval(housekeepingId);
  clearInterval(lagId);
  try {
    whoIsFakerService.notifyShutdown();
    sonGuessrService.notifyShutdown();
    ceeService.notifyShutdown();
    await app.stop(true);
    await dispose();
    await metricsServer.stop(true);
  } catch (error) {
    console.error("目标进程关闭失败", error);
  }
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

app.listen({ hostname: env.serverListenHost, port: env.serverPort });
console.log(`LISTENING ${env.serverListenHost}:${env.serverPort}`);
