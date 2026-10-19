import { describe, expect, test } from "bun:test";
import {
  CEE_ANTI_CHEAT_AGGREGATE_MAX_ITEMS,
  CEE_SEARCH_RESULT_IDS_MAX,
  CEESearchProvenance,
  InMemoryAntiCheatReviewQueue,
  aggregateCEEAntiCheatReviews,
  ceeAntiCheatReviews,
  ceeCharacterIdsOf,
  ceeClientTypeOf,
  ceeUnitFeatures,
  scoreCEEAntiCheat,
  type CEEAntiCheatReview,
  type CEEGuessSignal,
  type CEEUnitFeatures,
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
  test("每次都检索但候选里没有本次角色：伪造检索单独也够进队列", () => {
    const faked = robotSignals(4).map((item) => ({ ...item, searchedAt: 999 }));
    const result = scoreCEEAntiCheat(faked);
    expect(result.features.noSearchGuesses).toBe(0);
    expect(result.features.unmatchedSearches).toBe(4);
    expect(result.score).toBe(4);
    expect(result.reasons).toContainEqual(expect.stringContaining("检索全部落空"));
  });
  test("偶尔一次落空不算伪造：翻回上一次结果选人是正常操作", () => {
    const human = [
      signal({ guessId: "f0", createdAt: 1_000, attempts: 1, searchedAt: 900 }),
      signal({ guessId: "f1", createdAt: 8_000, attempts: 2, searchedAt: 7_000 }),
      signal({
        guessId: "f2",
        createdAt: 12_000,
        attempts: 3,
        searchedAt: 11_000,
        searchMatched: false,
      }),
      signal({ guessId: "f3", createdAt: 26_000, attempts: 4, searchedAt: 20_000 }),
    ];
    expect(scoreCEEAntiCheat(human).features.unmatchedSearches).toBe(1);
    expect(scoreCEEAntiCheat(human).reasons).toEqual([]);
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
        new Map([
          [
            "p-1",
            robotSignals(4).map((item) => ({ ...item, searchedAt: 999, searchMatched: true })),
          ],
        ]),
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

/** 跨局聚合只读特征里的这几个数，其余字段按队列条目补齐。 */
const unitFeatures = (
  cv: number | null,
  guesses: number,
  firstGuessCorrect = false
): CEEUnitFeatures => ({
  intervals: [],
  cv,
  noSearchGuesses: 0,
  unmatchedSearches: 0,
  guesses,
  firstGuessCorrect,
});
const queued = (patch: Partial<CEEAntiCheatReview> & Pick<CEEAntiCheatReview, "playerId">) =>
  ({
    roomId: "1234",
    roomCreatedAt: 0,
    roundNumber: 1,
    playerName: "张三",
    userId: null,
    clientType: "web",
    recordedAt: 1_000_000,
    score: 3,
    reasons: [],
    features: unitFeatures(null, 2),
    ...patch,
  }) as CEEAntiCheatReview;

describe("CEE 复核条目跨局聚合", () => {
  test("空集合回零值，不抛错也不编一个均值", () => {
    expect(aggregateCEEAntiCheatReviews([])).toEqual({
      rounds: 0,
      avgGuesses: 0,
      firstGuessHits: 0,
      avgCv: null,
      maxScore: 0,
    });
  });
  test("多条取均值：一条都算不出 CV 时保持 null", async () => {
    const queue = new InMemoryAntiCheatReviewQueue();
    queue.add(queued({ playerId: "p1", userId: "u1", features: unitFeatures(null, 4) }));
    queue.add(
      queued({
        playerId: "p1",
        userId: "u1",
        score: 5,
        features: unitFeatures(0.4, 6, true),
      })
    );
    const base = queue.reviews.find((item) => item.userId === "u1")!;
    expect(aggregateCEEAntiCheatReviews(await queue.aggregateFor(base.id, 0))).toEqual({
      rounds: 2,
      avgGuesses: 5,
      firstGuessHits: 1,
      avgCv: 0.4,
      maxScore: 5,
    });
  });
  test("登录只认 userId，游客只与同昵称的其它游客条目并列", async () => {
    const queue = new InMemoryAntiCheatReviewQueue();
    queue.add(queued({ playerId: "u-one", userId: "u1" }));
    queue.add(queued({ playerId: "u-two", userId: "u2" }));
    queue.add(queued({ playerId: "guest-a" }));
    queue.add(queued({ playerId: "guest-b" }));
    const idOf = (playerId: string) => queue.reviews.find((item) => item.playerId === playerId)!.id;

    // 同昵称但各自登录：不因为名字撞车就并成一个人。
    expect((await queue.aggregateFor(idOf("u-one"), 0)).map((item) => item.playerId)).toEqual([
      "u-one",
    ]);
    expect((await queue.aggregateFor(idOf("u-two"), 0)).map((item) => item.playerId)).toEqual([
      "u-two",
    ]);
    // 游客之间并列，且不含同昵称的登录条目。
    expect(
      (await queue.aggregateFor(idOf("guest-a"), 0)).map((item) => item.playerId).sort()
    ).toEqual(["guest-a", "guest-b"]);
  });
  test("窗口外与不存在的 id：窗口外不参与，未知 id 回空", async () => {
    const queue = new InMemoryAntiCheatReviewQueue();
    queue.add(queued({ playerId: "old", userId: "u1", recordedAt: 1_000 }));
    queue.add(queued({ playerId: "new", userId: "u1", recordedAt: 2_000 }));
    const newest = queue.reviews.find((item) => item.playerId === "new")!;
    expect((await queue.aggregateFor(newest.id, 1_500)).map((item) => item.playerId)).toEqual([
      "new",
    ]);
    expect(await queue.aggregateFor("mem_missing", 0)).toEqual([]);
  });
  test("极端数据封顶：最多读这些条，不把后台查询拖长", async () => {
    const queue = new InMemoryAntiCheatReviewQueue();
    for (let i = 0; i < CEE_ANTI_CHEAT_AGGREGATE_MAX_ITEMS + 5; i++)
      queue.add(queued({ playerId: `p-${i}`, userId: "u1" }));
    const newest = queue.reviews[0]!;
    expect((await queue.aggregateFor(newest.id, 0)).length).toBe(
      CEE_ANTI_CHEAT_AGGREGATE_MAX_ITEMS
    );
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
  const host = await h.create("房主", trusted("u-host"), { bakaAntiCheat: antiCheat });
  const guest = await h.join("猜题人", identityOfGuesser);
  await h.configure(host, {});
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
    const host = await h.create("房主", trusted("u-host"), { bakaAntiCheat: true });
    const guest = await h.join("猜题人", trusted("u-two"));
    await h.configure(host, {});
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
