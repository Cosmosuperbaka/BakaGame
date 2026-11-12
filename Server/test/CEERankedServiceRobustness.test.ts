// ==================== 排位开赛与结算的容错用例 ====================
// 这一批只盯几处易错的路径：一跳里有一场开失败不能带走整跳、正在开赛时排队报忙而取消无效、
// 开赛窗口里断线的那一场照常开出、结算写库不能压住命令 ACK。对局推进全靠夹具假时钟。
import { describe, expect, test } from "bun:test";
import {
  InMemoryCEERankedStore,
  type CEERankedRatingRecord,
  type CEERankedSettlementRecord,
} from "../src/application/CEERankedStore";
import {
  CEE_RANKED_BOT_FALLBACK_MS,
  CEE_RANKED_COUNTDOWN_MS,
  CEE_RANKED_INTERMISSION_MS,
  CEE_RANKED_OFFLINE_FORFEIT_MS,
} from "../src/shared/Index";
import { appErrorOf, openPlay, rankedHarness, startBotSeries } from "./CEERankedFixtures";

/** 让出事件循环，把已经在飞的 `await` 链跑到挂起点为止。 */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * 第一次评级读取挂起，直到测试放行。
 *
 * 排队在读评级之前就已经把账号记进「正在开赛」，卡在这里才能稳定复现开赛窗口。
 */
class GatedRatingStore extends InMemoryCEERankedStore {
  private readonly waiters: Array<() => void> = [];
  private armed = true;

