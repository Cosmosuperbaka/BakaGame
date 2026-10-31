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
