import { describe, expect, test } from "bun:test";

import { DatabaseRegistrationRepository } from "../src/infrastructure/db/RegistrationRepository";
import { createDrizzleStub, tupleOf } from "./DrizzleStub";

describe("注册序号仓储（连接桩）", () => {
  test("存量回填按注册时间分批连续编号", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseRegistrationRepository(stub.database);

    stub.reply(
      Array.from({ length: 150 }, (_, index) => tupleOf(`u${index}`)),
      [tupleOf(0)],
      { affectedRows: 100 },
      [tupleOf(100)]
    );
    await repository.ensureAll();

    const probe = stub.queryAt(0);
    expect(probe.statement).toContain("left join `user_registration`");
    expect(probe.statement).toContain("where `user_registration`.`seq` is null");
    expect(probe.statement).toContain("order by `user`.`created_at` asc, `user`.`id` asc");
    expect(stub.queries).toHaveLength(5);
    // 第一批从 1 起连续编号，一次插入 100 行。
    expect(stub.queryAt(1).statement).toContain("max(`seq`)");
    expect(stub.queryAt(2).statement).toContain("insert into `user_registration`");
    expect(stub.queryAt(2).params).toHaveLength(200);
    expect(stub.queryAt(2).params.slice(0, 4)).toEqual([1, "u0", 2, "u1"]);
    // 第二批接着当前最大值 100 往后编，不重头再来。
    expect(stub.queryAt(4).params.slice(0, 4)).toEqual([101, "u100", 102, "u101"]);
  });

  test("回填只跑一次；失败不留缓存，下一次调用重试", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseRegistrationRepository(stub.database);
    stub.reply([]);

    await Promise.all([repository.ensureAll(), repository.ensureAll()]);
    expect(stub.queries).toHaveLength(1);

    const failing = createDrizzleStub();
    const second = new DatabaseRegistrationRepository(failing.database);
    failing.reject(0, new Error("user table missing"));
    await expect(second.ensureAll()).rejects.toThrow(/select .* from `user`/);

    failing.reset();
    await second.ensureAll();
    expect(failing.queries).toHaveLength(1);
  });

  test("新号先等存量回填，再接在当前最大值之后", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseRegistrationRepository(stub.database);
    stub.reply([], [], [tupleOf(4)], { affectedRows: 1 }, [tupleOf(5)]);

    expect(await repository.register("u5")).toBe(5);
    expect(stub.queries).toHaveLength(5);
    expect(stub.queryAt(0).statement).toContain("from `user`");
    expect(stub.queryAt(3).statement).toBe(
      "insert into `user_registration` (`seq`, `user_id`) values (?, ?)"
    );
    expect(stub.queryAt(3).params).toEqual([5, "u5"]);
  });

  test("同一账号重复注册返回原序号，不再占一个新号", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseRegistrationRepository(stub.database);
    stub.reply([], [tupleOf(7)]);

    expect(await repository.register("u7")).toBe(7);
    expect(stub.queries).toHaveLength(2);
    expect(stub.queryAt(1).statement).toContain("where `user_registration`.`user_id` = ?");
  });

  test("撞号重试耗尽后抛错，不返回假序号", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseRegistrationRepository(stub.database);
    stub.reply([]);
    stub.fallback((query) => {
      if (query.statement.startsWith("insert")) {
        throw Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });
      }
      return query.statement.includes("max(") ? [tupleOf(0)] : [];
    });

    await expect(repository.register("u1")).rejects.toThrow(/Failed query: insert/);
  });

  test("序号读不回来时报错，不返回 0 冒充有效序号", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseRegistrationRepository(stub.database);
    stub.reply([], [], [tupleOf(0)], { affectedRows: 1 }, []);

    await expect(repository.register("u1")).rejects.toThrow("注册序号写入后读不回来");
  });

  test("先行者名单按序号升序取前 N，不看序号数值", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseRegistrationRepository(stub.database);
    stub.reply([tupleOf("u1", 1), tupleOf("u2", 2)]);

    expect(await repository.earlyAdopters(2)).toEqual([
      { userId: "u1", serial: 1 },
      { userId: "u2", serial: 2 },
    ]);
    const query = stub.queryAt(0);
    expect(query.statement).toContain("order by `user_registration`.`seq` asc");
    expect(query.statement).toContain("limit ?");
    expect(query.params).toEqual([2]);
  });
});
