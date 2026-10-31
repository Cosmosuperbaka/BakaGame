import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { CEECharacterRepository } from "../src/infrastructure/CEECharacterRepository";
import {
  CEECharacterWorkerProvider,
  type CeeWorkerRequester,
} from "../src/infrastructure/CEECharacterWorkerProvider";
import {
  BangumiDataWorkerClient,
  type BangumiDataCall,
} from "../src/infrastructure/BangumiDataWorkerClient";
import { AppError } from "../src/domain/Errors";
import { ceeRankedTier, createCEERankedSettings } from "../src/shared/CEERankedValues";
import { beijingDay } from "../src/domain/BeijingDay";
import { createCEECharacterFixture } from "./CEECharacterFixtures";
import type { CEEDataOptions } from "../src/infrastructure/CEEData";
import type { CEERankedPool } from "../src/application/CEERankedPool";

/** 夹具时钟固定在 2026 年：题库的年代窗口不能跟着真实日历漂。 */
const now = Date.UTC(2026, 0, 1);
const dayMs = 86_400_000;

/**
 * 排位形态的夹具设置：d1 档，窗口收到 2023—2026。
 *
 * 收窄到 2023 起是为了躲开「空角色作品 17」—— 它在热度榜里但抽不出角色，
 * 落在窗口内会让 `chooseRandomCharacter` 随机抛 `CEE_NO_CHARACTER`，
 * 覆盖用例就变成在测异常而不是测集合。
 */
const rankedSettings = () => ({
  ...createCEERankedSettings(ceeRankedTier("d1"), 2026),
  startYear: 2023,
  endYear: 2026,
});

/** 确定性随机源，与生产 `Math.random` 无关。 */
const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** 固定 roll 序列：越界返回序列末尾，保证漏取样时是断言失败而不是无限循环。 */
const scripted =
  (values: number[]): (() => number) =>
  () =>
    values.shift() ?? values.at(-1) ?? 0;

const offlineFetcher = async () => {
  throw new Error("排位题库不得访问上游");
};

const cleanup: Array<() => Promise<void>> = [];
function createRepository(options: Partial<CEEDataOptions> = {}) {
  const fixture = createCEECharacterFixture();
  const repository = new CEECharacterRepository({
    ...fixture,
    now: () => now,
    fetcher: offlineFetcher,
    ...options,
  });
  cleanup.push(async () => {
    await repository.close();
    await rm(fixture.directory, { recursive: true, force: true });
  });
  return { ...fixture, repository };
}

const disposeAll = async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
};

/** Windows Bun 的 rejects 匹配器会阻塞 Worker 异步回包；先原生 await 再断言。 */
const rejectionOf = (request: Promise<unknown>) =>
  request.then(
    () => null,
    (error: unknown) => error
  );

afterEach(disposeAll);

test("排位题库的成员与随机出题能抽到的角色完全一致", async () => {
  const { repository } = createRepository();
  try {
    const settings = rankedSettings();
    const pool = await repository.listRankedCandidates(settings);
    const poolIds = new Set(pool.map((candidate) => candidate.character.id));
    expect([...poolIds].sort((a, b) => a - b)).toEqual([6, 7, 8, 9]);
    const random = seeded(20260101);
    const drawn = new Set<number>();
    for (let index = 0; index < 400; index += 1) {
      const character = await repository.chooseRandomCharacter(settings, random);
      // 抽到池外角色意味着两条口径分叉了
      expect(poolIds.has(character.id)).toBe(true);
      drawn.add(character.id);
    }
    for (const id of poolIds) expect(drawn.has(id)).toBe(true);
  } finally {
    await disposeAll();
  }
});

test("权重按先等概率抽作品、再等概率抽主角累加，跨作角色拿两份", async () => {
  const { repository } = createRepository();
  try {
    const pool = await repository.listRankedCandidates(rankedSettings());
    expect(pool.map((candidate) => candidate.character.id)).toEqual([6, 7, 8, 9]);
    // 作品甲 3 位主角、作品乙 2 位，S=2；角色 8 跨两部作品
    expect(pool.map((candidate) => candidate.weight)).toEqual([1 / 6, 1 / 6, 1 / 6 + 1 / 4, 1 / 4]);
    // 权重按 `1/(S×n)` 累加，浮点求和留最后一位误差
    expect(pool.reduce((sum, candidate) => sum + candidate.weight, 0)).toBeCloseTo(1, 12);
  } finally {
    await disposeAll();
  }
});

test("非排位形态的设置一律拒绝", async () => {
  const { repository } = createRepository();
  const base = rankedSettings();
  const broken = [
    { useIndex: true, indexId: 8 },
    { useSubjectPerYear: true },
    { addedSubjects: [20] },
    { mainCharacterOnly: false },
  ];
  try {
    for (const override of broken) {
      const error = await rejectionOf(repository.listRankedCandidates({ ...base, ...override }));
      expect(error).toMatchObject({
        code: "CEE_RANKED_SETTINGS_INVALID",
        message: "排位题库只支持固定参数档",
      });
    }
  } finally {
    await disposeAll();
  }
});

