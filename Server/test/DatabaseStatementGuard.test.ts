import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";

import { createDatabase, type DatabaseClient } from "../src/infrastructure/db/Database";
import * as schema from "../src/infrastructure/db/Schema";
import {
  STATEMENT_TIMEOUT_CODE,
  guardPool,
  isConnectionFailure,
  isReadOnlyStatement,
  type ConnectionSource,
  type PooledConnection,
} from "../src/infrastructure/db/StatementGuard";
import { deferred } from "./support/Deferred";

/** 一条假连接的应答：给值即成功，给错误即失败，`hang` 表示永不返回（链路被静默掐断）。 */
type Reply = { rows: unknown } | { error: Error } | "hang";

interface FakeConnection extends PooledConnection {
  readonly id: number;
  readonly statements: string[];
  released: number;
  destroyed: number;
}

/** 连接级失败：与 mysql2 在链路断开时给出的错误同形。 */
const connectionLost = (): Error =>
  Object.assign(new Error("Connection lost: The server closed the connection."), {
    code: "PROTOCOL_CONNECTION_LOST",
    fatal: true,
  });

/**
 * 假连接池：按借出顺序给每条连接一份应答脚本（按语句依次消费，耗尽后成功返回空集）。
 * 记录借出次数、每条连接上发出的语句、归还与销毁次数——断言的就是「连接有没有泄漏、坏连接有没有回池」。
 */
const createFakePool = (scripts: Reply[][] = []) => {
  const connections: FakeConnection[] = [];
  let acquireGate: Promise<void> | null = null;
  const source: ConnectionSource & { connections: FakeConnection[] } = {
    connections,
    async getConnection() {
      if (acquireGate) await acquireGate;
      const script = [...(scripts[connections.length] ?? [])];
      const statements: string[] = [];
      const respond = async (options: unknown): Promise<unknown> => {
        const text =
          typeof options === "string" ? options : String((options as { sql: string }).sql);
        statements.push(text.replace(/\s+/g, " ").trim());
        const reply = script.shift() ?? { rows: [[], []] };
        if (reply === "hang") return new Promise(() => {});
        if ("error" in reply) throw reply.error;
        return reply.rows;
      };
      const connection: FakeConnection = {
        id: connections.length,
        statements,
        released: 0,
        destroyed: 0,
        query: respond,
        execute: respond,
        release() {
          connection.released += 1;
        },
        destroy() {
          connection.destroyed += 1;
        },
      };
      connections.push(connection);
      return connection;
    },
  };
  return {
    source,
    connections,
    /** 让后续借连接卡在门上，直到返回的放行函数被调用。 */
    holdAcquire() {
      const gate = deferred();
      acquireGate = gate.promise;
      return () => {
        acquireGate = null;
        gate.resolve();
      };
    },
  };
};

/** 用生产同一套 drizzle 会话驱动守卫：事务路径（BEGIN / COMMIT / ROLLBACK、归还连接）都是真的。 */
const drizzleOver = (source: ConnectionSource, timeoutMs: number | null): DatabaseClient =>
  drizzle({
    client: guardPool(source, { timeoutMs }),
    schema,
    mode: "default",
  } as never) as unknown as DatabaseClient;

/** 取 drizzle 包装错误的根因：守卫抛出的原始错误挂在 cause 上。 */
const rootOf = (error: unknown): unknown => {
  let current = error;
  while (current instanceof Error && current.cause !== undefined) current = current.cause;
  return current;
};

const codeOf = (error: unknown): unknown => (rootOf(error) as { code?: unknown }).code;

