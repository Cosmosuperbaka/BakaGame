import { describe, expect, test } from "bun:test";

import { DatabaseUserSettingRepository } from "../src/infrastructure/db/UserSettingRepository";
import { createDrizzleStub, stamp, tupleOf } from "./DrizzleStub";

const T0 = Date.parse("2026-01-02T03:04:05.678Z");
const NOW = new Date(T0);

describe("云同步设置仓储（连接桩）", () => {
  test("只读回该账号的键值，不带上 userId 列", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseUserSettingRepository(stub.database);
    stub.reply([tupleOf("player", { nickname: "小明" }, stamp(T0))]);

    const rows = await repository.list("u1");
    expect(rows).toEqual([{ key: "player", value: { nickname: "小明" }, updatedAt: NOW }]);

    const query = stub.queryAt(0);
    expect(query.statement).toBe(
      "select `setting_key`, `value`, `updated_at` from `user_setting` where `user_setting`.`user_id` = ?"
    );
    expect(query.params).toEqual(["u1"]);
  });

  test("写入按主键整体覆盖，只替换 value 与更新时间", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseUserSettingRepository(stub.database);

    await repository.put("u1", "player", { nickname: "小明" }, NOW);
    const query = stub.queryAt(0);
    expect(query.statement).toContain("insert into `user_setting`");
    expect(query.statement.split("on duplicate key update")[1]).toBe(
      " `value` = ?, `updated_at` = ?"
    );
    // JSON 列在驱动边界序列化，冲突时 value 与更新时间各再进一次占位符。
    expect(query.params).toEqual([
      "u1",
      "player",
      JSON.stringify({ nickname: "小明" }),
      stamp(T0),
      JSON.stringify({ nickname: "小明" }),
      stamp(T0),
    ]);
  });

  test("删除按 (userId, key) 双条件，不会误删别人的同名键", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseUserSettingRepository(stub.database);

    await repository.remove("u1", "player");
    const query = stub.queryAt(0);
    expect(query.statement).toBe(
      "delete from `user_setting` where (`user_setting`.`user_id` = ? and `user_setting`.`setting_key` = ?)"
    );
    expect(query.params).toEqual(["u1", "player"]);
  });
});