  release(): void {
    this.armed = false;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  override async getRating(userId: string): Promise<CEERankedRatingRecord | null> {
    if (this.armed) {
      this.armed = false;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    return super.getRating(userId);
  }
}

/** 指定账号的评级读取在 `arm` 之后挂起，直到测试放行：用来卡住同一跳里的第一对。 */
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

/** 第一次写库挂起，用来验证结算不阻塞命令 ACK。 */
class GatedSettlementStore extends InMemoryCEERankedStore {
  private readonly waiters: Array<() => void> = [];
  private armed = true;

  release(): void {
    this.armed = false;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  override async saveSettlement(record: CEERankedSettlementRecord): Promise<void> {
    if (this.armed) {
      this.armed = false;
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    await super.saveSettlement(record);
  }
}

describe("排位开赛容错", () => {
  test("一跳里一场开失败：其余候选照常开局，失败的两位退回 idle 并能重新排队", async () => {
    // 1500/100 的保守分 1400 落在 d2，2600/100 的保守分 2500 落在 d5；只让 d2 的题库读取抛错。
    const harness = rankedHarness({ failingTier: "d2" });
    harness.seedRated("u-甲", { rating: 1500, rd: 100 });
    harness.seedRated("u-乙", { rating: 1500, rd: 100 });
    harness.seedRated("u-丙", { rating: 2600, rd: 100 });
    harness.seedRated("u-丁", { rating: 2600, rd: 100 });
    const first = harness.connect("甲");
    const second = harness.connect("乙");
    const third = harness.connect("丙");
    const fourth = harness.connect("丁");
    for (const client of [first, second, third, fourth])
      await harness.send(client, "cee.ranked.queue", {});

    await harness.advance(1_000);

    expect(harness.logs.error).toEqual([
      {
        message: "排位开赛失败",
        detail: { userIds: ["u-甲", "u-乙"], error: "测试用题库读取失败" },
      },
    ]);
    // 失败的一对退回空闲，另一对不受影响地开成了真人局。
    expect(harness.latest(first).status).toBe("idle");
    expect(harness.latest(second).status).toBe("idle");
    expect(harness.seriesView(third).opponent.isBot).toBe(false);
    expect(harness.seriesView(fourth).tier.id).toBe("d5");
    // 重新排队能再进队列，说明开赛护栏里那两位的「正在开赛」标记已经清掉。
    await harness.send(first, "cee.ranked.queue", {});
    expect(harness.latest(first).status).toBe("queued");
  });

  test("人机兜底开局失败只影响那一个账号", async () => {
    const harness = rankedHarness({ failingTier: "d1" });
    harness.seedRated("u-甲");
    const client = harness.connect("甲");
    await harness.send(client, "cee.ranked.queue", {});

    await harness.advance(CEE_RANKED_BOT_FALLBACK_MS);

    expect(harness.logs.error).toEqual([
      {
        message: "排位开赛失败",
        detail: { userIds: ["u-甲"], error: "测试用题库读取失败" },
      },
    ]);
    expect(harness.latest(client).status).toBe("idle");
    await harness.send(client, "cee.ranked.queue", {});
    expect(harness.latest(client).status).toBe("queued");
  });
});

describe("正在开赛时的排队与取消", () => {
  test("开赛窗口里排队报忙、取消无效，开赛完成后标记清空", async () => {
    const store = new GatedRatingStore();
    const harness = rankedHarness({ store });
    const client = harness.connect("甲");

    const pending = harness.send(client, "cee.ranked.queue", {});
    await yieldToEventLoop();

    const busy = await appErrorOf(() => harness.send(client, "cee.ranked.queue", {}));
    expect({ code: busy.code, message: busy.message }).toEqual({
      code: "RANKED_STARTING",
      message: "正在为你开赛",
    });
    // 此时取消既不该收回已经在开的那场，也不该多推一帧 idle。
    const framesBefore = harness.states(client).length;
    expect(await harness.send(client, "cee.ranked.cancel", {})).toEqual({});
    expect(harness.states(client).length).toBe(framesBefore);

    store.release();
    expect(await pending).toEqual({});
    expect(harness.seriesView(client).opponent.isBot).toBe(true);
    // 报的是「请先打完当前这场」而不是「正在为你开赛」：说明 starting 已经清空。
    const inSeries = await appErrorOf(() => harness.send(client, "cee.ranked.queue", {}));
    expect(inSeries.code).toBe("RANKED_IN_SERIES");
  });

  test("同一跳配出两对时，第二对玩家在第一对开赛挂起期间排队报忙、取消不推 idle", async () => {
    // 只卡住 u-甲 的评级读取：第一对（甲乙）开赛挂起，第二对（丙丁）尚未轮到。
    const store = new GatedUserRatingStore("u-甲");
    const harness = rankedHarness({ store });
    harness.seedRated("u-甲", { rating: 1500, rd: 100 });
    harness.seedRated("u-乙", { rating: 1500, rd: 100 });
    harness.seedRated("u-丙", { rating: 2600, rd: 100 });
    harness.seedRated("u-丁", { rating: 2600, rd: 100 });
    const [first, second, third, fourth] = ["甲", "乙", "丙", "丁"].map((name) =>
      harness.connect(name)
    );
    if (!first || !second || !third || !fourth) throw new Error("夹具连接缺失");
    for (const client of [first, second, third, fourth])
      await harness.send(client, "cee.ranked.queue", {});
    store.arm();

    await harness.advance(1_000);

    // 配好的人在出队的同一刻就已处于开赛中：排队报忙，取消不生效也不多推 idle。
    const busy = await appErrorOf(() => harness.send(third, "cee.ranked.queue", {}));
    expect(busy.code).toBe("RANKED_STARTING");
    const framesBefore = harness.states(third).length;
    expect(await harness.send(third, "cee.ranked.cancel", {})).toEqual({});
    expect(harness.states(third).length).toBe(framesBefore);

    store.release();
    await harness.advance(0);

    // 两对都开成真人局；没有人同时留在队列里再被配出第二场。
    for (const client of [first, second, third, fourth])
      expect(harness.seriesView(client).opponent.isBot).toBe(false);
    expect(harness.seriesView(third).seriesId).not.toBe(harness.seriesView(first).seriesId);
    expect(harness.states(third).filter((state) => state.status === "queued")).toHaveLength(1);
  });

  test("开赛窗口里断线又没重连：席位照常计离线，满阈值后判负", async () => {
    const store = new GatedRatingStore();
    const harness = rankedHarness({ store });
    const client = harness.connect("甲");

    const pending = harness.send(client, "cee.ranked.queue", {});
    await yieldToEventLoop();
    client.record.close();
    store.release();
    await pending;
    await harness.advance(CEE_RANKED_OFFLINE_FORFEIT_MS + 1_000);

    const reconnected = harness.connect("甲-重连", {
      account: { userId: client.userId, image: null },
    });
    await harness.send(reconnected, "cee.ranked.status", {});
    const view = harness.seriesView(reconnected);
    expect(view.phase).toBe("settled");
    expect(view.result?.reason).toBe("offline");
    expect(view.result?.outcome).toBe("lost");
  });

  test("开赛窗口里断线：这一场照常开出，重连后看得到", async () => {
    const store = new GatedRatingStore();
    const harness = rankedHarness({ store });
    const client = harness.connect("甲");

    const pending = harness.send(client, "cee.ranked.queue", {});
    await yieldToEventLoop();
    client.record.close();
    store.release();
    await pending;

    const reconnected = harness.connect("甲-重连", {
      account: { userId: client.userId, image: null },
    });
    await harness.send(reconnected, "cee.ranked.status", {});
    expect(harness.seriesView(reconnected).phase).toBe("countdown");
    expect(harness.seriesView(reconnected).opponent.isBot).toBe(true);
  });
});

describe("结算不阻塞命令", () => {
  test("写库挂起时最后一猜照常返回：ACK 先回，结算状态随后落定", async () => {
    const store = new GatedSettlementStore();
    const harness = rankedHarness({ store });
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    await openPlay(harness);
    await harness.send(client, "cee.ranked.guess", { characterId: 11 });
    // 局间 10 秒加读秒 5 秒：推进到这里，第二局已经在进行中。
    await harness.advance(CEE_RANKED_INTERMISSION_MS + CEE_RANKED_COUNTDOWN_MS);

    // 这一猜打完系列赛就结算：写库还挂着，命令也必须已经返回。
    expect(await harness.send(client, "cee.ranked.guess", { characterId: 12 })).toEqual({});
    const seriesId = harness.seriesView(client).seriesId;
    expect(harness.seriesView(client).phase).toBe("settled");
    expect(harness.seriesView(client).result?.settlement).toBe("pending");

    store.release();
    await harness.advance(0);
    expect(harness.seriesView(client).result?.settlement).toBe("rated");
    expect(await harness.store.getSeriesAudit(seriesId)).not.toBeNull();
  });
});

describe("计时器唤醒容错", () => {
  test("唤醒时推送抛错：记错误日志并重排计时器，场次不会停摆", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    expect(harness.seriesView(client).game?.phase).toBe("countdown");
    const send = client.record.send;
    let armed = true;
    client.record.send = (payload) => {
      if (armed) {
        armed = false;
        throw new Error("测试用推送失败");
      }
      send(payload);
    };

    // 读秒结束的那次唤醒在推送时抛错：不能变成未处理拒绝，也不能丢掉计时器。
    await harness.advance(CEE_RANKED_COUNTDOWN_MS);
    expect(harness.logs.error.map((item) => item.message)).toContain("排位唤醒异常");
    expect(harness.seriesView(client).game?.phase).toBe("countdown");

    // 唤醒已经把本局推进到进行中，只是那一帧没送出去；计时器必须还在，后续的截止与人机出手才会继续送帧。
    await harness.advance(10 * 60_000);
    const phase = harness.seriesView(client).game?.phase;
    expect(phase === undefined || phase !== "countdown").toBe(true);
  });
});
