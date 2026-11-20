// ==================== 排位撮合与开赛的守护用例 ====================
// 「匹配中」的占位、人机选择出队、开赛失败回空闲、重新排队前自动离开结果页这几处，
// 其余用例没有盯住的细节。拆分服务内部结构时它们不许变。对局推进全靠夹具假时钟。
import { describe, expect, test } from "bun:test";
import {
  InMemoryCEERankedStore,
  type CEERankedRatingRecord,
} from "../src/application/CEERankedStore";
import { CEE_RANKED_START_DEADLINE_MS } from "../src/application/CEERankedMatchmaker";
import { AppError } from "../src/domain/Errors";
import { CEE_RANKED_BOT_FALLBACK_MS, CEE_RANKED_BOT_OPTION_MS } from "../src/shared/Index";
import { appErrorOf, rankedHarness, startBotSeries } from "./CEERankedFixtures";
import { deferred, type Deferred } from "./support/Deferred";

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 指定账号的评级读取在 `arm` 之后挂起，直到放行：把开赛卡在组装阶段。 */
class GatedUserRatingStore extends InMemoryCEERankedStore {
  private resolve: (() => void) | null = null;
  private gate: Promise<void> | null = null;

  constructor(private readonly gatedUserId: string) {
    super();
  }

  arm(): void {
    this.gate = new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }

  release(): void {
    this.resolve?.();
    this.gate = null;
  }

  override async getRating(userId: string): Promise<CEERankedRatingRecord | null> {
    if (userId === this.gatedUserId && this.gate) await this.gate;
    return super.getRating(userId);
  }
}

/** `holding` 打开后，每一次评级读取各自挂起，直到对应的闸门被放行：用来模拟连接被静默掐断。 */
class HoldingRatingStore extends InMemoryCEERankedStore {
  holding = false;
  readonly holds: Array<Deferred<void>> = [];

  override async getRating(userId: string): Promise<CEERankedRatingRecord | null> {
    if (this.holding) {
      const gate = deferred();
      this.holds.push(gate);
      await gate.promise;
    }
    return super.getRating(userId);
  }
}

/** 下一次评级读取抛错。 */
class FailingRatingStore extends InMemoryCEERankedStore {
  failNext = false;

  override async getRating(userId: string): Promise<CEERankedRatingRecord | null> {
    if (this.failNext) {
      this.failNext = false;
      throw new AppError("RANKED_STORE_UNAVAILABLE", "测试用评级读取失败");
    }
    return super.getRating(userId);
  }
}

describe("人机兜底开赛的占位", () => {
  test("兜底开赛组装期间：排队报忙、取消无效，开出后恢复", async () => {
    const store = new GatedUserRatingStore("u1");
    const harness = rankedHarness({ store });
    const client = harness.connect("甲", { account: { userId: "u1", image: null } });
    harness.seedRated("u1");
    await harness.send(client, "cee.ranked.queue", {});
    store.arm();
    await harness.advance(30_000);
    await yieldToEventLoop();

    const busy = await appErrorOf(() => harness.send(client, "cee.ranked.queue", {}));
    expect(busy.code).toBe("RANKED_STARTING");
    const frames = harness.states(client).length;
    await harness.send(client, "cee.ranked.cancel", {});
    expect(harness.states(client).length).toBe(frames);

    store.release();
    await harness.advance(0);
    expect(harness.seriesView(client).opponent.isBot).toBe(true);
  });
});

