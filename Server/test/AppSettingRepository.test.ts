import { describe, expect, test } from "bun:test";

import { DatabaseAppSettingRepository } from "../src/infrastructure/db/AppSettingRepository";
import { createDrizzleStub, stamp, tupleOf } from "./DrizzleStub";

const T0 = Date.parse("2026-01-02T03:04:05.678Z");

describe("运行期设置仓储（连接桩）", () => {
  test("整表读按 key 归并，updated_at 解码成 Date，空来源记 null", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseAppSettingRepository(stub.database);
    stub.reply([
      tupleOf("enableGeneralUnblock", "true", "admin-1", stamp(T0)),
      tupleOf("enableAnonymousQqSearch", "false", null, stamp(T0)),
    ]);

    const all = await repository.loadAll();
    expect(all).toEqual({
      enableGeneralUnblock: { value: "true", updatedBy: "admin-1", updatedAt: new Date(T0) },
      enableAnonymousQqSearch: { value: "false", updatedBy: null, updatedAt: new Date(T0) },
    });
    expect(stub.queryAt(0).statement).toContain("from `app_setting`");
  });

  test("空表读回空记录，而不是 undefined", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseAppSettingRepository(stub.database);
    stub.reply([]);
    expect(await repository.loadAll()).toEqual({});
  });

  test("写入走 upsert，且 ON DUPLICATE 显式刷新 updated_at", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseAppSettingRepository(stub.database);

    await repository.set("enableGeneralUnblock", "false", "admin-2");

    const query = stub.queryAt(0);
    expect(query.statement).toContain("insert into `app_setting`");
    expect(query.statement).toContain("on duplicate key update");
    // 插入侧 key/value/updatedBy/updated_at，更新侧 value/updatedBy/updated_at。
    // updated_at 必须出现在更新侧的赋值里，否则重复写入不会刷新时间。
    expect(query.statement).toContain("`updated_at` = ?");
    expect(query.params[0]).toBe("enableGeneralUnblock");
    expect(query.params[1]).toBe("false");
    expect(query.params[2]).toBe("admin-2");
    expect(query.params[4]).toBe("false");
    expect(query.params[5]).toBe("admin-2");
    expect(query.params).toHaveLength(7);
    // 更新侧的 updated_at 是写入时刻的 UTC 时间戳，落在当前时间附近。
    const updatedAt = Date.parse(`${String(query.params[6]).replace(" ", "T")}Z`);
    expect(Math.abs(updatedAt - Date.now())).toBeLessThan(5_000);
  });

  test("系统写入 updatedBy 为 null 也原样落库", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseAppSettingRepository(stub.database);
    await repository.set("enableAnonymousQqSearch", "true", null);
    const query = stub.queryAt(0);
    expect(query.params[2]).toBeNull();
    expect(query.params[5]).toBeNull();
  });
});
