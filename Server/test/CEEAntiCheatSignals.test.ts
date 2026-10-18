import { describe, expect, test } from "bun:test";
import {
  CEE_SEARCH_RESULT_IDS_MAX,
  CEESearchProvenance,
  InMemoryAntiCheatReviewQueue,
  ceeAntiCheatReviews,
  ceeCharacterIdsOf,
  ceeClientTypeOf,
  ceeUnitFeatures,
  scoreCEEAntiCheat,
  type CEEGuessSignal,
} from "../src/application/CEEAntiCheatSignals";
import { ceeTestHarness, type CEETestIdentity } from "./CEENativeFixtures";
import type { ClientChannelProof, PlayerAccount } from "../src/shared/Index";

const account = (id: string): PlayerAccount => ({ userId: id, image: null });
const channel = (clientType: ClientChannelProof["clientType"] = "desktop"): ClientChannelProof => ({
  clientId: `client-${clientType}-1`,
  clientType,
  clientVersion: "1.0.0",
  keyProtection: "hardware",
});
/** 反作弊房里的合法成员：客户端接入且已登录。 */
const trusted = (id: string): CEETestIdentity => ({
  account: account(id),
  clientChannel: channel(),
});

const signal = (patch: Partial<CEEGuessSignal> & Pick<CEEGuessSignal, "guessId" | "createdAt">) =>
  ({
    playerId: "p-1",
    attempts: 1,
    clientType: "desktop",
    searchedAt: 0,
    searchMatched: true,
    correct: false,
    ...patch,
  }) as CEEGuessSignal;
/** 恒定节奏、从不检索的 `count` 条猜测，间隔 `step` 毫秒。 */
const robotSignals = (count: number, step = 5_000, start = 1_000): CEEGuessSignal[] =>
  Array.from({ length: count }, (_, index) =>
    signal({
      guessId: `g${index}`,
      attempts: index + 1,
      createdAt: start + index * step,
      searchedAt: null,
      searchMatched: false,
    })
  );
const reviewContext = {
  roomId: "1234",
  roomCreatedAt: 1,
  roundNumber: 1,
  recordedAt: 2,
};
const identity = (playerId: string) => ({ name: `玩家-${playerId}`, userId: "u-1" });

describe("CEE 检索台账", () => {
  test("记录最近一次检索：命中列出 ID，未命中只说明没搜到这个候选", () => {
    const ledger = new CEESearchProvenance(() => 500);
    ledger.note("c-1", [7, 8]);
    expect(ledger.match("c-1", 8)).toEqual({ at: 500, matched: true });
    expect(ledger.match("c-1", 9)).toEqual({ at: 500, matched: false });
    expect(ledger.match("c-2", 8)).toEqual({ at: null, matched: false });
  });
  test("读取不消费：一次检索后连猜几个候选是正常玩法", () => {
    const ledger = new CEESearchProvenance(() => 500);
    ledger.note("c-1", [7]);
    expect(ledger.match("c-1", 7).matched).toBe(true);
    expect(ledger.match("c-1", 7).matched).toBe(true);
    ledger.forget("c-1");
    expect(ledger.match("c-1", 7)).toEqual({ at: null, matched: false });
  });
  test("每次检索只保留有限候选，条目数封顶后淘汰最早连接", () => {
    const ledger = new CEESearchProvenance(() => 1, 2);
    ledger.note(
      "c-1",
      Array.from({ length: 400 }, (_, index) => index)
    );
    expect(ledger.match("c-1", CEE_SEARCH_RESULT_IDS_MAX - 1).matched).toBe(true);
    expect(ledger.match("c-1", CEE_SEARCH_RESULT_IDS_MAX).matched).toBe(false);
    ledger.note("c-2", [1]);
    ledger.note("c-3", [1]);
    expect(ledger.trackedConnections).toBe(2);
    expect(ledger.match("c-1", 1).at).toBeNull();
  });
  test("检索结果形状不符即当作没有候选", () => {
    expect(ceeCharacterIdsOf({ results: [{ id: 3 }, { id: "4" }, {}, null] })).toEqual([3]);
    expect(ceeCharacterIdsOf(undefined)).toEqual([]);
    expect(ceeCharacterIdsOf({ results: "nope" })).toEqual([]);
    expect(ceeClientTypeOf(undefined)).toBe("web");
    expect(ceeClientTypeOf(channel("mobile"))).toBe("mobile");
  });
});

