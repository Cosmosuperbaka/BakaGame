// ==================== 数据库语句守卫：截止时间与只读重试 ====================
// drizzle 的 mysql2 会话只用到客户端的 query / execute / getConnection 三个成员：普通语句走
// query / execute，事务与流式迭代器经 getConnection 借一条连接（`"getConnection" in client` 决定按
// 连接池处理；有 `promise` 方法会被当成回调式客户端转换，所以包装对象不能有它）。这里把 mysql2 连接池
// 包一层，补上驱动没有的两件事：
// - 每条语句都有截止时间：到点销毁那条连接（它离开连接池，服务端随之回滚未提交的事务），并以
//   `DB_STATEMENT_TIMEOUT` 拒绝调用方。托管库的跨境链路会被中途静默掐断，mysql2 自身不设查询超时，
//   只能等 TCP 重传耗尽，一条语句能挂十几分钟。不用 mysql2 自带的查询 `timeout` 选项：它到点只拒绝
//   回调，连接带着在途命令回到池里，下一个借到它的调用方接着挂。
// - 非事务的只读语句遇到连接级失败，在新连接上自动重试一次。写语句不重试（可能已在服务端生效，重放会
//   重复写）；事务内的语句不重试（连接一断，整个事务已由服务端回滚，单条重放没有意义）。

/**
 * 单条语句的截止时间（非事务语句含从池里借连接的等待）。
 *
 * 正常的跨境查询在 2 秒内返回，这里留 5 倍余量，容得下后台的聚合统计；同时与客户端命令的
 * 默认应答超时对齐——超过这个时长玩家那头已经放弃等待，服务端再等只会多占连接与在途状态。
 * 只读语句最坏是两次截止时间（首次超时 + 新连接重试）。
 */
export const STATEMENT_TIMEOUT_MS = 10_000;

/** 截止时间到点的错误码；与 mysql2 的连接级错误同属「这条连接已不可再用」。 */
export const STATEMENT_TIMEOUT_CODE = "DB_STATEMENT_TIMEOUT";

export class StatementTimeoutError extends Error {
  readonly code = STATEMENT_TIMEOUT_CODE;
  /** 与 mysql2 的 `fatal` 同义：连接已被销毁，调用方不能在它上面继续发语句。 */
  readonly fatal = true;

  constructor(readonly timeoutMs: number) {
    super(`数据库语句 ${timeoutMs}ms 内未返回，已断开该连接`);
    this.name = "StatementTimeoutError";
  }
}

/** 从连接池借出的一条连接：mysql2 promise `PoolConnection` 用到的子集。 */
export interface PooledConnection {
  query(options: unknown, values?: unknown): Promise<unknown>;
  execute(options: unknown, values?: unknown): Promise<unknown>;
  release(): void;
  destroy(): void;
  /** mysql2 底层的回调式连接；drizzle 的流式迭代器直接用它，这里只透传。 */
  readonly connection?: unknown;
}

/** 连接来源：mysql2 promise 连接池，测试注入假实现。 */
export interface ConnectionSource {
  getConnection(): Promise<PooledConnection>;
}

/** 守卫后的事务连接：没有 `getConnection`，drizzle 因此把它当单条连接用。 */
export interface GuardedConnection {
  query(options: unknown, values?: unknown): Promise<unknown>;
  execute(options: unknown, values?: unknown): Promise<unknown>;
  release(): void;
  destroy(): void;
  readonly connection: unknown;
}

/** 守卫后的连接池：交给 `drizzle({ client })` 的就是它。 */
export interface GuardedPool {
  query(options: unknown, values?: unknown): Promise<unknown>;
  execute(options: unknown, values?: unknown): Promise<unknown>;
  getConnection(): Promise<GuardedConnection>;
}

export interface StatementGuardOptions {
  /** 截止时间；`null` 表示不限，只给一次性表结构脚本用（大表 DDL 可以合法地跑很久）。 */
  timeoutMs?: number | null;
  /** 只读语句因连接级失败重试前触发，用于落日志。`statement` 是带占位符的语句文本，不含参数。 */
  onRetry?: (context: { error: unknown; statement: string }) => void;
}

