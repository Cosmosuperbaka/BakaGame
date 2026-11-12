import { describe, expect, test } from "bun:test";

import {
  DatabaseRegistrationRepository,
  REGISTRATION_GAP_THRESHOLD,
} from "../src/infrastructure/db/RegistrationRepository";
import { createDrizzleStub, stamp, tupleOf, type StubQuery, type StubReply } from "./DrizzleStub";

/**
 * 注册序号表的有状态内存桩：在连接层解释仓储发出的那几条 SQL，主键冲突与事务回滚都与
 * 真库一致。这样回归用例断言的是「压实之后表里的序号」这一对外结果，而不是语句的先后。
 */
const createRegistrationDb = (seed: {
  /** 序号 → 账号。 */
  serials: Array<[number, string]>;
  /** 有账号但还没序号的存量账号。 */
  unregistered?: string[];
  /** 账号创建时间（毫秒）；缺省按出现顺序递增。 */
  createdAt?: Record<string, number>;
}) => {
  const rows = new Map<number, string>(seed.serials);
  const pending = [...(seed.unregistered ?? [])];
  const created = new Map<string, number>();
  let tick = 1_000;
  for (const [, id] of seed.serials) created.set(id, seed.createdAt?.[id] ?? (tick += 1_000));
  for (const id of pending) created.set(id, seed.createdAt?.[id] ?? (tick += 1_000));
  let snapshot: Array<[number, string]> | null = null;
  const stub = createDrizzleStub();
  const hooks = {
    /** 在事务提交前插入别的连接的写入，模拟压实期间的并发建号。 */
    beforeCommit: (() => {}) as () => void,
    failOnUpdateNumber: 0,
  };
  let updates = 0;
  const duplicate = (): Error =>
    Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062 });
  const sorted = (): Array<[number, string]> => [...rows].sort((a, b) => a[0] - b[0]);

  type Handler = [match: (sql: string) => boolean, run: (query: StubQuery) => StubReply];
  const handlers: Handler[] = [
    [
      (sql) => sql === "begin",
      () => {
        snapshot = sorted();
        return { affectedRows: 0 };
      },
    ],
    [
      (sql) => sql === "commit",
      () => {
        hooks.beforeCommit();
        snapshot = null;
        return { affectedRows: 0 };
      },
    ],
    [
      (sql) => sql === "rollback",
      () => {
        rows.clear();
        for (const [seq, id] of snapshot ?? []) rows.set(seq, id);
        snapshot = null;
        return { affectedRows: 0 };
      },
    ],
    [
      (sql) => sql.startsWith("select `seq`, `user_id` from `user_registration`"),
      () => sorted().map(([seq, id]) => tupleOf(seq, id)),
    ],
    [
      (sql) => sql.startsWith("update `user_registration` set `seq` = ?"),
      (query) => {
        updates += 1;
        if (hooks.failOnUpdateNumber === updates) throw new Error("connection lost");
        const [next, previous] = query.params as [number, number];
        const owner = rows.get(previous);
        if (owner === undefined) return { affectedRows: 0 };
        if (rows.has(next)) throw duplicate();
        rows.delete(previous);
        rows.set(next, owner);
        return { affectedRows: 1 };
      },
    ],
    [
      (sql) => sql.startsWith("select max("),
      () => [tupleOf(rows.size ? Math.max(...rows.keys()) : null)],
    ],
    [
      (sql) => sql.includes("left join `user_registration`"),
      () => pending.map((id) => tupleOf(id)),
    ],
    [
      (sql) => sql.startsWith("insert into `user_registration`"),
      (query) => {
        const values = query.params as Array<number | string>;
        const batch: Array<[number, string]> = [];
        for (let index = 0; index < values.length; index += 2) {
          batch.push([values[index] as number, values[index + 1] as string]);
        }
        if (batch.some(([seq]) => rows.has(seq))) throw duplicate();
        for (const [seq, id] of batch) {
          rows.set(seq, id);
          const at = pending.indexOf(id);
          if (at >= 0) pending.splice(at, 1);
          if (!created.has(id)) created.set(id, (tick += 1_000));
        }
        return { affectedRows: batch.length };
      },
    ],
    [
      (sql) => sql.includes("where `user_registration`.`user_id` = ?"),
      (query) => {
        const found = sorted().find(([, id]) => id === query.params[0]);
        return found ? [tupleOf(found[0])] : [];
      },
    ],
    [
      (sql) => sql.startsWith("select `user_id`, `seq` from `user_registration`"),
      (query) =>
        sorted()
          .slice(0, Number(query.params[0]))
          .map(([seq, id]) => tupleOf(id, seq)),
    ],
    [
      (sql) => sql.includes("inner join `user`"),
      () => sorted().map(([seq, id]) => tupleOf(seq, stamp(created.get(id) ?? 0))),
    ],
  ];
  stub.fallback((query: StubQuery) => {
    const handler = handlers.find(([match]) => match(query.statement));
    if (!handler) throw new Error(`桩不认识的语句：${query.statement}`);
    return handler[1](query);
  });

  const warnings: Array<{ message: string; context: Record<string, unknown> | undefined }> = [];
  const logger = {
    warn: (message: string, context?: Record<string, unknown>) =>
      warnings.push({ message, context }),
  };
  return {
    stub,
    hooks,
    warnings,
    repository: () => new DatabaseRegistrationRepository(stub.database, logger),
    serials: (): number[] => sorted().map(([seq]) => seq),
    updateCount: (): number => updates,
    insert: (seq: number, id: string): void => {
      rows.set(seq, id);
      created.set(id, (tick += 1_000));
    },
  };
};

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

