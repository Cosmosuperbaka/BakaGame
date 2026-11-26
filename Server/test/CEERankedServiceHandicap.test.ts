// ==================== 排位人机强度校准的服务接线 ====================
// 开局按「标称分减偏差」找强度、按「强度分加偏差」计分，两组人机用法相同（见 planCEERankedBot）。
// 这些用例盯的是偏差用在哪、碰顶时计分分停在哪，以及样本从历史与结算里怎么攒起来。
import { describe, expect, test } from "bun:test";
import {
  type CEERankedBotGroup,
  type CEERankedBotSample,
} from "../src/application/CEERankedHandicap";
import { InMemoryCEERankedStore } from "../src/application/CEERankedStore";
import { AppError } from "../src/domain/Errors";
import {
  CEE_RANKED_BOT_ANCHORS,
  CEE_RANKED_PERSONAS,
  type CEERankedPersona,
} from "../src/domain/CEERankedBotProfile";
import { CEE_RANKED_AIGA_EDGE, planCEERankedBot } from "../src/domain/CEERankedBotPlan";
import { createCEERating, rateCEEBotSeries } from "../src/domain/CEERankedRating";
import type { CEERankedSeriesPlayerRecord } from "../src/application/CEERankedStore";
import { exitAndAudit, rankedHarness, startBotSeries } from "./CEERankedFixtures";

/** 让出事件循环：启动种子是异步读的，播好种之前不排队。 */
const flushSeed = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * 一组同质的样本：各来自不同的已定级账号，真人 1500/100 全输，估计出的偏差落在搜索上界 600；
 * 30 条收缩后是 600 × 30/80 = 225。
 */
const samplesOf = (group: CEERankedBotGroup, count: number): CEERankedBotSample[] =>
  Array.from({ length: count }, (_unused, index) => ({
    group,
    userId: `u-历史${index}`,
    placement: false,
    playerRating: 1500,
    playerRd: 100,
    strengthRating: 1500,
    score: 0 as const,
  }));

const SHRUNK_BIAS = (600 * 30) / 80;

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

const personaOf = (bot: CEERankedSeriesPlayerRecord | undefined): CEERankedPersona => {
  const persona = CEE_RANKED_PERSONAS.find((item) => item.id === bot?.botPersona);
  if (!persona) throw new Error("审计里的人机席位缺人格");
  return persona;
};

