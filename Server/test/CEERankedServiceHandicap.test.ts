// ==================== 排位人机强度校准的服务接线 ====================
// 校准只在两个地方影响对局：生成强度用的分数（写进审计的 bot_strength_rating）和爱噶的思考节奏。
// 计分始终按目标分，所以这些用例盯的是「偏差用在哪、没用在哪」，以及样本从历史与结算里怎么攒起来。
import { describe, expect, test } from "bun:test";
import type { CEERankedBotGroup, CEERankedBotSample } from "../src/application/CEERankedHandicap";
import { InMemoryCEERankedStore } from "../src/application/CEERankedStore";
import { AppError } from "../src/domain/Errors";
import { beijingDay } from "../src/domain/BeijingDay";
import { createCEERating, rateCEEBotSeries } from "../src/domain/CEERankedRating";
import { CEE_RANKED_BOT_DAILY_RATED } from "../src/shared/Index";
import { RANKED_START_MS, exitAndAudit, rankedHarness, startBotSeries } from "./CEERankedFixtures";

/** 让出事件循环：启动种子是异步读的，播好种之前不排队。 */
const flushSeed = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 一组同质的样本：真人 1500/350 全输，估计出的偏差落在搜索上界 600，收缩后是 225。 */
const samplesOf = (group: CEERankedBotGroup, count: number): CEERankedBotSample[] =>
  Array.from({ length: count }, () => ({
    group,
    playerRating: 1500,
    playerRd: 350,
    strengthRating: 1500,
    score: 0 as const,
  }));

/** 只回放预置的人机样本，并记下每次捞取的条数上限。 */
class SampleStore extends InMemoryCEERankedStore {
  private readonly inner: readonly CEERankedBotSample[];
  private readonly limits: number[] = [];

  constructor(samples: readonly CEERankedBotSample[]) {
    super();
    this.inner = samples;
  }

  get requestedLimits(): readonly number[] {
    return this.limits;
  }

  override async listRecentBotSamples(limit: number): Promise<CEERankedBotSample[]> {
    this.limits.push(limit);
    return this.inner.map((sample) => ({ ...sample }));
  }
}

/** 种子读取直接失败：校准回落到「从零攒」，不影响排位可用。 */
class RejectingStore extends InMemoryCEERankedStore {
  override async listRecentBotSamples(): Promise<CEERankedBotSample[]> {
    throw new AppError("RANKED_STORE_UNAVAILABLE", "测试用种子读取失败");
  }
}

