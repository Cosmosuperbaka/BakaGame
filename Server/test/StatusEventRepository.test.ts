import { describe, expect, test } from "bun:test";

import { AppError } from "../src/domain/Errors";
import {
  DatabaseStatusEventRepository,
  isStatusEventActive,
  type StatusEventInput,
} from "../src/infrastructure/db/StatusEventRepository";
import { createDrizzleStub, rowOf, schema, stamp, tupleOf } from "./DrizzleStub";

const START = Date.parse("2026-01-02T03:04:05.678Z");

const dbRow = (overrides: Record<string, unknown> = {}) =>
  rowOf(schema.statusEvent, {
    id: 7,
    environment: "production",
    kind: "incident",
    title: "上游接口超时",
    body: "猜番查询持续超时",
    status: "investigating",
    components: JSON.stringify(["bangumi", "notAComponent"]),
    startedAt: stamp(START),
    plannedEndAt: null,
    resolvedAt: null,
    createdAt: stamp(START),
    updatedAt: stamp(START),
    ...overrides,
  });

const input = (overrides: Partial<StatusEventInput> = {}): StatusEventInput => ({
  kind: "maintenance",
  title: "计划维护",
  body: "数据库迁移",
  status: "scheduled",
  components: ["backend", "rooms"],
  startedAt: START,
  plannedEndAt: START + 3_600_000,
  resolvedAt: null,
  ...overrides,
});

