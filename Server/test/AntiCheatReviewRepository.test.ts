import { describe, expect, test } from "bun:test";

import { CEE_ANTI_CHEAT_AGGREGATE_MAX_ITEMS } from "../src/application/CEEAntiCheatSignals";
import { AntiCheatReviewRepository } from "../src/infrastructure/db/AntiCheatReviewRepository";
import { createDrizzleStub, rowOf, schema, stamp, tupleOf } from "./DrizzleStub";

const T0 = Date.parse("2026-01-02T03:04:05.678Z");

const features = {
  intervals: [100, 120, 110],
  cv: 0.05,
  noSearchGuesses: 3,
  unmatchedSearches: 1,
  guesses: 4,
  firstGuessCorrect: true,
};

const review = (overrides: Record<string, unknown> = {}) => ({
  roomId: "1234",
  roomCreatedAt: T0,
  roundNumber: 2,
  playerId: "p1",
  playerName: "小明",
  userId: "u1",
  clientType: "web" as const,
  recordedAt: T0,
  score: 6,
  reasons: ["noSearchGuesses", "firstGuessCorrect"],
  features,
  ...overrides,
});

const reviewRow = (overrides: Record<string, unknown> = {}) =>
  rowOf(schema.ceeAntiCheatReview, {
    id: "r-1",
    roomId: "1234",
    roomCreatedAt: stamp(T0),
    roundNumber: 2,
    playerId: "p1",
    playerName: "小明",
    userId: "u1",
    clientType: "web",
    score: 6,
    reasons: ["noSearchGuesses"],
    features,
    status: "open",
    createdAt: stamp(T0),
    ...overrides,
  });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CEE 反作弊复核仓储（连接桩）", () => {
  test("add 异步落库，状态固定写 open，任何自动路径都不给处置结论", async () => {
    const stub = createDrizzleStub();
    const warnings: string[] = [];
    const repository = new AntiCheatReviewRepository(stub.database, (message) =>
      warnings.push(message)
    );

    repository.add(review() as never);
    await settle();

    const query = stub.queryAt(0);
    expect(query.statement).toContain("insert into `cee_anti_cheat_review`");
    expect(query.params[0]).toEqual(expect.any(String));
    expect(query.params.slice(1, 4)).toEqual(["1234", stamp(T0), 2]);
    expect(query.params).toContain("open");
    expect(query.params).toContain(JSON.stringify(["noSearchGuesses", "firstGuessCorrect"]));
    expect(query.params).toContain(JSON.stringify(features));
    expect(warnings).toEqual([]);
  });

  test("复核条目写入失败只记日志，不影响对局本身", async () => {
    const stub = createDrizzleStub();
    const warnings: string[] = [];
    const repository = new AntiCheatReviewRepository(stub.database, (message) =>
      warnings.push(message)
    );
    stub.reject(0, new Error("review table missing"));

    repository.add(review() as never);
    await settle();

    expect(warnings).toEqual(["反作弊复核条目写入失败"]);
  });

  test("列表按处置状态与时间过滤，分页参数被夹在可用区间", async () => {
    const stub = createDrizzleStub();
    const repository = new AntiCheatReviewRepository(stub.database);
    stub.reply([reviewRow()], [tupleOf(1)]);

    const { items, total } = await repository.list({
      status: "cleared",
      since: T0 - 1000,
      limit: 999,
      offset: -5,
    });
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      id: "r-1",
      roomCreatedAt: T0,
      recordedAt: T0,
      status: "open",
      reasons: ["noSearchGuesses"],
    });

    const query = stub.queryAt(0);
    expect(query.statement).toContain("order by `cee_anti_cheat_review`.`created_at` desc");
    // limit 上限 200、offset 不为负，防止后台被拿去做全表扫描。
    expect(query.params).toEqual(["cleared", stamp(T0 - 1000), 200]);
    expect(query.statement).not.toContain("offset");
  });

  test("缺省分页取 50 条，无筛选时不拼空 where", async () => {
    const stub = createDrizzleStub();
    const repository = new AntiCheatReviewRepository(stub.database);
    stub.reply([], [tupleOf(0)]);

    await repository.list();
    expect(stub.queryAt(0).statement).not.toContain("where");
    expect(stub.queryAt(0).params).toEqual([50]);
  });

  test("近窗展开：登录账号按 userId 归并", async () => {
    const stub = createDrizzleStub();
    const repository = new AntiCheatReviewRepository(stub.database);
    stub.reply([tupleOf("u1", "小明")], [reviewRow()]);

    const items = await repository.aggregateFor("r-1", T0 - 60_000);
    expect(items).toHaveLength(1);

    const probe = stub.queryAt(0);
    expect(probe.params).toEqual(["r-1", 1]);
    const window = stub.queryAt(1);
    expect(window.statement).toContain("`cee_anti_cheat_review`.`user_id` = ?");
    expect(window.statement).not.toContain("is null");
    expect(window.params).toEqual(["u1", stamp(T0 - 60_000), CEE_ANTI_CHEAT_AGGREGATE_MAX_ITEMS]);
  });

  test("近窗展开：游客只与同样没有账号的同昵称条目相比", async () => {
    const stub = createDrizzleStub();
    const repository = new AntiCheatReviewRepository(stub.database);
    stub.reply([tupleOf(null, "小明")], []);

    expect(await repository.aggregateFor("r-1", T0)).toEqual([]);
    const window = stub.queryAt(1);
    expect(window.statement).toContain("`cee_anti_cheat_review`.`user_id` is null");
    expect(window.params).toEqual(["小明", stamp(T0), CEE_ANTI_CHEAT_AGGREGATE_MAX_ITEMS]);
  });

  test("基准条目不在队列里时不展开，也不发第二条查询", async () => {
    const stub = createDrizzleStub();
    const repository = new AntiCheatReviewRepository(stub.database);
    stub.reply([]);

    expect(await repository.aggregateFor("missing", T0)).toEqual([]);
    expect(stub.queries).toHaveLength(1);
  });

  test("存在性只按主键探测一条，处置状态由人改", async () => {
    const stub = createDrizzleStub();
    const repository = new AntiCheatReviewRepository(stub.database);

    stub.reply([tupleOf("r-1")]);
    expect(await repository.exists("r-1")).toBe(true);
    expect(stub.queryAt(0).params).toEqual(["r-1", 1]);

    stub.reset();
    stub.reply([]);
    expect(await repository.exists("nope")).toBe(false);

    stub.reset();
    await repository.setStatus("r-1", "actioned");
    expect(stub.queryAt(0).statement).toContain("update `cee_anti_cheat_review` set `status` = ?");
    expect(stub.queryAt(0).params).toEqual(["actioned", "r-1"]);
  });

  test("迁移未就绪时读写整体失败，队列退回不写而不是半写", async () => {
    const stub = createDrizzleStub({ ready: Promise.reject(new Error("db down")) });
    const warnings: string[] = [];
    const repository = new AntiCheatReviewRepository(stub.database, (message) =>
      warnings.push(message)
    );

    await expect(repository.list()).rejects.toThrow("db down");
    repository.add(review() as never);
    await settle();
    expect(warnings).toEqual(["反作弊复核条目写入失败"]);
    expect(stub.queries).toHaveLength(0);
  });
});