describe("排位人机校准接线", () => {
  test("启动种子攒够 30 条：普通人格按扣掉偏差的分数找强度，计分分加回偏差后仍是标称分", async () => {
    // 随机源固定 0.5 时抽到普通人格，标称分正好等于玩家 μ。
    const store = new SampleStore(samplesOf("regular", 30));
    const harness = rankedHarness({ store, randomValue: 0.5 });
    harness.seedRated("u-甲");
    await flushSeed();
    const client = harness.connect("甲");

    expect(store.requestedLimits.length).toBe(1);

    await startBotSeries(harness, client);
    const audit = await exitAndAudit(harness, client);
    const bot = audit.players[1];
    const persona = personaOf(bot);
    expect(persona.id).not.toBe("aiga");
    const plan = planCEERankedBot({ persona, nominal: 1500, bias: SHRUNK_BIAS });
    expect(bot?.botStrengthRating).toBe(plan.strengthRating);
    expect(bot?.botTargetRating).toBe(plan.targetRating);
    expect(plan.strengthRating).toBeCloseTo(1500 - SHRUNK_BIAS, 0);
    expect(plan.targetRating).toBeCloseTo(1500, 0);

    // 结算按计分分算：这条断言把「计分用强度分加偏差」钉住。
    const expected = rateCEEBotSeries(
      createCEERating(),
      plan.targetRating,
      0,
      audit.series.endedAt
    );
    const rating = await harness.store.getRating(client.userId);
    if (!rating) throw new Error("结算后读不到账号 甲 的评级");
    expect(rating.rating).toBeCloseTo(expected.rating, 6);
    expect(rating.rd).toBeCloseTo(expected.rd, 6);
  });

  test("爱噶：标称分比玩家高出一截，样本不足时强度分与计分分相同，攒够后强度分扣掉偏差", async () => {
    const thin = rankedHarness({ store: new SampleStore(samplesOf("aiga", 29)) });
    thin.seedRated("u-甲");
    await flushSeed();
    const early = thin.connect("甲");
    await startBotSeries(thin, early);
    const before = await exitAndAudit(thin, early);
    expect(before.players[1]).toMatchObject({
      botPersona: "aiga",
      botTargetRating: 1500 + CEE_RANKED_AIGA_EDGE,
      botStrengthRating: 1500 + CEE_RANKED_AIGA_EDGE,
    });
    const expected = rateCEEBotSeries(
      createCEERating(),
      1500 + CEE_RANKED_AIGA_EDGE,
      0,
      before.series.endedAt
    );
    const rating = await thin.store.getRating(early.userId);
    if (!rating) throw new Error("结算后读不到账号 甲 的评级");
    expect(rating.rating).toBeCloseTo(expected.rating, 6);

    const full = rankedHarness({ store: new SampleStore(samplesOf("aiga", 30)) });
    full.seedRated("u-甲");
    await flushSeed();
    const late = full.connect("甲");
    await startBotSeries(full, late);
    const after = await exitAndAudit(full, late);
    expect(after.players[1]?.botStrengthRating).toBeCloseTo(
      1500 + CEE_RANKED_AIGA_EDGE - SHRUNK_BIAS,
      6
    );
    expect(after.players[1]?.botTargetRating).toBeCloseTo(1500 + CEE_RANKED_AIGA_EDGE, 6);
  });

  test("碰顶：玩家分数高出人机能达到的上限时，计分分停在顶档实力上，不再跟着玩家分数走", async () => {
    // 顶档远高于真人能到的分数，这里用一个虚构的极端分数把它顶出来。
    const extreme = 8000;
    const harness = rankedHarness({ store: new SampleStore([]), randomValue: 0.5 });
    harness.seedRated("u-甲", { rating: extreme, rd: 50 });
    await flushSeed();
    const client = harness.connect("甲");

    await startBotSeries(harness, client);
    const audit = await exitAndAudit(harness, client);
    const bot = audit.players[1];
    const plan = planCEERankedBot({ persona: personaOf(bot), nominal: extreme, bias: 0 });
    expect(bot?.botTargetRating).toBe(plan.targetRating);
    expect(plan.level).toBe(CEE_RANKED_BOT_ANCHORS[CEE_RANKED_BOT_ANCHORS.length - 1].level);
    expect(plan.targetRating).toBeLessThan(extreme - 1000);
    // 输给碰顶的人机按它的真实实力结算：比按玩家自己的分数结算掉得多得多。
    const prior = { rating: extreme, rd: 50, lastPlayedAt: null };
    const capped = rateCEEBotSeries(prior, plan.targetRating, 0, audit.series.endedAt);
    const naive = rateCEEBotSeries(prior, extreme, 0, audit.series.endedAt);
    const rating = await harness.store.getRating(client.userId);
    if (!rating) throw new Error("结算后读不到账号 甲 的评级");
    expect(rating.rating).toBeCloseTo(capped.rating, 6);
    expect(extreme - capped.rating).toBeGreaterThan(2 * (extreme - naive.rating));
  });

  test("普通人格样本不足 30 条时不加偏差：强度分与计分分相同", async () => {
    const harness = rankedHarness({
      store: new SampleStore(samplesOf("regular", 29)),
      randomValue: 0.5,
    });
    harness.seedRated("u-甲");
    await flushSeed();
    const client = harness.connect("甲");

    await startBotSeries(harness, client);
    const audit = await exitAndAudit(harness, client);
    const bot = audit.players[1];
    expect(bot?.botPersona).not.toBe("aiga");
    expect(bot?.botStrengthRating).toBe(bot?.botTargetRating ?? Number.NaN);
    expect(bot?.botTargetRating).toBeCloseTo(1500, 0);
  });

  test("普通人格按 regular 组的偏差回退，与爱噶组分开设", async () => {
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
    if (bot.botStrengthRating === null) throw new Error("人机席位缺强度分");
    // regular 组只有 30 条全输样本，偏差同样是 225；爱噶组样本再多也不影响这里。
    expect(bot.botTargetRating - bot.botStrengthRating).toBeCloseTo(SHRUNK_BIAS, 6);
  });

  test("计分明局补进样本：攒够 30 条之后下一场才带上偏差；偏差大的真人不算样本", async () => {
    const harness = rankedHarness({
      store: new SampleStore(samplesOf("regular", 29)),
      randomValue: 0.5,
    });
    harness.seedRated("u-甲", { rd: 100 });
    harness.seedRated("u-乙");
    await flushSeed();
    // 乙的偏差还是 350：这一场照常计分，但不进校准窗口。
    const loose = harness.connect("乙");
    await startBotSeries(harness, loose);
    await exitAndAudit(harness, loose);

    const client = harness.connect("甲");
    await startBotSeries(harness, client);
    const first = await exitAndAudit(harness, client);
    const before = first.players[1];
    if (!before || before.botTargetRating === null) throw new Error("第一场的人机席位缺目标分");
    // 只有 29 条样本：还不够，偏差是 0。
    expect(before.botStrengthRating).toBe(before.botTargetRating);

    await startBotSeries(harness, client);
    const second = await exitAndAudit(harness, client);
    const after = second.players[1];
    if (!after || after.botTargetRating === null || after.botStrengthRating === null)
      throw new Error("第二场的人机席位缺目标分");
    // 甲的第一场写进第 30 条样本，这一场起才按 225 回退。
    expect(after.botTargetRating - after.botStrengthRating).toBeCloseTo(SHRUNK_BIAS, 6);
  });

  test("种子读取失败只记一条 warn：偏差保持先验且照常开赛", async () => {
    const harness = rankedHarness({ store: new RejectingStore(), randomValue: 0.5 });
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
    const bot = audit.players[1];
    expect(bot?.botStrengthRating).toBe(bot?.botTargetRating ?? Number.NaN);
  });
});