describe("排位人机校准接线", () => {
  test("启动种子攒够 30 条：第一场就按偏差生成强度，计分仍用目标分", async () => {
    const store = new SampleStore(samplesOf("aiga", 30));
    const harness = rankedHarness({ store });
    harness.seedRated("u-甲");
    await flushSeed();
    const client = harness.connect("甲");

    expect(store.requestedLimits.length).toBe(1);

    await startBotSeries(harness, client);
    const audit = await exitAndAudit(harness, client);
    expect(audit.players[1]).toMatchObject({
      botPersona: "aiga",
      botTargetRating: 1500,
      // 1500 减去收缩后的偏差 225。
      botStrengthRating: 1275,
    });

    // 按 1275 结算的话掉分会明显更小：这条断言把「计分用目标分」钉住。
    const expected = rateCEEBotSeries(createCEERating(), 1500, 0, audit.series.endedAt);
    const rating = await harness.store.getRating(client.userId);
    if (!rating) throw new Error("结算后读不到账号 甲 的评级");
    expect(rating.rating).toBeCloseTo(expected.rating, 6);
    expect(rating.rd).toBeCloseTo(expected.rd, 6);
  });

  test("样本不足 30 条时不加偏差：生成强度用的分数与目标分相同", async () => {
    const harness = rankedHarness({ store: new SampleStore(samplesOf("aiga", 29)) });
    harness.seedRated("u-甲");
    await flushSeed();
    const client = harness.connect("甲");

    await startBotSeries(harness, client);
    const audit = await exitAndAudit(harness, client);
    expect(audit.players[1]).toMatchObject({
      botPersona: "aiga",
      botTargetRating: 1500,
      botStrengthRating: 1500,
    });
  });

  test("普通人格按 regular 组的偏差回退，与爱噶组分开设", async () => {
    // 随机源固定 0.5 时首位是团子之后的普通人格，目标分正好等于玩家 μ。
    const harness = rankedHarness({
      store: new SampleStore([...samplesOf("regular", 30), ...samplesOf("aiga", 200)]),
      randomValue: 0.5,
    });
    harness.seedRated("u-甲");
    await flushSeed();
    const client = harness.connect("甲");

    await startBotSeries(harness, client);
    const audit = await exitAndAudit(harness, client);
    const bot = audit.players[1];
    if (!bot || bot.botPersona === "aiga" || bot.botTargetRating === null)
      throw new Error("这一场不是普通人格");
    expect(bot.botTargetRating).toBe(1500);
    // regular 组只有 30 条全输样本，偏差同样是 225；爱噶组样本再多也不影响这里。
    expect(bot.botStrengthRating).toBe(1275);
  });

  test("计分明局补进样本：攒够 30 条之后下一场才带上偏差", async () => {
    const harness = rankedHarness({
      store: new SampleStore(samplesOf("regular", 29)),
      randomValue: 0.5,
    });
    harness.seedRated("u-甲");
    await flushSeed();
    const client = harness.connect("甲");

    await startBotSeries(harness, client);
    const first = await exitAndAudit(harness, client);
    const before = first.players[1];
    if (!before || before.botTargetRating === null) throw new Error("第一场的人机席位缺目标分");
    // 第 29 条样本：还不够，偏差是 0。
    expect(before.botStrengthRating).toBe(before.botTargetRating);

    await startBotSeries(harness, client);
    const second = await exitAndAudit(harness, client);
    const after = second.players[1];
    if (!after || after.botTargetRating === null || after.botStrengthRating === null)
      throw new Error("第二场的人机席位缺目标分");
    // 第一场结算写进第 30 条样本，这一场起才按 225 回退。
    expect(after.botTargetRating - after.botStrengthRating).toBeCloseTo(225, 6);
  });

  test("不计分的人机局不进样本窗口：次日恢复计分后偏差仍是 0", async () => {
    const harness = rankedHarness({ store: new SampleStore(samplesOf("aiga", 29)) });
    harness.seedRated("u-甲", {
      botRatedDay: beijingDay(RANKED_START_MS),
      botRatedCount: CEE_RANKED_BOT_DAILY_RATED,
    });
    await flushSeed();
    const client = harness.connect("甲");

    await startBotSeries(harness, client);
    const audit = await exitAndAudit(harness, client);
    expect(audit.series.rated).toBe(false);
    const skipped = audit.players[1];
    if (!skipped || skipped.botTargetRating === null) throw new Error("人机席位缺目标分");
    expect(skipped.botStrengthRating).toBe(skipped.botTargetRating);

    // 换到第二天：这一场计分，但上一场没进窗口，样本还是 29 条，偏差不该冒出来。
    await harness.advance(86_400_000);
    await startBotSeries(harness, client);
    const next = await exitAndAudit(harness, client);
    expect(next.series.rated).toBe(true);
    const bot = next.players[1];
    if (!bot || bot.botTargetRating === null) throw new Error("人机席位缺目标分");
    expect(bot.botStrengthRating).toBe(bot.botTargetRating);
  });

  test("种子读取失败只记一条 warn：偏差保持 0 且照常开赛", async () => {
    const harness = rankedHarness({ store: new RejectingStore() });
    harness.seedRated("u-甲");
    await flushSeed();
    const client = harness.connect("甲");

    await startBotSeries(harness, client);
    expect(harness.logs.warn).toEqual([
      {
        message: "排位人机校准种子读取失败",
        detail: { error: "测试用种子读取失败" },
      },
    ]);
    const audit = await exitAndAudit(harness, client);
    expect(audit.players[1]).toMatchObject({
      botTargetRating: 1500,
      botStrengthRating: 1500,
    });
  });
});