describe("选择人机", () => {
  test("选人机后开赛组装期间：已出队但状态仍读到排队态，再点人机不报错也不多开", async () => {
    const store = new GatedUserRatingStore("u1");
    const harness = rankedHarness({ store });
    const client = harness.connect("甲", { account: { userId: "u1", image: null } });
    harness.seedRated("u1");
    await harness.send(client, "cee.ranked.queue", {});
    const queuedAt = harness.clock();
    await harness.advance(CEE_RANKED_BOT_OPTION_MS);
    store.arm();
    const pending = harness.send(client, "cee.ranked.playBot", {});
    await yieldToEventLoop();

    // 刷新或重连读到的是「匹配中」（保留出队前的排队时刻），而不是会诱导去点「开始匹配」的空闲。
    const status = await harness.send(client, "cee.ranked.status", {});
    expect(status).toEqual({
      status: "queued",
      queuedAt,
      botAvailableAt: queuedAt + CEE_RANKED_BOT_OPTION_MS,
      botFallbackAt: queuedAt + CEE_RANKED_BOT_FALLBACK_MS,
      window: expect.any(Number),
    });
    // 那场人机正在开：再点一次直接忽略，不报「当前不在排队中」。
    expect(await harness.send(client, "cee.ranked.playBot", {})).toEqual({});
    // 排队仍报忙，文案不变。
    const busy = await appErrorOf(() => harness.send(client, "cee.ranked.queue", {}));
    expect({ code: busy.code, message: busy.message }).toEqual({
      code: "RANKED_STARTING",
      message: "正在为你开赛",
    });

    store.release();
    await pending;
    expect(harness.seriesView(client).opponent.isBot).toBe(true);
    expect(harness.states(client).filter((state) => state.status === "series")).toHaveLength(1);
  });

  test("定级直开组装期间：状态读到排队态，排队时刻是点下排队那一刻", async () => {
    const store = new GatedUserRatingStore("u1");
    store.arm();
    const harness = rankedHarness({ store });
    const client = harness.connect("甲", { account: { userId: "u1", image: null } });
    const queuedAt = harness.clock();
    const pending = harness.send(client, "cee.ranked.queue", {});
    await yieldToEventLoop();

    const status = await harness.send(client, "cee.ranked.status", {});
    expect(status).toMatchObject({ status: "queued", queuedAt });
    expect(await harness.send(client, "cee.ranked.playBot", {})).toEqual({});

    store.release();
    await pending;
    expect(harness.seriesView(client).opponent.isBot).toBe(true);
  });
});

