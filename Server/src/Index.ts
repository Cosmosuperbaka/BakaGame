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
import { createServer } from "./application/CreateServer";

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

const { app, dispose, sonGuessrService, ccbService, reportBangumiLoad } = createServer({
  env,
  whoIsFakerService,
  logger,
  isShuttingDown: () => isShuttingDown,
  onTriggerShutdown: async () => {
    isShuttingDown = true;
    // 预通知只摘除 readiness；真正的排空与释放由后续 signal 的唯一任务负责。
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
  void ccbService.runHousekeeping().catch((error: unknown) => {
    logger.error('CCB 房间清理任务执行失败', describeError(error));
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
  const ccb = ccbService.getHealthSnapshot();
  const onlinePlayerCount = faker.onlinePlayerCount + songuessr.onlinePlayerCount + ccb.onlinePlayerCount;
  gaugeServerMetric(
    "bakagame.players.online",
    onlinePlayerCount,
  );
  // 数据更新器按玩家数调整上游速率：有人玩才跑得快，空闲时只慢慢更新。
  reportBangumiLoad(onlinePlayerCount);
  gaugeServerMetric(
    "bakagame.rooms.active",
    faker.roomCount + songuessr.roomCount + ccb.roomCount,
  );
  gaugeServerMetric(
    "bakagame.connections.active",
    faker.connectionCount + songuessr.connectionCount + ccb.connectionCount,
  );
}

reportRuntimeMetrics();

const server = app.listen({
  // 公开地址使用 SERVER_URL，实际监听地址优先回落到本机可绑定地址。
  hostname: env.serverListenHost,
  port: env.serverPort,
});

// ==================== 优雅停机 ====================

let shutdownTask: Promise<void> | undefined;
const shutdown = (signal?: string): Promise<void> => {
  if (shutdownTask) return shutdownTask;
  isShuttingDown = true;
  // 先发布唯一任务再执行副作用，重复或同步重入的 signal 都复用同一编排。
  shutdownTask = Promise.resolve().then(async () => {
    logger.warn("收到停机信号，开始优雅停机", { signal });

    // 总预算仍为 15 秒；挂起 I/O 由看门狗兜底，不按资源重新计时。
    const watchdog = setTimeout(() => {
      logger.error("优雅停机超时 (15s)，强制终止进程");
      process.exit(1);
    }, 15_000);
    watchdog.unref();

    const failedStages: string[] = [];
    const attempt = async (stage: string, cleanup: () => unknown): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        failedStages.push(stage);
        logger.error("优雅停机步骤失败", { stage, ...describeError(error) });
      }
    };

    clearInterval(intervalId);
    clearInterval(sentryHeartbeatIntervalId);
    clearInterval(sentryRuntimeMetricsIntervalId);

    // 每款游戏独立通知，不能因一款广播失败跳过剩余资源。
    await attempt("notify.faker", () => whoIsFakerService.notifyShutdown());
    await attempt("notify.song", () => sonGuessrService.notifyShutdown());
    await attempt("notify.ccb", () => ccbService.notifyShutdown());
    await attempt("buffer", () => Bun.sleep(3000));
    await attempt("drain", () => whoIsFakerService.drainPendingWrites());
    await attempt("stop", () => app.stop(true));
    await attempt("dispose", () => dispose());
    if (otlpExporter) {
      await attempt("otlp", () => otlpExporter.shutdown());
    }
    await attempt("sentry.flush", async () => {
      if (!await flushServerSentry(2000)) throw new Error("Sentry flush 未在预算内完成");
    });
    await attempt("sentry.close", async () => {
      if (!await closeServerSentry(2000)) throw new Error("Sentry close 未在预算内完成");
    });

    clearTimeout(watchdog);
    if (failedStages.length) {
      logger.error("优雅停机清理完成但存在失败", { failedStages });
    } else {
      logger.info("服务已完成优雅停机");
    }
    process.exit(failedStages.length ? 1 : 0);
  });
  return shutdownTask;
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
  handleSignal("uncaughtException");
});

logger.info("BakaGame Server Powered by Elysia Started", {
  serverUrl: env.serverUrl,
  listenAddress: `${server.server?.hostname ?? env.serverListenHost}:${server.server?.port ?? env.serverPort}`,
});
