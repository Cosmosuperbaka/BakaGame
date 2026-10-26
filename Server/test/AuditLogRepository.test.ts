import { describe, expect, test } from "bun:test";

import { DatabaseAuditLogRepository } from "../src/infrastructure/db/AuditLogRepository";
import { createDrizzleStub, rowOf, schema, stamp, tupleOf } from "./DrizzleStub";

const T0 = Date.parse("2026-01-02T03:04:05.678Z");

describe("审计流水仓储（连接桩）", () => {
  test("追加写入强制不记 IP，detail 以 JSON 落库", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseAuditLogRepository(stub.database);

    await repository.append({
      actorId: "admin",
      action: "admin.room.close",
      targetType: "room",
      targetId: "1234",
      detail: { reason: "违规" },
      createdAt: new Date(T0),
    });

    const query = stub.queryAt(0);
    expect(query.statement).toContain("insert into `audit_log`");
    // X-Forwarded-For 可被伪造，记下来只会误导追查，因此这一列永远是 null。
    expect(query.params).toEqual([
      "admin",
      "admin.room.close",
      "room",
      "1234",
      JSON.stringify({ reason: "违规" }),
      null,
      stamp(T0),
    ]);
  });

  test("系统动作的 actorId 与空 detail 原样落库", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseAuditLogRepository(stub.database);

    await repository.append({
      actorId: null,
      action: "system.boot",
      targetType: "server",
      targetId: "-",
      detail: null,
      createdAt: new Date(T0),
    });
    expect(stub.queryAt(0).params.slice(0, 5)).toEqual([null, "system.boot", "server", "-", null]);
  });

  test("列表叠加全部筛选条件，计数与列表同条件", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseAuditLogRepository(stub.database);
    stub.reply(
      [rowOf(schema.auditLog, { id: 5, createdAt: stamp(T0), action: "admin.room.close" })],
      [tupleOf(1)]
    );

    const { items, total } = await repository.list({
      actorId: "admin",
      action: "admin.room.close",
      targetType: "room",
      targetId: "1234",
      since: new Date(T0),
      limit: 10,
      offset: 20,
    });
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ id: 5, action: "admin.room.close", detail: null });
    // 读回时不带上 ip_address 列，审计列表接口拿不到这个字段。
    expect(items[0]).not.toHaveProperty("ipAddress");

    const select = stub.queryAt(0);
    expect(select.statement).toContain("order by `audit_log`.`created_at` desc");
    expect(select.params).toEqual(["admin", "admin.room.close", "room", "1234", stamp(T0), 10, 20]);
    expect(stub.queryAt(1).params).toEqual(select.params.slice(0, 5));
  });

  test("无筛选时不拼空 where", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseAuditLogRepository(stub.database);
    stub.reply([], [tupleOf(0)]);

    const { items, total } = await repository.list({ limit: 5, offset: 0 });
    expect(items).toEqual([]);
    expect(total).toBe(0);
    expect(stub.queryAt(0).statement).not.toContain("where");
  });
});
