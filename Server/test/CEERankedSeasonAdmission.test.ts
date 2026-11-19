// ==================== 排位赛季准入测试 ====================
// 赛季窗外拒绝新开、结束时整队清退、在途系列赛跨过结束时刻照常结算。
// 时钟全部经夹具注入，边界直接取 S1 登记的起止时刻。
import { describe, expect, test } from "bun:test";
import { CEE_RANKED_SEASONS } from "../src/shared/CEERankedSeasons";
import { appErrorOf, exitAndAudit, rankedHarness } from "./CEERankedFixtures";

const s1 = CEE_RANKED_SEASONS.find((season) => season.id === "S1");
if (!s1) throw new Error("登记里没有赛季 S1");
const S1_START = Date.parse(s1.startsAt);
const S1_END = Date.parse(s1.endsAt);

describe("赛季准入", () => {
  test("赛季还没开始：排队被拒，文案带开始日期", async () => {
    const harness = rankedHarness({ startAt: S1_START - 1_000 });
    const client = harness.connect("甲");
    const error = await appErrorOf(() => harness.send(client, "cee.ranked.queue", {}));
    expect(error.code).toBe("RANKED_SEASON_CLOSED");
    expect(error.message).toContain("还没开始");
    expect(error.message).toContain("11 月 19 日");
    harness.service.close();
  });

  test("赛季还没开始：定级账号的排队（直开人机）同样被拒", async () => {
    const harness = rankedHarness({ startAt: S1_START - 1_000 });
    const client = harness.connect("甲");
    const error = await appErrorOf(() => harness.send(client, "cee.ranked.queue", {}));
    expect(error.code).toBe("RANKED_SEASON_CLOSED");
    expect(harness.poolCalls).toHaveLength(0);
    harness.service.close();
  });

  test("赛季还没开始：主动打人机被拒", async () => {
    const harness = rankedHarness({ startAt: S1_START - 1_000 });
    const client = harness.connect("甲");
    const error = await appErrorOf(() => harness.send(client, "cee.ranked.playBot", {}));
    expect(error.code).toBe("RANKED_SEASON_CLOSED");
    expect(error.message).toContain("还没开始");
    harness.service.close();
  });

  test("赛季已结束：排队与打人机都被拒，文案说明暂停", async () => {
    const harness = rankedHarness({ startAt: S1_END });
    const client = harness.connect("甲");
    const queueError = await appErrorOf(() => harness.send(client, "cee.ranked.queue", {}));
    expect(queueError.code).toBe("RANKED_SEASON_CLOSED");
    expect(queueError.message).toContain("本赛季已结束");
    const botError = await appErrorOf(() => harness.send(client, "cee.ranked.playBot", {}));
    expect(botError.code).toBe("RANKED_SEASON_CLOSED");
    expect(botError.message).toContain("本赛季已结束");
    harness.service.close();
  });

  test("赛季进行中：排队照常，不在排队时打人机仍报原有的相位错误", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    harness.seedRated(client.userId);
    await harness.send(client, "cee.ranked.queue", {});
    expect(harness.latest(client).status).toBe("queued");
    const other = harness.connect("乙");
    const error = await appErrorOf(() => harness.send(other, "cee.ranked.playBot", {}));
    expect(error.code).toBe("INVALID_PHASE");
    harness.service.close();
  });
});

describe("赛季结束时的队列清退", () => {
  test("还在队列里的玩家被移出并推回空闲，撮合与超时人机都不再开新场", async () => {
    const harness = rankedHarness({ startAt: S1_END - 5_000 });
    const first = harness.connect("甲");
    const second = harness.connect("乙");
    // 分差远超窗口上限：结束前不会被配成一对，只能留在队列里等清退。
    harness.seedRated(first.userId, { rating: 1500 });
    harness.seedRated(second.userId, { rating: 2400 });
    await harness.send(first, "cee.ranked.queue", {});
    await harness.send(second, "cee.ranked.queue", {});
    expect(harness.latest(first).status).toBe("queued");
    expect(harness.latest(second).status).toBe("queued");

    await harness.advance(6_000);
    expect(harness.latest(first).status).toBe("idle");
    expect(harness.latest(second).status).toBe("idle");
    expect(harness.states(first).some((state) => state.status === "series")).toBe(false);
    expect(harness.states(second).some((state) => state.status === "series")).toBe(false);

    // 再等过超时兜底时刻：队列已空，自动人机也不许开。
    await harness.advance(30_000);
    expect(harness.latest(first).status).toBe("idle");
    expect(harness.latest(second).status).toBe("idle");
    expect(harness.poolCalls).toHaveLength(0);
    harness.service.close();
  });
});

describe("在途系列赛跨过赛季结束", () => {
  test("照常打完并结算计分，结束后不能再排队", async () => {
    const harness = rankedHarness({ startAt: S1_END - 10_000 });
    const client = harness.connect("甲");
    // 定级账号排队直开人机：系列赛在赛季结束前开出。
    await harness.send(client, "cee.ranked.queue", {});
    expect(harness.latest(client).status).toBe("series");

    await harness.advance(15_000);
    expect(harness.clock()).toBeGreaterThan(S1_END);
    expect(harness.latest(client).status).toBe("series");

    const audit = await exitAndAudit(harness, client);
    expect(audit.players).toHaveLength(2);
    const rating = await harness.store.getRating(client.userId);
    expect(rating?.seriesPlayed).toBe(1);
    expect(rating?.losses).toBe(1);

    const error = await appErrorOf(() => harness.send(client, "cee.ranked.queue", {}));
    expect(error.code).toBe("RANKED_SEASON_CLOSED");
    harness.service.close();
  });
});

describe("资料带赛季字段", () => {
  test("赛季进行中：season 是当前赛季，nextSeason 为 null", async () => {
    const harness = rankedHarness();
    const client = harness.connect("甲");
    await harness.send(client, "cee.ranked.status", {});
    const profile = await harness.send(client, "cee.ranked.profile", {});
    expect(profile.season).toEqual(s1);
    expect(profile.nextSeason).toBeNull();
    harness.service.close();
  });

  test("赛季还没开始：season 为 null，nextSeason 给出开始时刻", async () => {
    const harness = rankedHarness({ startAt: S1_START - 1_000 });
    const client = harness.connect("甲");
    await harness.send(client, "cee.ranked.status", {});
    const profile = await harness.send(client, "cee.ranked.profile", {});
    expect(profile.season).toBeNull();
    expect(profile.nextSeason).toEqual(s1);
    harness.service.close();
  });

  test("赛季已结束且没有下一个：两者都为 null", async () => {
    const harness = rankedHarness({ startAt: S1_END });
    const client = harness.connect("甲");
    await harness.send(client, "cee.ranked.status", {});
    const profile = await harness.send(client, "cee.ranked.profile", {});
    expect(profile.season).toBeNull();
    expect(profile.nextSeason).toBeNull();
    harness.service.close();
  });
});
