// ==================== 排位撮合与开赛的守护用例 ====================
// 「匹配中」的占位、人机选择出队、开赛失败回空闲、重新排队前自动离开结果页这几处，
// 其余用例没有盯住的细节。拆分服务内部结构时它们不许变。对局推进全靠夹具假时钟。
import { describe, expect, test } from "bun:test";
import {
  InMemoryCEERankedStore,
  type CEERankedRatingRecord,
} from "../src/application/CEERankedStore";
import { AppError } from "../src/domain/Errors";
import { appErrorOf, rankedHarness, startBotSeries } from "./CEERankedFixtures";

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
  test("选人机后开赛组装期间账号已不在队列里：状态读到 idle", async () => {
    const store = new GatedUserRatingStore("u1");
    const harness = rankedHarness({ store });
    const client = harness.connect("甲", { account: { userId: "u1", image: null } });
    harness.seedRated("u1");
    await harness.send(client, "cee.ranked.queue", {});
    await harness.advance(10_000);
    store.arm();
    const pending = harness.send(client, "cee.ranked.playBot", {});
    await yieldToEventLoop();

    const status = await harness.send(client, "cee.ranked.status", {});
    expect(status).toEqual({ status: "idle" });
    store.release();
    await pending;
    expect(harness.seriesView(client).opponent.isBot).toBe(true);
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
