import { WhoIsFakerService } from "./application/WhoIsFakerService";
import { readEnv } from "./config/Env";
import { HTTP_MAX_REQUEST_BODY_BYTES } from "./config/Constants";
import { describeError } from "./infrastructure/EventLogger";
import { createServerLogger } from "./infrastructure/logging/LoggerRuntime";
import { OtlpExporter } from "./infrastructure/OtlpExporter";
import {
  captureServerCheckIn,
  closeServerSentry,
  flushServerSentry,
  gaugeServerMetric,
  initServerSentry,
  SERVER_HEARTBEAT_INTERVAL_MS,
} from "./infrastructure/Sentry";
import { createDatabase } from "./infrastructure/db/Database";
import { DatabaseWordBankRepository } from "./infrastructure/WordBankRepository";
import { DatabaseGameRecordRepository } from "./infrastructure/db/GameRecordRepository";
import { GameRecordService } from "./application/GameRecordService";
import { createServer } from "./application/CreateServer";
import { join } from "node:path";
import { RoomSnapshotStore } from "./infrastructure/RoomSnapshotStore";
import {
  restoreRoomSnapshots,
  saveRoomSnapshots,
  type RoomSnapshotTargets,
} from "./application/RoomSnapshots";
import { ROOM_SNAPSHOT_GAMES } from "./shared/RoomSnapshot";

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

const logger = createServerLogger(env, otlpExporter);
logger.section("服务启动");
// 数据库只承载账号、云同步、后台与对局记录：迁移失败只让这些功能报错，游客游玩照常。
const database = env.databaseUrl
  ? createDatabase(env.databaseUrl, {
      onRetry: ({ attempt, error }) =>
        logger.warn("数据库迁移重试", { attempt, ...describeError(error) }),
    })
  : undefined;
database?.ready.then(
  () => logger.info("数据库迁移完成"),
  (error: unknown) => logger.error("数据库迁移失败，账号与记录功能不可用", describeError(error))
);
const gameRecords = database
  ? new GameRecordService({ repository: new DatabaseGameRecordRepository(database), logger })
  : undefined;
const whoIsFakerService = new WhoIsFakerService({
  eventLogger: logger,
  wordBankRepository: database ? new DatabaseWordBankRepository(database) : undefined,
  gameRecorder: gameRecords,
});

let isShuttingDown = false;

const { app, dispose, sonGuessrService, ceeService, reportBangumiLoad, statusHistory, statusSamples } =
  createServer({
    env,
    database,
    gameRecords,
    whoIsFakerService,
    logger,
    isShuttingDown: () => isShuttingDown,
    onTriggerShutdown: async () => {
      isShuttingDown = true;
      // 这里只翻停机标记：`/readyz` 随之回 503，新 WS 握手也一并被拒（两道闸门读同一份状态）。
      // 向各房间广播停机通知是 notify-shutdown 路由自己的事，真正的排空与释放仍归后续 signal 的唯一任务。
    },
  });

// 状态账本：启动时读回窗口内的日格与实时样本，之后每 5 分钟落一次库。
// 探测由状态接口按需触发，外加 App 内按采样间隔常驻跑的实时采样器——
// 这里只管把内存里的计数搬进表，不另加探测。
void statusHistory.load().catch((error: unknown) => {
  logger.warn("状态历史读取失败，条带从本次运行开始积累", describeError(error));
});
void statusSamples.load().catch((error: unknown) => {
  logger.warn("状态样本读取失败，实时条带从本次运行开始积累", describeError(error));
});
const statusFlushIntervalId = setInterval(() => {
  void statusHistory.flush().catch((error: unknown) => {
    logger.warn("状态历史落库失败", describeError(error));
  });
  void statusSamples.flush().catch((error: unknown) => {
    logger.warn("状态样本落库失败", describeError(error));
  });
}, 5 * 60_000);
statusFlushIntervalId.unref();

