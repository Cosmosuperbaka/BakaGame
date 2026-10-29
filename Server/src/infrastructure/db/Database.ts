import { sql } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";

import { AppError } from "../../domain/Errors";
import * as schema from "./Schema";

export type DatabaseClient = MySql2Database<typeof schema>;

export interface Database {
  db: DatabaseClient;
  /**
   * 启动连通性检查完成的信号。所有读写先等它：连不上时数据库功能整体不可用并持续报错，
   * 游戏本身不受影响（数据库不参与 readiness）。启动不改表结构，表结构变更走一次性脚本。
   */
  ready: Promise<void>;
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

export interface CreateDatabaseOptions {
  attempts?: number;
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
  const checkConnection = async (): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await db.execute(sql`SELECT 1`);
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
  const ready = checkConnection();
  // 失败由调用方经 ready 观察并记录；这里只防止未订阅时成为未处理拒绝。
  ready.catch(() => {});

  return {
    db,
    ready,
    ping: async () => {
      try {
        await db.execute(sql`SELECT 1`);
        return true;
      } catch {
        return false;
      }
    },
    close: () => pool.end(),
  };
};