const seedOf = (serials: number[]): Array<[number, string]> =>
  serials.map((seq) => [seq, `u${seq}`]);

describe("注册序号跳号压实", () => {
  test("自增预取留下的跳号被压成连续序号，并留下一条告警", async () => {
    const db = createRegistrationDb({ serials: seedOf([1, 2, 3, 4, 30_001, 30_002]) });

    await db.repository().ensureAll();

    expect(db.serials()).toEqual([1, 2, 3, 4, 5, 6]);
    const warning = db.warnings.find((entry) => entry.message.includes("压实"));
    expect(warning?.context).toMatchObject({ rows: 2, maxBefore: 30_002, maxAfter: 6 });
    // 明细只带序号变化，不带账号标识。
    expect(JSON.stringify(warning?.context)).not.toContain("u30001");
  });

  test("压实保持升序次序：序号跟着的账号不换人", async () => {
    const db = createRegistrationDb({ serials: seedOf([1, 2, 3, 4, 30_001, 30_002]) });
    const repository = db.repository();

    await repository.ensureAll();

    const early = await repository.earlyAdopters(10);
    expect(early.map((entry) => entry.userId)).toEqual([
      "u1",
      "u2",
      "u3",
      "u4",
      "u30001",
      "u30002",
    ]);
    expect(early.map((entry) => entry.serial)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("注销留下的小空洞原样保留，正常数据一个都不改也不告警", async () => {
    const db = createRegistrationDb({ serials: seedOf([1, 2, 4, 5]) });

    await db.repository().ensureAll();

    expect(db.serials()).toEqual([1, 2, 4, 5]);
    expect(db.updateCount()).toBe(0);
    expect(db.warnings).toEqual([]);
  });

  test("跳号之后又有小空洞：只压跳号，小空洞随后续整体前移后保留", async () => {
    const db = createRegistrationDb({ serials: seedOf([1, 2, 30_001, 30_003]) });

    await db.repository().ensureAll();

    expect(db.serials()).toEqual([1, 2, 3, 5]);
  });

  test("恰好等于阈值的差距算小空洞，超过一位才算跳号", async () => {
    const edge = createRegistrationDb({
      serials: seedOf([1, 1 + REGISTRATION_GAP_THRESHOLD]),
    });
    await edge.repository().ensureAll();
    expect(edge.serials()).toEqual([1, 1 + REGISTRATION_GAP_THRESHOLD]);

    const over = createRegistrationDb({
      serials: seedOf([1, 2 + REGISTRATION_GAP_THRESHOLD]),
    });
    await over.repository().ensureAll();
    expect(over.serials()).toEqual([1, 2]);
  });

  test("多段跳号逐段压实；序号起点本身是跳号值时也从 1 起", async () => {
    const db = createRegistrationDb({
      serials: seedOf([30_001, 30_002, 60_001, 60_002, 60_005, 90_001]),
    });

    await db.repository().ensureAll();

    expect(db.serials()).toEqual([1, 2, 3, 4, 7, 8]);
  });

  test("空表与单行都不出错", async () => {
    const empty = createRegistrationDb({ serials: [] });
    await empty.repository().ensureAll();
    expect(empty.serials()).toEqual([]);
    expect(empty.warnings).toEqual([]);

    const single = createRegistrationDb({ serials: seedOf([1]) });
    await single.repository().ensureAll();
    expect(single.serials()).toEqual([1]);
    expect(single.updateCount()).toBe(0);
  });

  test("连续两次调用，第二次零改动、零告警", async () => {
    const db = createRegistrationDb({ serials: seedOf([1, 2, 3, 4, 30_001, 30_002]) });
    await db.repository().ensureAll();
    const updatesAfterFirst = db.updateCount();
    const warningsAfterFirst = db.warnings.length;

    // 同一实例（有缓存）与全新实例（模拟下一次启动）都是空操作。
    await db.repository().ensureAll();
    const again = db.repository();
    await again.ensureAll();
    await again.ensureAll();

    expect(db.serials()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(db.updateCount()).toBe(updatesAfterFirst);
    expect(db.warnings).toHaveLength(warningsAfterFirst);
  });

  test("压实之后新注册的账号拿到压实后最大值加一", async () => {
    const db = createRegistrationDb({ serials: seedOf([1, 2, 3, 4, 30_001, 30_002]) });
    const repository = db.repository();

    expect(await repository.register("fresh")).toBe(7);
    expect(db.serials()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("压实与存量回填同批启动：未登记账号接在压实后的末尾", async () => {
    const db = createRegistrationDb({
      serials: seedOf([1, 2, 30_001]),
      unregistered: ["old-a", "old-b"],
    });

    await db.repository().ensureAll();

    expect(db.serials()).toEqual([1, 2, 3, 4, 5]);
  });

  test("启动回填尚未完成时并发建号：新号排在压实之后，不再接在跳号后面", async () => {
    const db = createRegistrationDb({ serials: seedOf([1, 2, 3, 4, 30_001, 30_002]) });
    const repository = db.repository();

    const [, serial] = await Promise.all([repository.ensureAll(), repository.register("racer")]);

    expect(serial).toBe(7);
    expect(db.serials()).toEqual(range(1, 7));
  });

  test("别的实例在压实事务提交前抢先插入旧最大值之后的行：本次不撞主键，下次启动自愈", async () => {
    const db = createRegistrationDb({ serials: seedOf([1, 2, 3, 4, 30_001, 30_002]) });
    db.hooks.beforeCommit = () => {
      db.hooks.beforeCommit = () => {};
      db.insert(30_003, "racer");
    };

    await db.repository().ensureAll();
    expect(db.serials()).toEqual([1, 2, 3, 4, 5, 6, 30_003]);

    await db.repository().ensureAll();
    expect(db.serials()).toEqual(range(1, 7));
  });

  test("事务中途失败整体回滚，不留半压实的表；下一次调用重试成功", async () => {
    const db = createRegistrationDb({ serials: seedOf([1, 2, 3, 4, 30_001, 30_002]) });
    db.hooks.failOnUpdateNumber = 2;
    const repository = db.repository();

    await expect(repository.ensureAll()).rejects.toThrow(/Failed query: update/);
    expect(db.serials()).toEqual([1, 2, 3, 4, 30_001, 30_002]);

    db.hooks.failOnUpdateNumber = 0;
    await repository.ensureAll();
    expect(db.serials()).toEqual(range(1, 6));
  });
});

describe("注册序号次序自检", () => {
  test("序号顺序与账号创建时间相反的相邻对只告警数量，不改序号", async () => {
    const db = createRegistrationDb({
      serials: seedOf([1, 2, 3, 4]),
      createdAt: { u1: 100, u2: 300, u3: 200, u4: 50 },
    });

    await db.repository().ensureAll();

    expect(db.serials()).toEqual([1, 2, 3, 4]);
    const warning = db.warnings.find((entry) => entry.message.includes("次序"));
    expect(warning?.context).toEqual({ inversions: 2 });
  });

  test("次序一致时没有这条告警", async () => {
    const db = createRegistrationDb({ serials: seedOf([1, 2, 3]) });

    await db.repository().ensureAll();

    expect(db.warnings).toEqual([]);
  });
});