test("热度榜抽取顺序与重构前一致：同热度按编号、越界下标改在候选内随机", async () => {
  const { repository } = createRepository();
  try {
    // topNSubjects=1 时热度榜只剩作品 10（排位夹具热度更低），落点仍是主角 1
    expect(
      (
        await repository.chooseRandomCharacter(
          { ...rankedSettings(), startYear: 2010, topNSubjects: 1 },
          scripted([0, 0])
        )
      ).id
    ).toBe(1);
    // topNSubjects=2 时热度榜是 [10, 20]；下标 1 落作品甲，主角按 relation_order 取 6
    expect(
      (
        await repository.chooseRandomCharacter(
          { ...rankedSettings(), startYear: 2010, topNSubjects: 2 },
          scripted([0.5, 0])
        )
      ).id
    ).toBe(6);
    // 下标 19 越界（候选只有 5 部）改在候选内随机：第二次 roll 定作品（21），第三次定主角（8）
    expect(
      (
        await repository.chooseRandomCharacter(
          { ...rankedSettings(), startYear: 2010, topNSubjects: 20 },
          scripted([0.95, 0.41, 0])
        )
      ).id
    ).toBe(8);
  } finally {
    await disposeAll();
  }
});

test("Worker 路径返回同一份题库，首猜排名在 Worker 内算好", async () => {
  const fixture = createCEECharacterFixture();
  const client = new BangumiDataWorkerClient();
  const ready = client.init({
    method: "init",
    song: { dbPath: fixture.dbPath },
    cee: { dbPath: fixture.dbPath },
  });
  const provider = new CEECharacterWorkerProvider(client, ready);
  const local = new CEECharacterRepository({
    dbPath: fixture.dbPath,
    enrichmentPath: fixture.enrichmentPath,
    fetcher: offlineFetcher,
  });
  try {
    const pool = await provider.getRankedPool("d5", now);
    const direct = await local.listRankedCandidates(pool.settings);
    expect(pool.candidates).toEqual(direct);
    expect(pool.tier).toBe("d5");
    expect(pool.day).toBe(beijingDay(now));
    // 夹具里唯一进开局谱的角色是坂上智代（角色 8），热度 25 低于开局下限，
    // 其余开局谱角色和丰川祥子都不在这份数据集里：开局表与补充视图一起为空。
    expect(pool.openings).toEqual([]);
    expect(pool.extras).toEqual([]);
  } finally {
    await local.close();
    await client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}, 30_000);

/** 假 worker 客户端：只实现 `request`，记下调用并按时返回题库形状的回包。 */
class FakeRankedPoolRequester implements CeeWorkerRequester {
  readonly calls: BangumiDataCall[] = [];
  reply: () => Promise<unknown> = async () => ({ candidates: [], openings: [], extras: [] });
  async request(payload: BangumiDataCall): Promise<unknown> {
    this.calls.push(payload);
    return this.reply();
  }
}

test("提供者按档位与北京日缓存题库，失败不留缓存", async () => {
  const requester = new FakeRankedPoolRequester();
  const provider = new CEECharacterWorkerProvider(requester, Promise.resolve());
  const dayOne = now;
  const dayTwo = now + dayMs;

  const cold: CEERankedPool = await provider.getRankedPool("d3", dayOne);
  expect(requester.calls.length).toBe(1);
  expect(requester.calls[0]).toMatchObject({ method: "cee.rankedPool" });
  expect(cold.tier).toBe("d3");
  expect(cold.day).toBe(beijingDay(dayOne));
  // 已缓存的键不再请求，同键并发共享同一个 Promise
  const [first, second] = await Promise.all([
    provider.getRankedPool("d3", dayOne),
    provider.getRankedPool("d3", dayOne),
  ]);
  expect(requester.calls.length).toBe(1);
  expect(second).toBe(first);
  expect(first).toBe(cold);
  await provider.getRankedPool("d3", dayOne);
  expect(requester.calls.length).toBe(1);
  // 换档位重新请求
  await provider.getRankedPool("d1", dayOne);
  expect(requester.calls.length).toBe(2);
  // 换日丢掉旧键：档位复用同样要重新请求
  await provider.getRankedPool("d3", dayTwo);
  expect(requester.calls.length).toBe(3);
  await provider.getRankedPool("d1", dayTwo);
  expect(requester.calls.length).toBe(4);

  // 失败不留缓存：下一次同样请求会重试并成功
  requester.reply = async () => {
    throw new AppError("CEE_RANKED_SETTINGS_INVALID", "排位题库只支持固定参数档");
  };
  const failed = new CEECharacterWorkerProvider(requester, Promise.resolve());
  expect(await rejectionOf(failed.getRankedPool("d2", dayTwo))).toMatchObject({
    code: "CEE_RANKED_SETTINGS_INVALID",
  });
  expect(requester.calls.length).toBe(5);
  requester.reply = async () => ({ candidates: [], openings: [], extras: [] });
  const retried = await failed.getRankedPool("d2", dayTwo);
  expect(requester.calls.length).toBe(6);
  expect(retried.tier).toBe("d2");
});