describe("语句守卫：判定口径", () => {
  it("只读语句只认 SELECT 开头（含前导括号），不认 WITH 与写语句", () => {
    expect(isReadOnlyStatement("select 1")).toBe(true);
    expect(isReadOnlyStatement("  (select `a` from `t`) union (select `a` from `u`)")).toBe(true);
    expect(isReadOnlyStatement("SELECT 1")).toBe(true);
    expect(isReadOnlyStatement("insert into `t` values (?)")).toBe(false);
    expect(isReadOnlyStatement("update `t` set `a` = ?")).toBe(false);
    expect(isReadOnlyStatement("with x as (select 1) delete from `t`")).toBe(false);
    expect(isReadOnlyStatement("selection")).toBe(false);
  });

  it("连接级失败认 fatal 标记与断链类错误码，库拒绝语句不算", () => {
    expect(isConnectionFailure(connectionLost())).toBe(true);
    expect(isConnectionFailure(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(isConnectionFailure(Object.assign(new Error("x"), { code: "EPIPE" }))).toBe(true);
    expect(isConnectionFailure(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe(true);
    expect(
      isConnectionFailure(Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY", fatal: false }))
    ).toBe(false);
    expect(isConnectionFailure("boom")).toBe(false);
  });

  it("交给 drizzle 的对象按连接池处理：有 getConnection、没有 promise；事务连接没有 getConnection", async () => {
    const pool = createFakePool();
    const guarded = guardPool(pool.source, { timeoutMs: 50 });
    expect("getConnection" in guarded).toBe(true);
    expect("promise" in guarded).toBe(false);
    const connection = await guarded.getConnection();
    expect("getConnection" in connection).toBe(false);
    expect("promise" in connection).toBe(false);
    connection.release();
  });
});

describe("语句守卫：非事务语句", () => {
  it("成功路径：结果原样返回，连接归还一次、不销毁", async () => {
    const rows = [[{ id: 1 }], []];
    const pool = createFakePool([[{ rows }]]);
    const guarded = guardPool(pool.source, { timeoutMs: 50 });

    await expect(guarded.query({ sql: "select 1" }, [])).resolves.toBe(rows);
    expect(pool.connections).toHaveLength(1);
    expect(pool.connections[0].released).toBe(1);
    expect(pool.connections[0].destroyed).toBe(0);
  });

  it("写语句超时：销毁那条连接，以 DB_STATEMENT_TIMEOUT 拒绝，且不重试", async () => {
    const pool = createFakePool([["hang"]]);
    const guarded = guardPool(pool.source, { timeoutMs: 30 });

    const startedAt = Date.now();
    const error = await guarded.query({ sql: "update `t` set `a` = ?" }, [1]).then(
      () => null,
      (failure: unknown) => failure
    );
    expect(codeOf(error)).toBe(STATEMENT_TIMEOUT_CODE);
    expect((error as { fatal?: unknown }).fatal).toBe(true);
    // 到点即拒绝，不等那条挂住的语句。
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(pool.connections).toHaveLength(1);
    expect(pool.connections[0].destroyed).toBe(1);
    expect(pool.connections[0].released).toBe(0);
  });

  it("只读语句超时后在新连接上重试一次并成功：旧连接销毁、新连接归还", async () => {
    const rows = [[{ rating: 1500 }], []];
    const pool = createFakePool([["hang"], [{ rows }]]);
    const retried: string[] = [];
    const guarded = guardPool(pool.source, {
      timeoutMs: 30,
      onRetry: ({ statement, error }) => {
        retried.push(statement);
        expect((error as { code?: unknown }).code).toBe(STATEMENT_TIMEOUT_CODE);
      },
    });

    await expect(guarded.query({ sql: "select `rating` from `r`" }, [])).resolves.toBe(rows);
    expect(retried).toEqual(["select `rating` from `r`"]);
    expect(pool.connections).toHaveLength(2);
    expect(pool.connections[0].destroyed).toBe(1);
    expect(pool.connections[0].released).toBe(0);
    expect(pool.connections[1].released).toBe(1);
    expect(pool.connections[1].destroyed).toBe(0);
  });

  it("只读语句只重试一次：两次都断链就把第二次的失败交给调用方", async () => {
    const pool = createFakePool([[{ error: connectionLost() }], [{ error: connectionLost() }]]);
    const guarded = guardPool(pool.source, { timeoutMs: 50 });

    await expect(guarded.execute("select 1", [])).rejects.toMatchObject({
      code: "PROTOCOL_CONNECTION_LOST",
    });
    expect(pool.connections).toHaveLength(2);
    expect(pool.connections.map((connection) => connection.destroyed)).toEqual([1, 1]);
  });

  it("写语句断链不重试，坏连接销毁而不是归还", async () => {
    const pool = createFakePool([[{ error: connectionLost() }]]);
    const retried: string[] = [];
    const guarded = guardPool(pool.source, {
      timeoutMs: 50,
      onRetry: ({ statement }) => retried.push(statement),
    });

    await expect(
      guarded.query({ sql: "insert into `t` (`a`) values (?)" }, [1])
    ).rejects.toMatchObject({ code: "PROTOCOL_CONNECTION_LOST" });
    expect(retried).toEqual([]);
    expect(pool.connections).toHaveLength(1);
    expect(pool.connections[0].destroyed).toBe(1);
    expect(pool.connections[0].released).toBe(0);
  });

  it("库拒绝语句（非连接级失败）不重试，连接完好归还", async () => {
    const duplicate = Object.assign(new Error("Duplicate entry"), {
      code: "ER_DUP_ENTRY",
      fatal: false,
    });
    const pool = createFakePool([[{ error: duplicate }]]);
    const guarded = guardPool(pool.source, { timeoutMs: 50 });

    await expect(guarded.query({ sql: "select 1" }, [])).rejects.toBe(duplicate);
    expect(pool.connections).toHaveLength(1);
    expect(pool.connections[0].released).toBe(1);
    expect(pool.connections[0].destroyed).toBe(0);
  });

  it("借连接本身超时也按截止时间拒绝；迟到的连接原样归还，不泄漏", async () => {
    const pool = createFakePool();
    const release = pool.holdAcquire();
    const guarded = guardPool(pool.source, { timeoutMs: 20 });

    await expect(guarded.query({ sql: "update `t` set `a` = 1" })).rejects.toMatchObject({
      code: STATEMENT_TIMEOUT_CODE,
    });
    release();
    await Bun.sleep(5);
    expect(pool.connections).toHaveLength(1);
    expect(pool.connections[0].statements).toEqual([]);
    expect(pool.connections[0].released).toBe(1);
  });

  it("截止时间为 null 时不限：慢语句照常返回并归还连接", async () => {
    const slow = deferred<unknown>();
    let released = 0;
    let destroyed = 0;
    const source: ConnectionSource = {
      getConnection: async () => ({
        query: () => slow.promise,
        execute: () => slow.promise,
        release: () => {
          released += 1;
        },
        destroy: () => {
          destroyed += 1;
        },
      }),
    };
    const pending = guardPool(source, { timeoutMs: null }).query({
      sql: "alter table `t` add index `i` (`a`)",
    });
    await Bun.sleep(30);
    slow.resolve("done");
    await expect(pending).resolves.toBe("done");
    expect(released).toBe(1);
    expect(destroyed).toBe(0);
  });
});

describe("语句守卫：事务连接（经真实 drizzle 会话）", () => {
  it("成功路径：BEGIN、语句、COMMIT 在同一条连接上，结束后归还一次", async () => {
    const pool = createFakePool([[{ rows: [{}, []] }, { rows: [[], []] }, { rows: [{}, []] }]]);
    const db = drizzleOver(pool.source, 50);

    await db.transaction(async (tx) => {
      await tx.select().from(schema.appSetting).where(eq(schema.appSetting.key, "k"));
    });
    expect(pool.connections).toHaveLength(1);
    const [connection] = pool.connections;
    expect(connection.statements[0]).toBe("begin");
    expect(connection.statements[1]).toStartWith("select");
    expect(connection.statements[2]).toBe("commit");
    expect(connection.released).toBe(1);
    expect(connection.destroyed).toBe(0);
  });

  it("事务内语句超时：销毁连接、不重试，调用方拿到超时而不是「回滚失败」", async () => {
    const pool = createFakePool([[{ rows: [{}, []] }, "hang"]]);
    const db = drizzleOver(pool.source, 30);

    const error = await db
      .transaction(async (tx) => {
        await tx.select().from(schema.appSetting).where(eq(schema.appSetting.key, "k"));
      })
      .then(
        () => null,
        (failure: unknown) => failure
      );
    expect(codeOf(error)).toBe(STATEMENT_TIMEOUT_CODE);
    // 不重试：只借过一条连接，上面只发出 BEGIN 与那条挂住的语句；ROLLBACK 不再发往已断开的连接。
    expect(pool.connections).toHaveLength(1);
    const [connection] = pool.connections;
    expect(connection.statements).toHaveLength(2);
    expect(connection.statements[1]).toStartWith("select");
    expect(connection.destroyed).toBe(1);
    expect(connection.released).toBe(0);
  });

  it("事务内只读语句断链也不重试", async () => {
    const pool = createFakePool([[{ rows: [{}, []] }, { error: connectionLost() }]]);
    const retried: string[] = [];
    const db = drizzle({
      client: guardPool(pool.source, {
        timeoutMs: 50,
        onRetry: ({ statement }) => retried.push(statement),
      }),
      schema,
      mode: "default",
    } as never) as unknown as DatabaseClient;

    const error = await db
      .transaction(async (tx) => {
        await tx.select().from(schema.appSetting);
      })
      .then(
        () => null,
        (failure: unknown) => failure
      );
    expect(codeOf(error)).toBe("PROTOCOL_CONNECTION_LOST");
    expect(retried).toEqual([]);
    expect(pool.connections).toHaveLength(1);
    expect(pool.connections[0].destroyed).toBe(1);
    expect(pool.connections[0].released).toBe(0);
  });

  it("事务内库拒绝语句：照常发 ROLLBACK 并归还连接", async () => {
    const duplicate = Object.assign(new Error("Duplicate entry"), {
      code: "ER_DUP_ENTRY",
      fatal: false,
    });
    const pool = createFakePool([[{ rows: [{}, []] }, { error: duplicate }]]);
    const db = drizzleOver(pool.source, 50);

    const error = await db
      .transaction(async (tx) => {
        await tx.insert(schema.appSetting).values({ key: "k", value: "v" });
      })
      .then(
        () => null,
        (failure: unknown) => failure
      );
    expect(rootOf(error)).toBe(duplicate);
    const [connection] = pool.connections;
    expect(connection.statements.at(-1)).toBe("rollback");
    expect(connection.released).toBe(1);
    expect(connection.destroyed).toBe(0);
  });
});

describe("createDatabase 接入语句守卫", () => {
  it("连通性检查的 SELECT 1 遇连接级失败会在新连接上重试一次", async () => {
    const retried: string[] = [];
    // 端口 1 必然被拒：连接失败是瞬时的，mysql2 把它标成 fatal。
    const database = createDatabase("mysql://user:pass@127.0.0.1:1/bakagame", {
      attempts: 1,
      onStatementRetry: ({ statement }) => retried.push(statement),
    });
    try {
      await expect(database.ready).rejects.toThrow("Failed query: SELECT 1");
      expect(retried).toEqual(["SELECT 1"]);
    } finally {
      await database.close();
    }
  });
});
