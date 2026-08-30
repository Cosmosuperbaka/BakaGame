import { RoomService } from "./application/RoomService";
import { readEnv } from "./config/Env";
import { describeError, EventLogger } from "./infrastructure/EventLogger";
import { WordBankRepository } from "./infrastructure/WordBankRepository";
import { createApp } from "./transport/App";

// ==================== 服务启动 ====================

const env = readEnv();
const logger = new EventLogger();
const roomService = new RoomService({
  eventLogger: logger,
  wordBankRepository: new WordBankRepository(env.wordBankPath),
});

const { app, sonGuessrService } = createApp({
  env,
  roomService,
  logger,
});

// 定时执行房间闲置清理与掉线超时检查。
// 最短超时窗口为 10 分钟，10 s 轮询足够精度，无需1 s 高频空转。
const intervalId = setInterval(() => {
  void roomService.runHousekeeping().catch((error: unknown) => {
    logger.error("房间清理任务执行失败", describeError(error));
  });
  void sonGuessrService.runHousekeeping().catch((error: unknown) => {
    logger.error("SonGuessr 房间清理任务执行失败", describeError(error));
  });
}, 10_000);

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

const handleSignal = (signal: string) => {
  void shutdown(signal).catch((error) => {
    logger.error("优雅停机失败", describeError(error));
  });
};

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

logger.info("BakaGame Server Powered by Elysia Started", {
  serverUrl: env.serverUrl,
  listenAddress: `${server.server?.hostname ?? env.serverListenHost}:${server.server?.port ?? env.serverPort}`,
});
