import { RoomService } from "./application/room-service";
import { readEnv } from "./config/env";
import { createVersionInfo } from "./config/version";
import { describeError, EventLogger } from "./infrastructure/event-logger";
import { WordBankRepository } from "./infrastructure/word-bank-repository";
import { createApp } from "./transport/app";

// ==================== 服务启动 ====================

const env = readEnv();
const versionInfo = createVersionInfo(env.gitCommit);
const logger = new EventLogger();
const roomService = new RoomService({
  eventLogger: logger,
  wordBankRepository: new WordBankRepository(env.wordBankPath),
});

const { app } = createApp({
  env,
  roomService,
  versionInfo,
  logger,
});

// 定时执行房间闲置清理与掉线超时检查。
const intervalId = setInterval(() => {
  void roomService.runHousekeeping().catch((error) => {
    logger.error("房间清理任务执行失败", describeError(error));
  });
}, 1000);

const server = app.listen({
  // 公开地址使用 SERVER_URL，实际监听地址优先回落到本机可绑定地址。
  hostname: env.serverListenHost,
  port: env.serverPort,
});

// ==================== 优雅停机 ====================

const shutdown = async (signal?: string) => {
  logger.warn("收到停机信号，开始优雅停机", {
    signal,
  });
  clearInterval(intervalId);
  roomService.notifyShutdown();
  await Bun.sleep(50);
  await app.stop(true);
  logger.info("服务已完成优雅停机");
};

process.on("SIGINT", () => {
  void shutdown("SIGINT").catch((error) => {
    logger.error("优雅停机失败", describeError(error));
  });
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM").catch((error) => {
    logger.error("优雅停机失败", describeError(error));
  });
});

logger.info("WhoIsFaker 服务已启动", {
  version: versionInfo.version,
  commit: versionInfo.commit,
  serverUrl: env.serverUrl,
  listenAddress: `${server.server?.hostname ?? env.serverListenHost}:${server.server?.port ?? env.serverPort}`,
});
