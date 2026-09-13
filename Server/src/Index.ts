import { WhoIsFakerService } from "./application/WhoIsFakerService";
import { readEnv } from "./config/Env";
import { describeError, EventLogger } from "./infrastructure/EventLogger";
import { OtlpExporter } from "./infrastructure/OtlpExporter";
import {
  captureServerCheckIn,
  closeServerSentry,
  flushServerSentry,
  gaugeServerMetric,
  initServerSentry,
  SERVER_HEARTBEAT_INTERVAL_MS,
} from "./infrastructure/Sentry";
import { WordBankRepository } from "./infrastructure/WordBankRepository";
import { createApp } from "./transport/App";

// ==================== 服务启动 ====================

const env = readEnv();
initServerSentry(env);
captureServerCheckIn();
const otlpExporter = env.otelEndpoint
  ? new OtlpExporter({
      endpoint: env.otelEndpoint,
      headers: env.otelHeaders,
      serviceName: env.otelServiceName,
      serviceNamespace: env.otelServiceNamespace,
      deploymentEnvironment: env.otelDeploymentEnvironment,
    })
  : undefined;

if (otlpExporter) {
  void otlpExporter.sendHeartbeatTrace();
}

const logger = new EventLogger(undefined, undefined, otlpExporter);
const whoIsFakerService = new WhoIsFakerService({
  eventLogger: logger,
  wordBankRepository: new WordBankRepository(env.wordBankPath),
});

let isShuttingDown = false;

const { app, sonGuessrService } = createApp({
  env,
  whoIsFakerService,
  logger,
  isShuttingDown: () => isShuttingDown,
  onTriggerShutdown: async () => {
    isShuttingDown = true;
    void whoIsFakerService.drainPendingWrites().catch((error: unknown) => {
      logger.error("停机前词库刷盘异常", describeError(error));
    });
  },
});

// 定时执行房间闲置清理与掉线超时检查。
// 最短超时窗口为 10 分钟，10 s 轮询足够精度，无需1 s 高频空转。
const intervalId = setInterval(() => {
  void whoIsFakerService.runHousekeeping().catch((error: unknown) => {
    logger.error("房间清理任务执行失败", describeError(error));
  });
  void sonGuessrService.runHousekeeping().catch((error: unknown) => {
    logger.error("SonGuessr 房间清理任务执行失败", describeError(error));
  });
}, 10_000);

// 心跳上报间隔必须落在 Cron Monitor 的判定裕度内，防止窗口间隙造成误报。
const sentryHeartbeatIntervalId = setInterval(captureServerCheckIn, SERVER_HEARTBEAT_INTERVAL_MS);
sentryHeartbeatIntervalId.unref();

const sentryRuntimeMetricsIntervalId = setInterval(() => {
  reportRuntimeMetrics();
}, 60_000);
sentryRuntimeMetricsIntervalId.unref();

function reportRuntimeMetrics(): void {
  const faker = whoIsFakerService.getHealthSnapshot();
  const songuessr = sonGuessrService.getHealthSnapshot();
  gaugeServerMetric("bakagame.players.online", faker.onlinePlayerCount + songuessr.onlinePlayerCount);
  gaugeServerMetric("bakagame.rooms.active", faker.roomCount + songuessr.roomCount);
  gaugeServerMetric("bakagame.connections.active", faker.connectionCount + songuessr.connectionCount);
}

reportRuntimeMetrics();

const server = app.listen({
  // 公开地址使用 SERVER_URL，实际监听地址优先回落到本机可绑定地址。
  hostname: env.serverListenHost,
  port: env.serverPort,
});

// ==================== 优雅停机 ====================

const shutdown = async (signal?: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.warn("收到停机信号，开始优雅停机", {
    signal,
  });

  // 15 秒硬超时看门狗兜底退出，防止卡死在下游 I/O 或挂起套接字
  const watchdog = setTimeout(() => {
    logger.error("优雅停机超时 (15s)，强制终止进程");
    process.exit(1);
  }, 15_000);
  watchdog.unref();

  // 1. 清理后台定时任务，不再触发新的闲置扫描
  clearInterval(intervalId);
  clearInterval(sentryHeartbeatIntervalId);
  clearInterval(sentryRuntimeMetricsIntervalId);

  // 2. 向 WhoIsFaker 与 SonGuessr 双模式所有在线玩家广播停机通知
  whoIsFakerService.notifyShutdown();
  sonGuessrService.notifyShutdown();

  // 3. 预留 3 秒摘流与客户端接收停机协议窗口，使反向代理 / K8s Ingress 切换节点
  await Bun.sleep(3000);

  // 4. 等待未完成的词库持久化写入队列全部排空落盘
  await whoIsFakerService.drainPendingWrites();

  // 5. 优雅关闭 HTTP 与 WebSocket 监听端口并关闭存量套接字
  await app.stop(true);

  // 6. 排空并刷新未导出的 OTLP 遥测日志
  if (otlpExporter) {
    await otlpExporter.shutdown();
  }

  // 7. 排空并关闭 Sentry 异常监控客户端
  await flushServerSentry(2000);
  await closeServerSentry(2000);

  clearTimeout(watchdog);
  logger.info("服务已完成优雅停机");
  process.exit(0);
};

const handleSignal = (signal: string) => {
  void shutdown(signal).catch((error) => {
    logger.error("优雅停机失败", describeError(error));
    process.exit(1);
  });
};

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  logger.error("未捕获的异步 Promise 拒绝 (unhandledRejection)", {
    ...describeError(reason),
    error: reason instanceof Error ? reason : new Error(String(reason)),
  });
});

process.on("uncaughtException", (error) => {
  logger.error("未捕获的同步全局异常 (uncaughtException)", {
    ...describeError(error),
    error: error instanceof Error ? error : new Error(String(error)),
  });
  void shutdown("uncaughtException");
});

logger.info("BakaGame Server Powered by Elysia Started", {
  serverUrl: env.serverUrl,
  listenAddress: `${server.server?.hostname ?? env.serverListenHost}:${server.server?.port ?? env.serverPort}`,
});
