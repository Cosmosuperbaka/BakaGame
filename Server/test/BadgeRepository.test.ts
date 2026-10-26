import { describe, expect, test } from "bun:test";

import { BADGE_CATALOG, BADGE_KINDS } from "../src/shared/Badges";
import { DatabaseBadgeRepository } from "../src/infrastructure/db/BadgeRepository";
import { createDrizzleStub, stamp, tupleOf } from "./DrizzleStub";

const T0 = Date.parse("2026-01-02T03:04:05.678Z");

describe("徽章仓储（连接桩）", () => {
  test("目录幂等补齐，并清掉已下线类型的授予关系", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseBadgeRepository(stub.database);

    await repository.ensureCatalog();
    const upserts = stub.queries.slice(0, BADGE_CATALOG.length);
    expect(upserts.every((query) => query.statement.startsWith("insert into `badge`"))).toBe(true);
    expect(upserts.every((query) => query.statement.includes("on duplicate key update"))).toBe(
      true
    );
    expect(upserts[0]?.params).toEqual([
      "owner",
      "主理人",
      expect.any(String),
      1,
      "主理人",
      expect.any(String),
      1,
    ]);

    const cleanup = stub.queryAt(BADGE_CATALOG.length);
    expect(cleanup.statement).toBe(
      `delete from \`badge\` where \`badge\`.\`id\` not in (${BADGE_KINDS.map(() => "?").join(", ")})`
    );
    expect(cleanup.params).toEqual([...BADGE_KINDS]);
  });

  test("并发补齐目录只跑一次，不重复打整批 upsert", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseBadgeRepository(stub.database);

    const first = repository.ensureCatalog();
    const second = repository.ensureCatalog();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(stub.queries).toHaveLength(BADGE_CATALOG.length + 1);
  });

  test("目录补齐失败不留缓存，下一次调用会重试", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseBadgeRepository(stub.database);
    stub.reject(0, new Error("badge table missing"));

    // drizzle 会把驱动层异常包成 Failed query，这里核对的是真正失败的那条语句。
    await expect(repository.ensureCatalog()).rejects.toThrow(/insert into `badge`/);

    stub.reset();
    await repository.ensureCatalog();
    expect(stub.queries).toHaveLength(BADGE_CATALOG.length + 1);
  });

  test("徽章按目录顺序分组，先行者带注册序号、其余不冒充序号", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseBadgeRepository(stub.database);
    stub.reply([
      tupleOf("u1", "owner", 1),
      tupleOf("u1", "pioneer", 7),
      tupleOf("u2", "pioneer", null),
      tupleOf("u2", "contributor", 55),
    ]);

    const grouped = await repository.badgesOfMany(["u1", "u1", "u2"]);
    expect([...grouped.keys()]).toEqual(["u1", "u2"]);
    expect(grouped.get("u1")).toEqual([
      { kind: "owner", serial: null },
      { kind: "pioneer", serial: 7 },
    ]);
    // 序号只属于先行者：缺行时也不会给别的徽章编一个号。
    expect(grouped.get("u2")).toEqual([
      { kind: "pioneer", serial: null },
      { kind: "contributor", serial: null },
    ]);

    const query = stub.queryAt(0);
    expect(query.statement).toContain("inner join `badge`");
    expect(query.statement).toContain("left join `user_registration`");
    expect(query.statement).toContain("order by `badge`.`sort_order` asc");
    expect(query.params).toEqual(["u1", "u2"]);
  });

  test("空用户列表不查库，单人读取复用批量口径", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseBadgeRepository(stub.database);

    expect((await repository.badgesOfMany([])).size).toBe(0);
    expect(stub.queries).toHaveLength(0);

    stub.reply([tupleOf("u1", "pioneer", 3)]);
    expect(await repository.badgesOf("u1")).toEqual([{ kind: "pioneer", serial: 3 }]);
  });

  test("授予在事务里补齐目录、写关系，只在没佩戴时让位", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseBadgeRepository(stub.database);

    await repository.grant("u1", "contributor", "admin", new Date(T0));

    const statements = stub.queries.map((query) => query.statement);
    expect(statements[0]).toContain("insert into `badge`");
    expect(statements[BADGE_CATALOG.length + 1]).toBe("begin");
    expect(statements.at(-1)).toBe("commit");
    const insert = stub.queryAt(BADGE_CATALOG.length + 2);
    expect(insert.statement).toContain("insert into `user_badge`");
    expect(insert.params).toEqual(["u1", "contributor", "admin", stamp(T0), "admin", stamp(T0)]);
    const equip = stub.queryAt(BADGE_CATALOG.length + 3);
    expect(equip.statement).toBe(
      "update `user` set `updated_at` = ?, `equipped_badge` = ? where (`user`.`id` = ? and `user`.`equipped_badge` is null)"
    );
    // 只在没有佩戴时让位：条件里的 is null 是玩家自选不被覆盖的保证。
    expect(equip.params.slice(1)).toEqual(["contributor", "u1"]);
  });

  test("吊销同时清授予关系与佩戴位", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseBadgeRepository(stub.database);

    await repository.revoke("u1", "owner");
    const remove = stub.queryAt(1);
    expect(remove.statement).toContain("delete from `user_badge`");
    expect(remove.params).toEqual(["u1", "owner"]);
    const unequip = stub.queryAt(2);
    expect(unequip.statement).toBe(
      "update `user` set `updated_at` = ?, `equipped_badge` = ? where (`user`.`id` = ? and `user`.`equipped_badge` = ?)"
    );
    expect(unequip.params.slice(1)).toEqual([null, "u1", "owner"]);
  });

  test("独占徽章保留指定账号，keepUserId 为空时整类清空", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseBadgeRepository(stub.database);

    await repository.resetExclusive("owner", "u1");
    const remove = stub.queryAt(BADGE_CATALOG.length + 2);
    expect(remove.statement).toContain(
      "`user_badge`.`badge_id` = ? and `user_badge`.`user_id` <> ?"
    );
    expect(remove.params).toEqual(["owner", "u1"]);
    const unequip = stub.queryAt(BADGE_CATALOG.length + 3);
    expect(unequip.params.slice(1)).toEqual([null, "owner", "u1"]);

    stub.reset();
    await repository.resetExclusive("owner", null);
    // 目录已经补齐过，这一次只剩事务本身的四条语句。
    expect(stub.queries).toHaveLength(4);
    const clear = stub.queryAt(1);
    expect(clear.statement).not.toContain("<>");
    expect(clear.params).toEqual(["owner"]);
    expect(stub.queryAt(2).params.slice(1)).toEqual([null, "owner"]);
  });
});