// 定时执行房间闲置清理与掉线超时检查。
// 最短超时窗口为 10 分钟，10 s 轮询足够精度，无需1 s 高频空转。
const intervalId = setInterval(() => {
  void whoIsFakerService.runHousekeeping().catch((error: unknown) => {
    logger.error("房间清理任务执行失败", describeError(error));
  });
  void sonGuessrService.runHousekeeping().catch((error: unknown) => {
    logger.error("SonGuessr 房间清理任务执行失败", describeError(error));
  });
  void ceeService.runHousekeeping().catch((error: unknown) => {
    logger.error("CEE 房间清理任务执行失败", describeError(error));
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
  // 按游戏分系列上报，不报进程内的和：实时平面全在内存，一个进程只看得见自己承载的流量。
  // 分成多进程部署（一款游戏一个进程）时，同名 gauge 会被后上报的进程覆盖成局部值，
  // 面板上的「在线人数」就凭空少一半；带 game 标签后各进程互不覆盖，跨系列求和仍是全站总数。
  const games: Array<
    [
      game: "cee" | "faker" | "song",
      snapshot: { roomCount: number; connectionCount: number; onlinePlayerCount: number },
    ]
  > = [
    ["faker", whoIsFakerService.getHealthSnapshot()],
    ["song", sonGuessrService.getHealthSnapshot()],
    ["cee", ceeService.getHealthSnapshot()],
  ];
  // 只累加 players：更新器按它调上游速率。房间/连接数不再聚合上报 —— 分系列之后
  // 全站口径由面板跨系列求和得到，再报一份无标签的 gauge 会被后上报的进程覆盖成局部值。
  let players = 0;
  for (const [game, snapshot] of games) {
    players += snapshot.onlinePlayerCount;
    gaugeServerMetric("bakagame.players.online", snapshot.onlinePlayerCount, { game });
    gaugeServerMetric("bakagame.rooms.active", snapshot.roomCount, { game });
    gaugeServerMetric("bakagame.connections.active", snapshot.connectionCount, { game });
  }
  // 数据更新器按玩家数调整上游速率：有人玩才跑得快，空闲时只慢慢更新。
  reportBangumiLoad(players);
}

reportRuntimeMetrics();

// ==================== 房间快照 ====================
// 停机把内存里的房间写到本地 SQLite，重启后接上；片角色决定本进程负责哪几款游戏。
const snapshotStore = new RoomSnapshotStore({
  directory: env.roomSnapshotDirectory ?? join(import.meta.dir, "..", "storage"),
  logger,
});
const snapshotTargets: RoomSnapshotTargets = {
  store: snapshotStore,
  games: env.shardGames ?? [...ROOM_SNAPSHOT_GAMES],
  services: { faker: whoIsFakerService, song: sonGuessrService, cee: ceeService },
  logger,
};
// 必须在 listen 之前：先恢复房间，再开始收连接，避免第一条 join 撞上空房间表。
const restoreSummary = restoreRoomSnapshots(snapshotTargets);
if (Object.keys(restoreSummary.restored).length || restoreSummary.discarded.length) {
  logger.info("房间快照恢复完成", {
    restored: restoreSummary.restored,
    discarded: restoreSummary.discarded,
  });
}

const server = app.listen({
  // 公开地址使用 SERVER_URL，实际监听地址优先回落到本机可绑定地址。
  hostname: env.serverListenHost,
  port: env.serverPort,
  maxRequestBodySize: HTTP_MAX_REQUEST_BODY_BYTES,
});

// ==================== 优雅停机 ====================

/** 摘流缓冲：留出玩家收到停机广播后平滑退回大厅的网络往返时间。 */
const SHUTDOWN_BUFFER_MS = 3_000;
/** 遥测出口预算：flush 与 close 各自的上限，两步串联，合计占 4s。 */
const SENTRY_EXIT_BUDGET_MS = 2_000;
/** 排空、关监听、释放资源三段没有自带超时，只能靠总预算兜底，这里给它们 5s。 */
const SHUTDOWN_CLEANUP_HEADROOM_MS = 5_000;
/**
 * 停机总预算（唯一真相源）：到点打一条「强制终止」日志再以非 0 退出。
 * 编排侧的停止宽限必须严格大于它（见 `.github/workflows/deploy.yml` 的重启步骤），
 * 否则进程先被 SIGKILL，日志里只剩一个没有原因的 137。
 * 数值 = 缓冲 + Sentry 出口×2 + 无超时清理段余量。
 */
export const SHUTDOWN_BUDGET_MS =
  SHUTDOWN_BUFFER_MS + SENTRY_EXIT_BUDGET_MS * 2 + SHUTDOWN_CLEANUP_HEADROOM_MS;
/**
 * 停机排空集合：每项一个阶段名，逐项单独执行（阶段名进日志与失败名单），一项失败不跳过其余。
 * `drain.faker` 是谁是卧底自己的词对落库队列；`drain.records` 是三款游戏共用的对局记录队列 ——
 * 猜歌与 CEE 没有服务内写队列，落库都汇进这一条，所以不再按款重复等待。
 * 新增可排队写入的服务时往这张表里加，不在编排里散写。
 */
const drainTargets: ReadonlyArray<readonly [stage: string, drain: () => unknown]> = [
  ["drain.faker", () => whoIsFakerService.drainPendingWrites()],
  ["drain.records", () => gameRecords?.close()],
];

let shutdownTask: Promise<void> | undefined;
const shutdown = (signal?: string): Promise<void> => {
  if (shutdownTask) return shutdownTask;
  isShuttingDown = true;
  // 先发布唯一任务再执行副作用，重复或同步重入的 signal 都复用同一编排。
  shutdownTask = Promise.resolve().then(async () => {
    logger.section("优雅停机");
    logger.warn("收到停机信号，开始优雅停机", { signal });

    const completedStages: string[] = [];
    const failedStages: string[] = [];
    // 看门狗不得 unref：unref 的定时器在事件循环转空时不会触发，挂起的停机会以退出码 0 收场（假成功）。
    // 正常路径已 clearTimeout，持有它不会拖慢退出。
    const watchdog = setTimeout(() => {
      logger.error(`优雅停机超时 (${SHUTDOWN_BUDGET_MS / 1000}s)，强制终止进程`, {
        budgetMs: SHUTDOWN_BUDGET_MS,
        completedStages,
        failedStages,
      });
      process.exit(1);
    }, SHUTDOWN_BUDGET_MS);

    const attempt = async (stage: string, cleanup: () => unknown): Promise<void> => {
      try {
        await cleanup();
        completedStages.push(stage);
      } catch (error) {
        failedStages.push(stage);
        logger.error("优雅停机步骤失败", { stage, ...describeError(error) });
      }
    };

    clearInterval(intervalId);
    clearInterval(sentryHeartbeatIntervalId);
    clearInterval(sentryRuntimeMetricsIntervalId);
    clearInterval(statusFlushIntervalId);

    // 每款游戏独立通知，不能因一款广播失败跳过剩余资源。
    await attempt("notify.faker", () => whoIsFakerService.notifyShutdown());
    await attempt("notify.song", () => sonGuessrService.notifyShutdown());
    await attempt("notify.cee", () => ceeService.notifyShutdown());
    await attempt("buffer", () => Bun.sleep(SHUTDOWN_BUFFER_MS));
    // 先落盘再排空：排空可能要等对局记录收尾，而快照必须赶在进程退出前写完。
    await attempt("persist", () => {
      const summary = saveRoomSnapshots(snapshotTargets, Date.now());
      logger.info("房间快照已保存", { saved: summary.saved });
    });
    for (const [stage, drain] of drainTargets) await attempt(stage, drain);
    await attempt("stop", () => app.stop(true));
    await attempt("dispose", () => dispose());
    await attempt("snapshot.close", () => snapshotStore.close());
    if (otlpExporter) {
      await attempt("otlp", () => otlpExporter.shutdown());
    }
    await attempt("sentry.flush", async () => {
      if (!(await flushServerSentry(SENTRY_EXIT_BUDGET_MS)))
        throw new Error("Sentry flush 未在预算内完成");
    });
    await attempt("sentry.close", async () => {
      if (!(await closeServerSentry(SENTRY_EXIT_BUDGET_MS)))
        throw new Error("Sentry close 未在预算内完成");
    });

    await attempt("logs.flush", () => logger.flush());
    clearTimeout(watchdog);
    if (failedStages.length) {
      logger.error("优雅停机清理完成但存在失败", { failedStages });
    } else {
      logger.info("服务已完成优雅停机");
    }
    // 最后关闭文件出口：上面两条停机结论必须落进结构化日志，不能被提前关掉。
    await attempt("logs.close", () => logger.close());
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

logger.info("BakaGame 服务已启动", {
  serverUrl: env.serverUrl,
  listenAddress: `${server.server?.hostname ?? env.serverListenHost}:${server.server?.port ?? env.serverPort}`,
});