type Method = "query" | "execute";

/** mysql2 没标 `fatal` 时仍按连接级失败处理的错误码。 */
const CONNECTION_FAILURE_CODES = new Set([
  STATEMENT_TIMEOUT_CODE,
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_SEQUENCE_TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
]);

/** 连接级失败：连接本身坏了（断链、超时、被重置），而不是语句被库拒绝（语法、约束、锁等待）。 */
export const isConnectionFailure = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const { fatal, code } = error as { fatal?: unknown; code?: unknown };
  return fatal === true || (typeof code === "string" && CONNECTION_FAILURE_CODES.has(code));
};

/** drizzle 传进来的要么是语句文本，要么是带 `sql` 的查询选项。 */
const statementOf = (options: unknown): string => {
  if (typeof options === "string") return options;
  if (typeof options === "object" && options !== null) {
    const text = (options as { sql?: unknown }).sql;
    if (typeof text === "string") return text;
  }
  return "";
};

/**
 * 只读语句：以 SELECT 开头（允许前导括号，覆盖 UNION 写法）。
 * 不认 WITH：MySQL 的公用表表达式后面可以接 UPDATE / DELETE。
 */
export const isReadOnlyStatement = (statement: string): boolean =>
  /^[\s(]*select\b/i.test(statement);

/** 连接坏掉后，事务收尾的 ROLLBACK（含回滚到保存点）视为已完成：断开即由服务端回滚。 */
const isRollback = (statement: string): boolean => /^\s*rollback\b/i.test(statement);

/** 被视为已完成的 ROLLBACK 的结果：与 mysql2 写操作的 `[ResultSetHeader, fields]` 同形。 */
const SKIPPED_ROLLBACK: [Record<string, number>, unknown[]] = [
  { affectedRows: 0, insertId: 0, warningStatus: 0 },
  [],
];

/** 驱动给的拒绝原因一律是 Error；万一不是，包一层再交给调用方，原值挂在 cause 上。 */
const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error), { cause: error });

const startTimer = (
  timeoutMs: number | null,
  onTimeout: () => void
): ReturnType<typeof setTimeout> | undefined =>
  timeoutMs === null ? undefined : setTimeout(onTimeout, Math.max(1, timeoutMs));

/** 同步抛出的错误也收进拒绝里，调用方只需处理一条 Promise 路径。 */
const invoke = (
  connection: PooledConnection,
  method: Method,
  options: unknown,
  values: unknown
): Promise<unknown> =>
  new Promise<unknown>((resolve) => resolve(connection[method](options, values)));

/**
 * 销毁连接。mysql2 的 destroy 只是半关闭（发出 FIN），链路已死时套接字还会挂着重传，
 * 所以顺手把底层套接字也拆掉；两步都是尽力而为，坏连接销毁失败不影响调用方。
 */
const destroyQuietly = (connection: PooledConnection): void => {
  try {
    connection.destroy();
  } catch {
    // 连接已经坏了，销毁失败不需要再处理。
  }
  const stream = (connection.connection as { stream?: { destroy?: () => void } } | undefined)
    ?.stream;
  try {
    stream?.destroy?.();
  } catch {
    // 同上：底层套接字可能早已关闭。
  }
};

/** 归一化截止时间：缺省取 {@link STATEMENT_TIMEOUT_MS}，非正数与非有限值一律视为不限。 */
const normalizeTimeout = (timeoutMs: number | null | undefined): number | null => {
  if (timeoutMs === null) return null;
  const value = timeoutMs ?? STATEMENT_TIMEOUT_MS;
  return Number.isFinite(value) && value > 0 ? value : null;
};

/**
 * 借一条连接，等待有截止时间。到点先拒绝调用方；之后才借到的连接本身完好，原样归还，不泄漏。
 */
