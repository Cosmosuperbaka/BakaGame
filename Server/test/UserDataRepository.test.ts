import { describe, expect, test } from "bun:test";

import {
  DatabaseFeedbackRepository,
  DatabaseUserSettingRepository,
  type FeedbackRecord,
} from "../src/infrastructure/db/UserDataRepository";
import { createDrizzleStub, rowOf, schema, stamp, tupleOf } from "./DrizzleStub";

const T0 = Date.parse("2026-01-02T03:04:05.678Z");
const NOW = new Date(T0);

const feedbackRow = (overrides: Record<string, unknown> = {}) =>
  rowOf(schema.feedback, {
    id: "fb-1",
    userId: "u1",
    kind: "bug",
    title: "播放器卡住",
    content: "点击播放没有声音",
    status: "open",
    page: "/songuessr",
    userAgent: "BakaGame-Client/1.0",
    sentryEventId: null,
    lastReplyAt: null,
    userSeenAt: null,
    createdAt: stamp(T0),
    updatedAt: stamp(T0),
    ...overrides,
  });

const feedbackRecord = (overrides: Partial<FeedbackRecord> = {}): FeedbackRecord => ({
  id: "fb-1",
  userId: "u1",
  kind: "bug",
  title: "播放器卡住",
  content: "点击播放没有声音",
  status: "open",
  page: "/songuessr",
  userAgent: "BakaGame-Client/1.0",
  sentryEventId: null,
  lastReplyAt: null,
  userSeenAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

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

describe("反馈仓储（连接桩）", () => {
  test("新建按实体原样落库，匿名反馈的 userId 写成 null", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseFeedbackRepository(stub.database);

    await repository.create(feedbackRecord({ userId: null }));
    const query = stub.queryAt(0);
    expect(query.statement).toContain("insert into `feedback`");
    expect(query.params.slice(0, 3)).toEqual(["fb-1", null, "bug"]);
    expect(query.params).toHaveLength(13);
  });

  test("更新只带补丁字段，读回时补上 updated_at", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseFeedbackRepository(stub.database);

    await repository.update("fb-1", { status: "resolved", updatedAt: NOW });
    const query = stub.queryAt(0);
    expect(query.statement).toContain("update `feedback` set `status` = ?");
    expect(query.params).toEqual(["resolved", stamp(T0), "fb-1"]);
  });

  test("读取单条缺失时返回 null", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseFeedbackRepository(stub.database);

    stub.reply([feedbackRow()]);
    expect(await repository.get("fb-1")).toMatchObject({ id: "fb-1", kind: "bug", status: "open" });
    expect(stub.queryAt(0).statement).toContain("limit ?");

    stub.reset();
    stub.reply([]);
    expect(await repository.get("missing")).toBeNull();
  });

  test("列表按状态/类型/账号叠加条件，计数与列表同条件", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseFeedbackRepository(stub.database);
    stub.reply([feedbackRow()], [tupleOf(3)]);

    const { items, total } = await repository.list({
      status: "open",
      kind: "bug",
      userId: "u1",
      limit: 10,
      offset: 20,
    });
    expect(items).toHaveLength(1);
    expect(total).toBe(3);

    const select = stub.queryAt(0);
    expect(select.statement).toContain("`feedback`.`status` = ?");
    expect(select.statement).toContain("`feedback`.`kind` = ?");
    expect(select.statement).toContain("`feedback`.`user_id` = ?");
    expect(select.statement).toContain("order by `feedback`.`created_at` desc");
    expect(select.params).toEqual(["open", "bug", "u1", 10, 20]);
    expect(stub.queryAt(1).params).toEqual(["open", "bug", "u1"]);
  });

  test("无筛选条件时不拼空的 where，总数按全表计", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseFeedbackRepository(stub.database);
    stub.reply([], [tupleOf(0)]);

    await repository.list({ limit: 5, offset: 0 });
    expect(stub.queryAt(0).statement).not.toContain("where");
    expect(stub.queryAt(0).params).toEqual([5]);
  });

  test("未读只算「回复晚于本人查看」的条目，含从未看过的", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseFeedbackRepository(stub.database);
    stub.reply([tupleOf(2)]);

    expect(await repository.countUnread("u1")).toBe(2);
    const query = stub.queryAt(0);
    expect(query.statement).toContain("`feedback`.`last_reply_at` is not null");
    expect(query.statement).toContain(
      "(`feedback`.`user_seen_at` is null or `feedback`.`user_seen_at` < `feedback`.`last_reply_at`)"
    );
    expect(query.params).toEqual(["u1"]);
  });

  test("概览计数没有记录的状态不出现在结果里", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseFeedbackRepository(stub.database);
    stub.reply([tupleOf("open", "4"), tupleOf("resolved", "1")]);

    expect(await repository.countByStatus()).toEqual({ open: 4, resolved: 1 });
    expect(stub.queryAt(0).statement).toContain("group by `feedback`.`status`");
  });

  test("回复取回自增编号，列表按时间正序", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseFeedbackRepository(stub.database);

    stub.reply({ insertId: 88, affectedRows: 1 });
    const reply = await repository.addReply({
      feedbackId: "fb-1",
      authorId: "admin",
      content: "已修复",
      createdAt: NOW,
    });
    expect(reply).toEqual({
      feedbackId: "fb-1",
      authorId: "admin",
      content: "已修复",
      createdAt: NOW,
      id: 88,
    });
    expect(stub.queryAt(0).params).toEqual(["fb-1", "admin", "已修复", stamp(T0)]);

    stub.reset();
    stub.reply([rowOf(schema.feedbackReply, { id: 88, feedbackId: "fb-1", createdAt: stamp(T0) })]);
    const replies = await repository.replies("fb-1");
    expect(replies[0]).toMatchObject({ id: 88, feedbackId: "fb-1" });
    expect(stub.queryAt(0).statement).toContain("order by `feedback_reply`.`created_at`");
  });
});