describe("开赛组装的整体截止时间", () => {
  test("主动人机组装挂住：到点置回空闲并记错误日志；迟到的组装不开赛，也不释放重新排队后的占位", async () => {
    const store = new HoldingRatingStore();
    const harness = rankedHarness({ store });
    const client = harness.connect("甲", { account: { userId: "u1", image: null } });
    harness.seedRated("u1");
    await harness.send(client, "cee.ranked.queue", {});
    await harness.advance(CEE_RANKED_BOT_OPTION_MS);

    store.holding = true;
    const stuck = appErrorOf(() => harness.send(client, "cee.ranked.playBot", {}));
    await yieldToEventLoop();
    await harness.advance(CEE_RANKED_START_DEADLINE_MS);

    const timeout = await stuck;
    expect(timeout.code).toBe("RANKED_START_TIMEOUT");
    expect(harness.latest(client)).toEqual({ status: "idle" });
    expect(harness.logs.error).toEqual([
      {
        message: "排位开赛超时",
        detail: { userIds: ["u1"], deadlineMs: CEE_RANKED_START_DEADLINE_MS },
      },
    ]);

    // 置回空闲后马上重新排队，这一次的组装也还在途（第二道闸门）。
    const requeue = harness.send(client, "cee.ranked.queue", {});
    await yieldToEventLoop();
    expect(store.holds).toHaveLength(2);

    // 迟到的第一次组装此刻才读到评级：它已作废，既不开赛，也不能释放第二次的占位。
    store.holds[0].resolve();
    await harness.advance(0);
    expect(harness.states(client).some((state) => state.status === "series")).toBe(false);
    const busy = await appErrorOf(() => harness.send(client, "cee.ranked.queue", {}));
    expect(busy.code).toBe("RANKED_STARTING");

    store.holds[1].resolve();
    expect(await requeue).toEqual({});
    expect(harness.latest(client).status).toBe("queued");
    await harness.advance(0);
    expect(harness.states(client).some((state) => state.status === "series")).toBe(false);
  });

  test("超时兜底人机组装挂住：到点回空闲，只记一条超时日志，迟到结果不开赛", async () => {
    const store = new HoldingRatingStore();
    const harness = rankedHarness({ store });
    const client = harness.connect("甲", { account: { userId: "u1", image: null } });
    harness.seedRated("u1");
    await harness.send(client, "cee.ranked.queue", {});

    store.holding = true;
    await harness.advance(CEE_RANKED_BOT_FALLBACK_MS);
    expect(store.holds).toHaveLength(1);
    expect(harness.latest(client).status).toBe("queued");
    await harness.advance(CEE_RANKED_START_DEADLINE_MS);

    expect(harness.latest(client)).toEqual({ status: "idle" });
    expect(harness.logs.error.map((item) => item.message)).toEqual(["排位开赛超时"]);
    store.holding = false;
    store.holds[0].resolve();
    await harness.advance(0);
    expect(harness.latest(client)).toEqual({ status: "idle" });
    // 占位已清：能重新排队。
    await harness.send(client, "cee.ranked.queue", {});
    expect(harness.latest(client).status).toBe("queued");
  });

  test("定级直开组装挂住：到点回空闲，迟到结果不开赛", async () => {
    const store = new HoldingRatingStore();
    store.holding = true;
    const harness = rankedHarness({ store });
    const client = harness.connect("甲", { account: { userId: "u1", image: null } });
    const stuck = appErrorOf(() => harness.send(client, "cee.ranked.queue", {}));
    await yieldToEventLoop();
    await harness.advance(CEE_RANKED_START_DEADLINE_MS);

    expect((await stuck).code).toBe("RANKED_START_TIMEOUT");
    expect(harness.latest(client)).toEqual({ status: "idle" });
    store.holding = false;
    store.holds[0].resolve();
    await harness.advance(0);
    expect(harness.states(client).some((state) => state.status === "series")).toBe(false);
  });

  test("组装在截止前完成：照常开赛，截止计时器随之撤销", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    await harness.send(client, "cee.ranked.queue", {});
    expect(harness.seriesView(client).opponent.isBot).toBe(true);
    await harness.advance(CEE_RANKED_START_DEADLINE_MS);
    expect(harness.logs.error).toEqual([]);
    expect(harness.latest(client).status).toBe("series");
  });
});

describe("开赛失败与重新排队", () => {
  test("题库不足三题：人机开赛不成，记错误日志并回 idle", async () => {
    const harness = rankedHarness({ candidateIds: [11, 12] });
    const client = harness.connect("甲");
    await harness.send(client, "cee.ranked.queue", {});

    expect(harness.latest(client)).toEqual({ status: "idle" });
    expect(harness.logs.error.map((item) => item.message)).toContain("排位题库不足三题");
  });

  test("排队时评级读取失败：错误照常抛出，账号回 idle 且标记已清，能再次排队", async () => {
    const store = new FailingRatingStore();
    const harness = rankedHarness({ store });
    const client = harness.connect("甲");
    await harness.send(client, "cee.ranked.status", {});
    const frames = harness.states(client).length;
    store.failNext = true;
    const error = await appErrorOf(() => harness.send(client, "cee.ranked.queue", {}));
    expect(error.code).toBe("RANKED_STORE_UNAVAILABLE");
    expect(harness.states(client).length).toBe(frames + 1);
    expect(harness.latest(client)).toEqual({ status: "idle" });

    await harness.send(client, "cee.ranked.queue", {});
    expect(harness.latest(client).status).toBe("series");
  });

  test("结果页还留着时直接重新排队：先自动离开并推一帧 idle，再开新一场", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    const firstId = harness.seriesView(client).seriesId;
    await harness.send(client, "cee.ranked.exit", {});
    const before = harness.states(client).length;

    await harness.send(client, "cee.ranked.queue", {});
    const frames = harness.states(client).slice(before);
    expect(frames[0]).toEqual({ status: "idle" });
    expect(frames.at(-1)?.status).toBe("series");
    expect(harness.seriesView(client).seriesId).not.toBe(firstId);
  });
});