const acquire = (source: ConnectionSource, timeoutMs: number | null): Promise<PooledConnection> =>
  new Promise<PooledConnection>((resolve, reject) => {
    let settled = false;
    const timer = startTimer(timeoutMs, () => {
      settled = true;
      reject(new StatementTimeoutError(timeoutMs ?? 0));
    });
    source.getConnection().then(
      (connection) => {
        if (settled) {
          connection.release();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(connection);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(toError(error));
      }
    );
  });

/** 把一条连接包成事务连接：每条语句有截止时间，连接级失败后不再在它上面发语句。 */
const guardConnection = (
  connection: PooledConnection,
  timeoutMs: number | null
): GuardedConnection => {
  /** 首个连接级失败；此后这条连接上的语句直接以它拒绝（ROLLBACK 除外）。 */
  let broken: Error | undefined;
  let destroyed = false;
  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    destroyQuietly(connection);
  };
  const run = (method: Method, options: unknown, values: unknown): Promise<unknown> => {
    if (broken !== undefined) {
      // 连接已断开，服务端已回滚；让 ROLLBACK 照常完成，drizzle 才会把原始失败抛给调用方，
      // 而不是换成一条「回滚失败」。
      return isRollback(statementOf(options))
        ? Promise.resolve(SKIPPED_ROLLBACK)
        : Promise.reject(broken);
    }
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const timer = startTimer(timeoutMs, () => {
        settled = true;
        const timedOut = new StatementTimeoutError(timeoutMs ?? 0);
        broken = timedOut;
        destroy();
        reject(timedOut);
      });
      invoke(connection, method, options, values).then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const failure = toError(error);
          if (isConnectionFailure(failure)) {
            broken = failure;
            destroy();
          }
          reject(failure);
        }
      );
    });
  };
  return {
    query: (options, values) => run("query", options, values),
    execute: (options, values) => run("execute", options, values),
    // 坏掉的连接不能回池：归还时改为销毁（重复销毁是空操作）。
    release: () => {
      if (broken === undefined && !destroyed) connection.release();
      else destroy();
    },
    destroy,
    get connection() {
      return connection.connection;
    },
  };
};

/** 给 mysql2 连接池套上语句守卫，返回交给 `drizzle({ client })` 的客户端。 */
export const guardPool = (
  source: ConnectionSource,
  options: StatementGuardOptions = {}
): GuardedPool => {
  const timeoutMs = normalizeTimeout(options.timeoutMs);

  /** 借连接 + 执行共用一份截止时间：调用方最多等这么久。 */
  const runOnce = async (method: Method, statement: unknown, values: unknown): Promise<unknown> => {
    const startedAt = Date.now();
    const connection = await acquire(source, timeoutMs);
    const budgetMs = timeoutMs === null ? null : timeoutMs - (Date.now() - startedAt);
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const timer = startTimer(budgetMs, () => {
        settled = true;
        destroyQuietly(connection);
        reject(new StatementTimeoutError(timeoutMs ?? 0));
      });
      invoke(connection, method, statement, values).then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          connection.release();
          resolve(result);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // 连接级失败的连接 mysql2 已自行移出池子，这里再销毁一次确保不会被归还复用。
          if (isConnectionFailure(error)) destroyQuietly(connection);
          else connection.release();
          reject(toError(error));
        }
      );
    });
  };

  const run = async (method: Method, statement: unknown, values: unknown): Promise<unknown> => {
    try {
      return await runOnce(method, statement, values);
    } catch (error) {
      const text = statementOf(statement);
      if (!isConnectionFailure(error) || !isReadOnlyStatement(text)) throw error;
      options.onRetry?.({ error, statement: text });
      return runOnce(method, statement, values);
    }
  };

  return {
    query: (statement, values) => run("query", statement, values),
    execute: (statement, values) => run("execute", statement, values),
    // 事务借连接也有截止时间；借到的连接上的语句不重试。
    getConnection: async () => guardConnection(await acquire(source, timeoutMs), timeoutMs),
  };
};
