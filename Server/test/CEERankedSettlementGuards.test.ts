// ==================== 排位结算写库的守护用例 ====================
// 结算写的是真实的积分与段位：这里钉住「落定后的状态」「重复写库」「榜单缓存失效」「对手避让记录」几处
// 其余用例没有盯住的细节，拆分服务内部结构时它们不许变。对局推进全靠夹具假时钟。
import { describe, expect, test } from "bun:test";
import {
  InMemoryCEERankedStore,
  type CEERankedSeriesAudit,
  type CEERankedSettlementRecord,
} from "../src/application/CEERankedStore";
import { AppError } from "../src/domain/Errors";
import { CEE_RANKED_OFFLINE_FORFEIT_MS } from "../src/shared/Index";
import { SETTLED_RETENTION_MS } from "../src/application/CEERankedService";
import { rankedHarness, startBotSeries, type RankedHarness } from "./CEERankedFixtures";

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 事务已提交但响应丢失：首次写库真的落了库，却抛出超时。 */
class LostAckStore extends InMemoryCEERankedStore {
  attempts = 0;

  override async saveSettlement(record: CEERankedSettlementRecord): Promise<void> {
    this.attempts += 1;
    await super.saveSettlement(record);
    if (this.attempts === 1) throw new AppError("RANKED_STORE_TIMEOUT", "测试用 ACK 丢失");
  }
}

/** 首次写库失败（没落库），且「是否已落库」的确认读取第一次也失败：之后一切正常。 */
class BlindRetryStore extends InMemoryCEERankedStore {
  attempts = 0;
  private auditReads = 0;

  override async saveSettlement(record: CEERankedSettlementRecord): Promise<void> {
    this.attempts += 1;
    if (this.attempts === 1) throw new AppError("RANKED_STORE_UNAVAILABLE", "测试用写库失败");
    await super.saveSettlement(record);
  }

  override async getSeriesAudit(seriesId: string): Promise<CEERankedSeriesAudit | null> {
    this.auditReads += 1;
    if (this.auditReads === 1) throw new AppError("RANKED_STORE_UNAVAILABLE", "测试用确认读失败");
    return super.getSeriesAudit(seriesId);
  }
}

/** 写库一直挂起直到放行，并记下一共被调用了几次。 */
class CountingGatedStore extends InMemoryCEERankedStore {
  attempts = 0;
  private readonly waiters: Array<() => void> = [];
  private open = false;

  release(): void {
    this.open = true;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  override async saveSettlement(record: CEERankedSettlementRecord): Promise<void> {
    this.attempts += 1;
    if (!this.open)
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    await super.saveSettlement(record);
  }
}

/** 已定级、已带着榜单缓存的账号打一场人机并结算掉，返回结算前后榜上的本人分数。 */
async function settleWithCachedBoard(
  harness: RankedHarness,
  afterExit: () => Promise<void>
): Promise<{ before: number | undefined; after: number | undefined }> {
  const client = harness.connect("甲", { account: { userId: "u1", image: null } });
  harness.seedRated("u1");
  await harness.send(client, "cee.ranked.queue", {});
  const cached = await harness.send(client, "cee.ranked.leaderboard", {});
  // 排队满 10 秒就能选人机：整个过程不到榜单缓存的 30 秒，缓存要靠写库成功时主动作废才会刷新。
  await harness.advance(10_000);
  await harness.send(client, "cee.ranked.playBot", {});
  await harness.send(client, "cee.ranked.exit", {});
  await afterExit();
  const fresh = await harness.send(client, "cee.ranked.leaderboard", {});
  return { before: cached.self?.rating, after: fresh.self?.rating };
}

describe("结算落定后的状态", () => {
  test("结算在写库前中断：本场落为 failed，之后刷新状态读到的也是 failed", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    const send = client.record.send;
    let armed = true;
    client.record.send = (payload) => {
      const state = (payload as { payload: { series?: { result?: { settlement?: string } } } })
        .payload;
      if (armed && state.series?.result?.settlement === "pending") {
        armed = false;
        throw new Error("测试用推送失败");
      }
      send(payload);
    };
    await harness.send(client, "cee.ranked.exit", {});
    await harness.advance(0);

    await harness.send(client, "cee.ranked.status", {});
    expect(harness.seriesView(client).result?.settlement).toBe("failed");
  });

  test("写库那一刻客户端看到的已经是「结算中」，写完之后才是最终结果", async () => {
    let seenAtWrite: string | undefined;
    let probe: (() => string | undefined) | null = null;
    class ProbeStore extends InMemoryCEERankedStore {
      override async saveSettlement(record: CEERankedSettlementRecord): Promise<void> {
        seenAtWrite = probe?.();
        await super.saveSettlement(record);
      }
    }
    const harness = rankedHarness({ store: new ProbeStore() });
    const client = harness.connect("甲");
    probe = () => harness.seriesView(client).result?.settlement;
    await startBotSeries(harness, client);
    await harness.send(client, "cee.ranked.exit", {});

    expect(seenAtWrite).toBe("pending");
    expect(harness.seriesView(client).result?.settlement).toBe("rated");
  });
});