describe("CEE 行为特征打分", () => {
  test("样本不足时不算变异系数：两三条猜测的节奏没有统计意义", () => {
    expect(ceeUnitFeatures(robotSignals(3)).cv).toBeNull();
    expect(ceeUnitFeatures(robotSignals(4)).cv).toBe(0);
    expect(ceeUnitFeatures(robotSignals(4)).intervals).toEqual([5_000, 5_000, 5_000]);
  });
  test("同时刻的多条猜测不会算出负间隔", () => {
    expect(ceeUnitFeatures(robotSignals(4, 0)).intervals).toEqual([0, 0, 0]);
    // 间隔全为 0 时均值也是 0，比值无意义，宁可判为「样本不足」。
    expect(ceeUnitFeatures(robotSignals(4, 0)).cv).toBeNull();
  });
  test("恒定节奏加从不检索达到复核门槛", () => {
    const result = scoreCEEAntiCheat(robotSignals(4));
    expect(result.score).toBe(4);
    expect(result.reasons).toHaveLength(2);
    expect(result.features.noSearchGuesses).toBe(4);
  });
  test("先检索再猜、间隔参差的人类玩家不加分", () => {
    const human = [
      signal({ guessId: "h0", createdAt: 1_000, attempts: 1 }),
      signal({ guessId: "h1", createdAt: 9_000, attempts: 2 }),
      signal({ guessId: "h2", createdAt: 11_500, attempts: 3 }),
      signal({ guessId: "h3", createdAt: 30_000, attempts: 4 }),
    ];
    expect(scoreCEEAntiCheat(human).score).toBe(0);
    expect(scoreCEEAntiCheat(human).features.cv).toBeGreaterThan(0.5);
  });
  test("首猜即中单独只记一分，且必须真是第一次尝试", () => {
    const lucky = [
      signal({ guessId: "l0", createdAt: 1_000, attempts: 1, correct: true }),
      signal({ guessId: "l1", createdAt: 2_000, attempts: 2 }),
    ];
    expect(scoreCEEAntiCheat(lucky).score).toBe(1);
    expect(scoreCEEAntiCheat(lucky).reasons).toEqual(["首次猜测即命中"]);
    expect(scoreCEEAntiCheat(lucky.map((item) => ({ ...item, attempts: 3 }))).score).toBe(0);
  });
  test("猜测太少或分数不足都不进队列", () => {
    const byPlayer = new Map([["p-1", robotSignals(4)]]);
    expect(ceeAntiCheatReviews(reviewContext, byPlayer, identity)).toHaveLength(1);
    expect(
      ceeAntiCheatReviews(reviewContext, new Map([["p-1", robotSignals(3)]]), identity)
    ).toEqual([]);
    expect(
      ceeAntiCheatReviews(
        reviewContext,
        new Map([["p-1", robotSignals(4).map((item) => ({ ...item, searchedAt: 999 }))]]),
        identity
      )
    ).toEqual([]);
  });
  test("条目只带复核所需的最小信息，客户端类型取最后一次猜测", () => {
    const mixed = [
      ...robotSignals(3),
      signal({
        guessId: "g3",
        createdAt: 16_000,
        attempts: 4,
        clientType: "web",
        searchedAt: null,
        searchMatched: false,
      }),
    ];
    const [review] = ceeAntiCheatReviews(reviewContext, new Map([["p-1", mixed]]), identity);
    expect(review).toMatchObject({
      roomId: "1234",
      roundNumber: 1,
      playerId: "p-1",
      playerName: "玩家-p-1",
      userId: "u-1",
      clientType: "web",
      score: 4,
    });
    expect(review.features.intervals).toHaveLength(3);
  });
});

/** 一局定输赢：三次错猜后命中答案，回合立即结算并触发采集。 */
async function settledRound(
  identityOfGuesser: CEETestIdentity,
  antiCheat: boolean,
  reviews: InMemoryAntiCheatReviewQueue,
  gaps: number[]
) {
  const h = ceeTestHarness({}, undefined, { reviewQueue: reviews });
  const host = await h.create("房主", trusted("u-host"));
  const guest = await h.join("猜题人", identityOfGuesser);
  await h.configure(host, antiCheat ? { bakaAntiCheat: true } : {});
  await h.chooseSetter(host, host.id!);
  await h.send(host, "cee.game.setAnswer", { characterId: 1, hints: [] });
  for (const id of [3, 4, 5]) {
    await h.guess(guest, id);
    h.advance(gaps.shift() ?? 5_000);
  }
  await h.guess(guest, 1);
  expect(h.snapshot(host).phase).toBe("settled");
  return h;
}

describe("CEE 反作弊采集接线", () => {
  test("反作弊房里机器节奏的玩家进复核队列", async () => {
    const reviews = new InMemoryAntiCheatReviewQueue();
    await settledRound(trusted("u-two"), true, reviews, [5_000, 5_000, 5_000]);
    expect(reviews.reviews).toHaveLength(1);
    expect(reviews.reviews[0]).toMatchObject({
      roomId: "1234",
      playerName: "猜题人",
      userId: "u-two",
      clientType: "desktop",
      score: 4,
    });
    expect(reviews.reviews[0].reasons.join()).toContain("未检索直接猜");
  });
  test("先搜索再猜、间隔参差的玩家不进队列", async () => {
    const reviews = new InMemoryAntiCheatReviewQueue();
    const h = ceeTestHarness({}, undefined, { reviewQueue: reviews });
    const host = await h.create("房主", trusted("u-host"));
    const guest = await h.join("猜题人", trusted("u-two"));
    await h.configure(host, { bakaAntiCheat: true });
    await h.chooseSetter(host, host.id!);
    await h.send(host, "cee.game.setAnswer", { characterId: 1, hints: [] });
    for (const [id, gap] of [
      [3, 6_400],
      [4, 1_200],
      [5, 9_000],
    ] as const) {
      await h.send(guest, "cee.character.search", { keyword: "角色" });
      h.advance(gap);
      await h.guess(guest, id);
    }
    await h.send(guest, "cee.character.search", { keyword: "角色" });
    h.advance(2_300);
    await h.guess(guest, 1);
    expect(h.snapshot(host).phase).toBe("settled");
    expect(reviews.reviews).toEqual([]);
  });
  test("普通房照样采集特征但不打分：判定只发生在反作弊房", async () => {
    const reviews = new InMemoryAntiCheatReviewQueue();
    await settledRound(trusted("u-two"), false, reviews, [5_000, 5_000, 5_000]);
    expect(reviews.reviews).toEqual([]);
  });
});