describe("状态事件仓储（连接桩）", () => {
  test("列表按环境隔离，并把 UTC 毫秒与组件白名单还原成公开口径", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseStatusEventRepository(stub.database);
    stub.reply([dbRow()], [tupleOf(1)]);

    const { items, total } = await repository.list("production", {
      kind: "incident",
      since: START - 1000,
      limit: 20,
      offset: 40,
    });

    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      id: 7,
      kind: "incident",
      status: "investigating",
      components: ["bangumi"],
      startedAt: START,
      plannedEndAt: null,
      resolvedAt: null,
    });

    const select = stub.queryAt(0);
    expect(select.statement).toContain("where (`status_event`.`environment` = ?");
    expect(select.params).toEqual(["production", "incident", stamp(START - 1000), 20, 40]);
    expect(select.statement).toContain(
      "order by `status_event`.`started_at` desc, `status_event`.`id` desc"
    );
    // 计数与列表共用同一组条件，分页总数不会跨环境串味。
    const count = stub.queryAt(1);
    expect(count.statement).toContain("count(*)");
    expect(count.params).toEqual(select.params.slice(0, 3));
  });

  test("进行中只看 resolvedAt 与 done，故障与维护不再混为一谈", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseStatusEventRepository(stub.database);

    stub.reply([], [tupleOf(0)]);
    await repository.list("dev", { active: true, limit: 10, offset: 0 });
    expect(stub.queryAt(0).statement).toContain(
      "`status_event`.`resolved_at` is null and `status_event`.`status` <> 'done'"
    );

    stub.reset();
    stub.reply([], [tupleOf(0)]);
    await repository.list("dev", { active: false, limit: 10, offset: 0 });
    expect(stub.queryAt(0).statement).toContain(
      "(`status_event`.`resolved_at` is not null or `status_event`.`status` = 'done')"
    );
  });

  test("进行中的判定与查询口径同源", () => {
    const event = (overrides: Record<string, unknown>) => ({
      id: 1,
      kind: "incident" as const,
      title: "",
      body: "",
      status: "resolved" as const,
      components: [],
      startedAt: START,
      plannedEndAt: null,
      resolvedAt: null,
      updatedAt: START,
      ...overrides,
    });
    // 故障事件按恢复时刻判定，状态字段停在进行中也不算活跃。
    expect(isStatusEventActive(event({}))).toBe(true);
    expect(isStatusEventActive(event({ resolvedAt: START + 1 }))).toBe(false);
    // 维护窗口按 done 判定，即使已经写了结束时刻。
    expect(isStatusEventActive(event({ kind: "maintenance", status: "in_progress" }))).toBe(true);
    expect(isStatusEventActive(event({ kind: "maintenance", status: "done" }))).toBe(false);
  });

  test("未知状态与坏 JSON 组件退回可读缺省，不让状态页整块崩掉", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseStatusEventRepository(stub.database);
    stub.reply(
      [
        dbRow({ status: "teleporting", components: "not-json" }),
        dbRow({ id: 8, components: '["backend",123,{"a":1}]' }),
      ],
      [tupleOf(2)]
    );

    const { items } = await repository.list("production", { limit: 10, offset: 0 });
    expect(items[0]).toMatchObject({ status: "investigating", components: [] });
    expect(items[1]).toMatchObject({ status: "investigating", components: ["backend"] });
  });

  test("新建走自增编号回读，毫秒时间与组件序列按列落库", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseStatusEventRepository(stub.database);
    stub.reply({ insertId: 12, affectedRows: 1 }, [
      dbRow({ id: 12, kind: "maintenance", plannedEndAt: stamp(START + 3_600_000) }),
    ]);

    const created = await repository.create("dev", input());
    expect(created).toMatchObject({ id: 12, kind: "maintenance", plannedEndAt: START + 3_600_000 });

    const insert = stub.queryAt(0);
    expect(insert.statement).toContain("insert into `status_event`");
    // created_at / updated_at 由列的 $defaultFn 补齐，只断言业务字段的落库形态。
    expect(insert.params.slice(0, 9)).toEqual([
      "dev",
      "maintenance",
      "计划维护",
      "数据库迁移",
      "scheduled",
      JSON.stringify(["backend", "rooms"]),
      stamp(START),
      stamp(START + 3_600_000),
      null,
    ]);
    expect(insert.params).toHaveLength(11);
  });

  test("创建后读不回来按数据丢失报错，不返回半条事件", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseStatusEventRepository(stub.database);

    await expect(repository.create("dev", input())).rejects.toThrow(AppError);
    await expect(repository.create("dev", input())).rejects.toThrow("状态事件创建后读不回来");
  });

  test("更新只写传入字段，空补丁不发多余的 update", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseStatusEventRepository(stub.database);

    stub.reply([], [dbRow({ status: "resolved", resolvedAt: stamp(START + 60_000) })]);
    const updated = await repository.update("dev", 7, {
      status: "resolved",
      resolvedAt: START + 60_000,
    });
    expect(updated).toMatchObject({ status: "resolved", resolvedAt: START + 60_000 });
    expect(stub.queries).toHaveLength(2);
    const write = stub.queryAt(0);
    expect(write.statement).toContain("update `status_event` set `status` = ?");
    // 每次写都由 $onUpdateFn 顺带刷新 updated_at，状态页的「最后更新」才有依据。
    expect(write.params.slice(0, 2)).toEqual(["resolved", stamp(START + 60_000)]);
    expect(write.params.slice(-2)).toEqual(["dev", 7]);
    expect(String(write.params[2])).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);

    stub.reset();
    stub.reply([dbRow({ id: 7 })]);
    await repository.update("dev", 7, {});
    // 只剩一条读回，说明空补丁没有打出多余的写语句。
    expect(stub.queries).toHaveLength(1);
    expect(stub.queryAt(0).statement).toContain("where (`status_event`.`environment` = ?");
  });

  test("更新目标不存在时报 NOT_FOUND，删除按环境限定", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseStatusEventRepository(stub.database);

    await expect(repository.update("dev", 99, { title: "改名" })).rejects.toThrow(AppError);
    await expect(repository.update("dev", 99, { title: "改名" })).rejects.toThrow("状态事件不存在");

    stub.reset();
    await repository.remove("dev", 99);
    const last = stub.queryAt(0);
    expect(last.statement).toContain("delete from `status_event`");
    expect(last.params).toEqual(["dev", 99]);
  });

  test("数据库未就绪时读写整体失败，不会把半截语句打到池子上", async () => {
    const stub = createDrizzleStub({ ready: Promise.reject(new Error("migration failed")) });
    const repository = new DatabaseStatusEventRepository(stub.database);

    await expect(repository.list("dev", { limit: 10, offset: 0 })).rejects.toThrow(
      "migration failed"
    );
    expect(stub.queries).toHaveLength(0);
  });
});