describe("重复写库与落库确认", () => {
  test("落库确认的读取本身失败：记一条警告并按「没落库」继续重试，下一次写成功", async () => {
    const store = new BlindRetryStore();
    const harness = rankedHarness({ store });
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    const seriesId = harness.seriesView(client).seriesId;

    await harness.send(client, "cee.ranked.exit", {});
    await harness.advance(2_000);

    expect(store.attempts).toBe(2);
    expect(harness.logs.warn.map((item) => item.message)).toContain("排位结算落库确认读取失败");
    expect(harness.seriesView(client).result?.settlement).toBe("rated");
    expect(await store.getSeriesAudit(seriesId)).not.toBeNull();
  });

  test("离线判负后写库挂起期间的重复唤醒不会再写一次，放行后也不会补写", async () => {
    const store = new CountingGatedStore();
    const harness = rankedHarness({ store });
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    const seriesId = harness.seriesView(client).seriesId;
    client.record.close();
    // 对方（人机）一直在线，离线满阈值整场判负；席位仍标着离线，计时器会反复唤醒这一场。
    await harness.advance(CEE_RANKED_OFFLINE_FORFEIT_MS + 1_000);
    await yieldToEventLoop();
    await harness.advance(50);
    expect(store.attempts).toBe(1);

    store.release();
    await harness.advance(50);
    await harness.advance(50);
    expect(store.attempts).toBe(1);
    const audit = await store.getSeriesAudit(seriesId);
    expect(audit?.series.endReason).toBe("offline");
  });
});

describe("结算成功后排行榜缓存立即作废", () => {
  test("正常写库：缓存期内再看榜单，本人已是新分数", async () => {
    const harness = rankedHarness();
    const { before, after } = await settleWithCachedBoard(harness, async () => {});
    expect(before).toBe(1500);
    expect(after).toBeLessThan(1500);
  });

  test("响应丢失、重试确认已落库：同样作废缓存", async () => {
    const harness = rankedHarness({ store: new LostAckStore() });
    const { before, after } = await settleWithCachedBoard(harness, async () => {
      await harness.advance(2_000);
    });
    expect(before).toBe(1500);
    expect(after).toBeLessThan(1500);
  });
});

describe("对手与人格避让的记录时刻", () => {
  test("真人对局结算后：冷却内两人再排队不会再配到一起，等满 15 秒才放开", async () => {
    const harness = rankedHarness();
    const first = harness.connect("甲", { account: { userId: "u1", image: null } });
    const second = harness.connect("乙", { account: { userId: "u2", image: null } });
    // 不确定度压低，打完一场后双方分差仍在初始配对窗口内，只剩「刚打过」这一条能挡住配对。
    harness.seedRated("u1", { rd: 50 });
    harness.seedRated("u2", { rd: 50 });
    await harness.send(first, "cee.ranked.queue", {});
    await harness.send(second, "cee.ranked.queue", {});
    await harness.advance(1_000);
    await harness.advance(5_000);
    await harness.send(first, "cee.ranked.exit", {});
    await harness.send(first, "cee.ranked.leave", {});
    await harness.send(second, "cee.ranked.leave", {});
    // 先让巡检过一遍：冷却内的记录不能被清掉。
    await harness.advance(1);

    await harness.send(first, "cee.ranked.queue", {});
    await harness.send(second, "cee.ranked.queue", {});
    await harness.advance(2_000);
    expect(harness.latest(first).status).toBe("queued");
    expect(harness.latest(second).status).toBe("queued");

    await harness.advance(14_000);
    expect(harness.latest(first).status).toBe("series");
    expect(harness.seriesView(first).opponent.isBot).toBe(false);
  });

  test("人机人格避让从系列赛结束时刻起算，而不是从开赛时刻", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    const first = harness.seriesView(client).opponent.name;
    // 这一场打了 100 秒才结束：避让窗口比开赛时刻起算的晚到 100 秒。
    await harness.advance(100_000);
    expect(harness.seriesView(client).phase).not.toBe("settled");
    await harness.send(client, "cee.ranked.exit", {});
    await harness.advance(SETTLED_RETENTION_MS - 50_000);

    await harness.send(client, "cee.ranked.queue", {});
    expect(harness.seriesView(client).opponent.name).not.toBe(first);
  });
});

describe("真人局结果页的清理", () => {
  test("一方先离开后，另一方没点离开：保留时长到了仍替他离开并推 idle", async () => {
    const harness = rankedHarness();
    const first = harness.connect("甲", { account: { userId: "u1", image: null } });
    const second = harness.connect("乙", { account: { userId: "u2", image: null } });
    harness.seedRated("u1");
    harness.seedRated("u2");
    await harness.send(first, "cee.ranked.queue", {});
    await harness.send(second, "cee.ranked.queue", {});
    await harness.advance(1_000);
    await harness.advance(5_000);
    await harness.send(first, "cee.ranked.exit", {});
    await harness.send(first, "cee.ranked.leave", {});

    await harness.advance(SETTLED_RETENTION_MS + 1_000);
    expect(harness.latest(second)).toEqual({ status: "idle" });
  });
});
