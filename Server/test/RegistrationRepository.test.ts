import { describe, expect, test } from "bun:test";

import { DatabaseRegistrationRepository } from "../src/infrastructure/db/RegistrationRepository";
import { createDrizzleStub, tupleOf } from "./DrizzleStub";

describe("注册序号仓储（连接桩）", () => {
  test("回填按 100 一批插入，序号沿用建号先后", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseRegistrationRepository(stub.database);

    stub.reply(Array.from({ length: 150 }, (_, index) => tupleOf(`u${index}`)));
    await repository.ensureAll();

    const probe = stub.queryAt(0);
    expect(probe.statement).toContain("left join `user_registration`");
    expect(probe.statement).toContain("where `user_registration`.`seq` is null");
    expect(probe.statement).toContain("order by `user`.`created_at` asc, `user`.`id` asc");
    expect(stub.queries).toHaveLength(3);
    expect(stub.queryAt(1).params).toHaveLength(100);
    expect(stub.queryAt(1).params.slice(0, 2)).toEqual(["u0", "u1"]);
    expect(stub.queryAt(2).params).toHaveLength(50);
    // 幂等：重复执行不报错，已有序号不被覆盖。
    expect(stub.queryAt(1).statement).toContain("insert ignore into `user_registration`");
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

  test("新号先等存量回填，避免拿到比老号更小的序号", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseRegistrationRepository(stub.database);
    stub.reply([], { insertId: 1, affectedRows: 1 }, [tupleOf(42)]);

    expect(await repository.register("u1")).toBe(42);
    expect(stub.queries).toHaveLength(3);
    expect(stub.queryAt(0).statement).toContain("from `user`");
    expect(stub.queryAt(1).statement).toContain("insert into `user_registration`");
    // 同一账号重复注册返回原序号：冲突时把 user_id 写回自身，自增列取 default 不动。
    expect(stub.queryAt(1).statement).toBe(
      "insert into `user_registration` (`seq`, `user_id`) values (default, ?) on duplicate key update `user_id` = ?"
    );
    expect(stub.queryAt(2).params).toEqual(["u1", 1]);
  });

  test("序号读不回来时报错，不返回 0 冒充有效序号", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseRegistrationRepository(stub.database);
    stub.reply([], { insertId: 1, affectedRows: 1 }, []);

    await expect(repository.register("u1")).rejects.toThrow("注册序号写入后读不回来");
  });

  test("先行者名单按序号升序取前 N", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseRegistrationRepository(stub.database);
    stub.reply([tupleOf("u1", 1), tupleOf("u2", 2)]);

    expect(await repository.earlyAdopters(2)).toEqual([
      { userId: "u1", serial: 1 },
      { userId: "u2", serial: 2 },
    ]);
    const query = stub.queryAt(0);
    expect(query.statement).toContain("where `user_registration`.`seq` <= ?");
    expect(query.statement).toContain("order by `user_registration`.`seq` asc");
    expect(query.params).toEqual([2]);
  });
});
