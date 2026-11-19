import { sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";

import { AppError } from "../../domain/Errors";
import * as schema from "./Schema";

export type DatabaseClient = MySql2Database<typeof schema>;

export interface Database {
  db: DatabaseClient;
  /**
   * 连通性检查完成的信号。所有读写先等它：连不上时数据库功能整体不可用并持续报错，
   * 游戏本身不受影响（数据库不参与 readiness）。启动不改表结构，表结构变更走一次性脚本。
   *
   * 这是 getter：检查失败后不会永久钉死，冷却期过后的下一次访问会重新检查（同一时刻
   * 只发起一次），数据库恢复后无需重启进程。
   */
  readonly ready: Promise<void>;
  /**
   * 等就绪后给出查询客户端。仓储一律经它取客户端：把「先等就绪」做进取客户端这一步，
   * 类型上就不可能忘记等待而对未就绪的库发出半截语句。
   */
  client(): Promise<DatabaseClient>;
  /**
   * 首次就绪时触发一次回调（已就绪则立即异步触发）。供「就绪后补齐」类的启动任务使用：
   * 启动时连不上，这类任务要等到数据库真的可用才执行，而不是失败一次就放弃。
   * 注册回调期间，未就绪时会在后台按冷却间隔持续重试。
   */
  onReady(callback: () => void): void;
  /** 轻量连通性检查，供管理后台展示；不参与游戏就绪判定。 */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * 启动连通性检查的有限重试：托管库跨境建连偶发抖动，一次性失败会把 `ready` 永久钉死在
 * rejected，此后账号、云同步与对局记录全部持续报错，只有重启进程才能恢复。
 * 检查只读一行，重试安全；退避总时长远小于部署探针预算。
 */
export const CONNECT_RETRY_ATTEMPTS = 3;
export const CONNECT_RETRY_BASE_DELAY_MS = 1_000;

/** 检查失败后到允许重新检查的间隔：既不让每个请求都去敲不可达的库，也不拖长恢复。 */
export const CONNECT_RETRY_COOLDOWN_MS = 10_000;

export interface CreateDatabaseOptions {
  attempts?: number;
  retryCooldownMs?: number;
  /** 连通性检查本身；缺省是对连接池执行一次 `SELECT 1`，测试可注入以模拟库的故障与恢复。 */
  check?: () => Promise<void>;
  /** 每次重试前触发，用于落日志；不传则静默重试。 */
  onRetry?: (context: { attempt: number; error: unknown }) => void;
}

/**
 * 创建连接池并立即开始连通性检查（结果见 `ready`）。
 *
 * 托管数据库强制 TLS；本项目只连托管库，连接一律校验证书，不提供明文开关。
 * 连接池上限按托管额度保守取值，空闲连接主动回收，避免被服务端掐断后复用死连接。
 */
export const createDatabase = (url: string, options: CreateDatabaseOptions = {}): Database => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new AppError("CONFIG_ERROR", "DATABASE_URL 不是合法的连接串", { cause: error });
  }
  if (parsed.protocol !== "mysql:" || !parsed.pathname.replace(/^\//, "")) {
    throw new AppError("CONFIG_ERROR", "DATABASE_URL 必须是 mysql:// 连接串并包含库名");
  }

  const pool = mysql.createPool({
    uri: url,
    ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    timezone: "Z",
    connectionLimit: 5,
    maxIdle: 2,
    idleTimeout: 60_000,
    enableKeepAlive: true,
    connectTimeout: 10_000,
  });
  const db = drizzle({ client: pool, schema, mode: "default" });
  const attempts = Math.max(1, Math.floor(options.attempts ?? CONNECT_RETRY_ATTEMPTS));
  const cooldownMs = options.retryCooldownMs ?? CONNECT_RETRY_COOLDOWN_MS;
  const probe = options.check ?? (async () => void (await db.execute(sql`SELECT 1`)));
  const checkConnection = async (): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await probe();
        return;
      } catch (error) {
        if (attempt >= attempts) throw error;
        options.onRetry?.({ attempt, error });
        await new Promise((resolveRetry) =>
          setTimeout(resolveRetry, CONNECT_RETRY_BASE_DELAY_MS * attempt)
        );
      }
    }
  };

  const readyCallbacks: Array<() => void> = [];
  let everReady = false;
  let closed = false;
  /** 最近一次检查失败的时刻；为 undefined 表示检查在进行中或已成功。 */
  let failedAt: number | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void>;

  const attempt = (): void => {
    failedAt = undefined;
    const run = checkConnection();
    current = run;
    void run.then(
      () => {
        everReady = true;
        for (const callback of readyCallbacks.splice(0)) callback();
      },
      () => {
        failedAt = Date.now();
        // 有人在等「就绪后补齐」时不能只靠请求来触发重试：可能没有任何请求会访问数据库。
        if (readyCallbacks.length > 0 && !closed) {
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            if (!closed && failedAt !== undefined) attempt();
          }, cooldownMs);
          retryTimer.unref?.();
        }
      }
    );
  };
  attempt();

  return {
    db,
    get ready() {
      if (!everReady && failedAt !== undefined && Date.now() - failedAt >= cooldownMs) attempt();
      return current;
    },
    async client() {
      await this.ready;
      return db;
    },
    onReady: (callback) => {
      if (everReady) {
        queueMicrotask(callback);
        return;
      }
      readyCallbacks.push(callback);
      // 回调在检查失败之后才注册时，补一个后台重试。
      if (failedAt !== undefined && retryTimer === undefined && !closed) {
        retryTimer = setTimeout(
          () => {
            retryTimer = undefined;
            if (!closed && failedAt !== undefined) attempt();
          },
          Math.max(0, cooldownMs - (Date.now() - failedAt))
        );
        retryTimer.unref?.();
      }
    },
    ping: async () => {
      try {
        await db.execute(sql`SELECT 1`);
        return true;
      } catch {
        return false;
      }
    },
    close: () => {
      closed = true;
      clearTimeout(retryTimer);
      return pool.end();
    },
  };
};
