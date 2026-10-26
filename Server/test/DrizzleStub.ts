import { getTableColumns, type Table } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";

import type { Database, DatabaseClient } from "../src/infrastructure/db/Database";
import * as schema from "../src/infrastructure/db/Schema";

/**
 * Drizzle 仓储的可注入连接桩。
 *
 * 桩打在 **mysql2 连接**这一层，`drizzle()` 与查询构建器全部是真的：仓储发出的
 * SQL 文本、占位符参数、行→实体的解码都走生产同一条路径，测试断言的就是实际拼出来的
 * 语句，而不是对着一份手写假接口自证。数据库本身不参与 readiness，因此这一层也正是
 * 「无库可跑」时唯一需要补的缺口。
 *
 * 约定（与 `drizzle-orm/mysql2` 的 session 实现一致）：
 * - `client.query({ sql, rowsAsArray }, params)` 返回 `[rows, fields]`；
 * - 有字段映射的查询（select）行是**数组**，列序与 SELECT 列表一致，用 `rowOf` 按表拼；
 * - 写操作走无映射分支，读 `rows[0].insertId / affectedRows`，`$returningId()` 据此展开。
 */

export interface StubQuery {
  sql: string;
  params: unknown[];
  /** 归一化后的单行 SQL，断言时比 `sql` 稳定。 */
  statement: string;
}

/** 一次查询的应答：select 给行数组，写操作给 `{ insertId, affectedRows }`。 */
export type StubReply = unknown[][] | { insertId?: number; affectedRows?: number };

export interface DrizzleStub {
  /** 直接注入仓储构造函数的 `Database` 端口。 */
  readonly database: Database;
  /** 按发出顺序记录的全部查询。 */
  readonly queries: StubQuery[];
  /** 追加按顺序消费的应答；耗尽后回落到 `fallback`。 */
  reply(...replies: StubReply[]): DrizzleStub;
  /** 覆盖默认应答（select 空集、写操作 1 行）。 */
  fallback(handler: (query: StubQuery, index: number) => StubReply): DrizzleStub;
  /** 让第 `nth` 条（从 0 计）查询抛错，用于失败路径。 */
  reject(nth: number, error: Error): DrizzleStub;
  /** 第 `nth` 条（从 0 计）查询，越界时报错而不是返回 undefined。 */
  queryAt(nth: number): StubQuery;
  /** 清空已记录的查询与应答，用于在同一夹具里分段断言。 */
  reset(): DrizzleStub;
  readonly closed: () => boolean;
}

const normalize = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/** 按表的列定义顺序拼一行结果，列序与 `db.select().from(table)` 的 SELECT 列表一致。 */
export const rowOf = (table: Table, values: Record<string, unknown>): unknown[] =>
  Object.keys(getTableColumns(table)).map((key) => values[key] ?? null);

/** 按给定字段顺序拼一行结果，用于 `select({ a: ..., b: ... })` 的部分列查询。 */
export const tupleOf = (...values: unknown[]): unknown[] => values;

/**
 * UTC 毫秒 → 驱动返回的 `datetime(3)` 文本。
 * 列解码按 `value.replace(" ", "T") + "Z"` 读成 UTC，因此行里给的是字符串而不是 Date，
 * 与真实 mysql2 在 `timezone: "Z"` 下的行为一致。
 */
export const stamp = (ms: number): string =>
  new Date(ms).toISOString().replace("T", " ").replace("Z", "");

export const createDrizzleStub = (options: { ready?: Promise<void> } = {}): DrizzleStub => {
  const queries: StubQuery[] = [];
  const queued: StubReply[] = [];
  const rejections = new Map<number, Error>();
  let fallbackHandler: ((query: StubQuery, index: number) => StubReply) | undefined;
  let closed = false;

  const defaultReply = (query: StubQuery): StubReply =>
    /^select\b/i.test(query.statement) ? [] : { insertId: 1, affectedRows: 1 };

  const client = {
    async query(
      raw: { sql: string },
      params: unknown[]
    ): Promise<[StubReply | unknown[], unknown[]]> {
      const index = queries.length;
      const query: StubQuery = { sql: raw.sql, params, statement: normalize(raw.sql) };
      queries.push(query);
      const rejection = rejections.get(index);
      if (rejection) throw rejection;
      const reply = queued.shift() ?? fallbackHandler?.(query, index) ?? defaultReply(query);
      return [reply, []];
    },
  };

  // 桩只实现 mysql2 连接的 query()，其余成员按 drizzle 实际取用的子集存在。
  const db = drizzle({ client, schema, mode: "default" } as never) as unknown as DatabaseClient;

  const stub: DrizzleStub = {
    database: {
      db,
      ready: options.ready ?? Promise.resolve(),
      ping: async () => true,
      close: async () => {
        closed = true;
      },
    },
    queries,
    reply: (...replies) => {
      queued.push(...replies);
      return stub;
    },
    fallback: (handler) => {
      fallbackHandler = handler;
      return stub;
    },
    reject: (nth, error) => {
      rejections.set(nth, error);
      return stub;
    },
    queryAt: (nth) => {
      const query = queries[nth];
      if (!query) throw new Error(`第 ${nth} 条查询尚未发出（已发出 ${queries.length} 条）`);
      return query;
    },
    reset: () => {
      queries.length = 0;
      queued.length = 0;
      rejections.clear();
      return stub;
    },
    closed: () => closed,
  };
  return stub;
};

export { schema };
