import { describe, expect, it } from "bun:test";
import {
  CEE_RANKED_AIGA_OPENING_ID,
  CEE_RANKED_PERSONAS,
  ceeRankedBotStrength,
  createCEERankedBot,
  type CEERankedBotStrength,
  type CEERankedPersona,
  type CEERankedPersonaId,
} from "../src/domain/CEERankedBot";
import { type CEERankedCandidate, rankCEEOpenings } from "../src/domain/CEERankedSolver";
import {
  type CEERankedSimBot,
  type CEERankedSimInput,
  type CEERankedSimTiming,
  simulateCEERankedGame,
  simulateCEERankedSeries,
} from "../src/domain/CEERankedSimulation";
import {
  createDefaultCEESettings,
  type CEEAppearance,
  type CEECharacterView,
} from "../src/shared/CEE";

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

// ==================== 合成题库（八个角色） ====================
const appearance = (id: number, year: number, rating: number): CEEAppearance => ({
  id,
  name: `作品${id}`,
  nameCn: `作品${id}`,
  year,
  rating,
  ratingCount: 100,
});

const view = (overrides: Partial<CEECharacterView> & { id: number }): CEECharacterView => ({
  name: `角色${overrides.id}`,
  nameCn: `角色${overrides.id}`,
  gender: "female",
  popularity: 100,
  summary: "",
  appearances: [appearance(1, 2020, 8)],
  highestRating: 8,
  earliestAppearance: 2020,
  latestAppearance: 2020,
  subjectTags: ["校园"],
  characterTags: ["黑发"],
  voiceActors: ["声优甲"],
  metaTags: [],
  comparisonAppearances: [{ id: 1, name: "作品1", nameCn: "作品1" }],
  extraTags: [{ section: "属性", tags: ["火"] }],
  ...overrides,
});

const makeCandidate = (
  id: number,
  gender: "male" | "female",
  popularity: number,
  works: number[][],
  subject: string[],
  voice: string[],
  weight = 1
): CEERankedCandidate => {
  const appearances = works.map(([workId, year, rating]) => appearance(workId, year, rating));
  return {
    weight,
    character: view({
      id,
      gender,
      popularity,
      appearances,
      highestRating: Math.max(...appearances.map((item) => item.rating)),
      earliestAppearance: Math.min(...appearances.map((item) => item.year)),
      latestAppearance: Math.max(...appearances.map((item) => item.year)),
      subjectTags: subject,
      voiceActors: voice,
      comparisonAppearances: appearances.map((item) => ({
        id: item.id,
        name: item.name,
        nameCn: item.nameCn,
      })),
    }),
  };
};

const fixed =
  (value: number): (() => number) =>
  () =>
    value;

const pool: CEERankedCandidate[] = [
  makeCandidate(101, "female", 300, [[1, 2021, 9]], ["校园"], ["声优甲"], 2),
  makeCandidate(102, "male", 120, [[3, 2019, 8]], ["运动"], ["声优乙"]),
  makeCandidate(
    103,
    "female",
    400,
    [
      [1, 2021, 9],
      [4, 2023, 6],
    ],
    ["奇幻"],
    ["声优丙"]
  ),
  makeCandidate(104, "male", 60, [[5, 2016, 7]], ["科幻"], ["声优甲"]),
  makeCandidate(
    105,
    "female",
    220,
    [
      [2, 2022, 7],
      [6, 2020, 8],
    ],
    ["日常"],
    ["声优丁"]
  ),
  makeCandidate(106, "male", 350, [[4, 2023, 6]], ["悬疑"], ["声优戊"]),
  makeCandidate(
    107,
    "female",
    90,
    [
      [5, 2016, 7],
      [3, 2019, 8],
    ],
    ["科幻", "音乐"],
    ["声优乙"]
  ),
  makeCandidate(
    108,
    "male",
    480,
    [
      [6, 2020, 8],
      [1, 2021, 9],
    ],
    ["日常"],
    ["声优丙"],
    3
  ),
];
const settings = createDefaultCEESettings();
const openings = rankCEEOpenings(pool, settings);
const personaOf = (id: CEERankedPersonaId): CEERankedPersona => {
  const found = CEE_RANKED_PERSONAS.find((persona) => persona.id === id);
  if (!found) throw new Error(`缺少人格 ${id}`);
  return found;
};
const strengthOf = (rating: number): CEERankedBotStrength =>
  ceeRankedBotStrength(rating, seeded(rating));
const aigaOpeningViews = (): ReadonlyMap<number, CEECharacterView> =>
  new Map([
    [CEE_RANKED_AIGA_OPENING_ID, view({ id: CEE_RANKED_AIGA_OPENING_ID, popularity: 500 })],
  ]);
const timing: CEERankedSimTiming = {
  countdownMs: 5000,
  gameMs: 180000,
  overtimeMs: 90000,
  overtimeAttempts: 3,
  maxAttempts: 8,
};
const bot = (id: CEERankedPersonaId, rating: number): CEERankedSimBot => ({
  persona: personaOf(id),
  strength: strengthOf(rating),
  opponentRating: rating,
});
const buildInput = (
  random: () => number,
  bots: [CEERankedSimBot, CEERankedSimBot],
  overrides: Partial<CEERankedSimInput> = {}
): CEERankedSimInput => ({
  pool,
  openings,
  settings,
  extraViews: aigaOpeningViews(),
  bots,
  timing,
  random,
  ...overrides,
});

describe("CEE 排位赛跑模拟", () => {
  it("同一颗骰子两次跑出完全相同的结果", () => {
    const first = simulateCEERankedSeries(
      buildInput(seeded(42), [bot("awen", 1700), bot("dango", 1100)])
    );
    const second = simulateCEERankedSeries(
      buildInput(seeded(42), [bot("awen", 1700), bot("dango", 1100)])
    );
    expect(first).toEqual(second);
    expect(first.points[0] + first.points[1]).toBe(2);
    expect([0, 1, null]).toContain(first.winner);
  });

  it("出手更快的一方先猜中，即使两人的人格完全相同", () => {
    const slow = bot("aiga", 800);
    const fast = bot("aiga", 2300);
    const result = simulateCEERankedGame({
      ...buildInput(seeded(7), [slow, fast]),
      answerId: 104,
    });
    expect(result.winner).toBe(1);
    expect(result.overtime).toBe(false);
    expect(result.attempts[0]).toBe(0);
    expect(result.attempts[1]).toBeGreaterThan(1);
  });

  it("同一时刻出手时 0 号先，两人完全对称时 0 号获胜", () => {
    const twin = bot("aiga", 1500);
    const game = simulateCEERankedGame({
      ...buildInput(fixed(0.5), [twin, twin]),
      answerId: 106,
    });
    expect(game.winner).toBe(0);
    expect(game.attempts[0]).toBeGreaterThanOrEqual(game.attempts[1]);
    expect(game.attempts[0] - game.attempts[1]).toBeLessThanOrEqual(1);
  });

  it("爱噶的首猜取不到视图时白废一手，后续仍能推进", () => {
    const withView = simulateCEERankedGame({
      ...buildInput(seeded(9), [bot("aiga", 2300), bot("dango", 800)]),
      answerId: 104,
    });
    expect(withView.winner).toBe(0);
    expect(withView.attempts[0]).toBeGreaterThanOrEqual(2);
    const withoutView = simulateCEERankedGame({
      ...buildInput(seeded(9), [bot("aiga", 2300), bot("dango", 800)]),
      extraViews: new Map(),
      answerId: 104,
    });
    expect(withoutView.winner).toBe(0);
    expect(withoutView.attempts[0]).toBeGreaterThanOrEqual(withView.attempts[0]);
  });

  it("双方都没出手时判平局，每局各记 0.5 分", () => {
    const stalled = simulateCEERankedGame({
      ...buildInput(seeded(10), [bot("awen", 2300), bot("awen", 2300)]),
      timing: { ...timing, maxAttempts: 0, overtimeAttempts: 0 },
      answerId: 105,
    });
    expect(stalled).toEqual({ winner: null, attempts: [0, 0], overtime: true });
    const series = simulateCEERankedSeries(
      buildInput(seeded(10), [bot("awen", 2300), bot("awen", 2300)], {
        timing: { ...timing, maxAttempts: 0, overtimeAttempts: 0 },
      })
    );
    expect(series).toEqual({ winner: null, points: [1.5, 1.5] });
  });

  it("常规次数用尽后进入加时，双方都补上加时次数并继续出手", () => {
    const aiga = bot("aiga", 2300);
    const tight = simulateCEERankedGame({
      ...buildInput(fixed(0.5), [aiga, aiga]),
      timing: { ...timing, gameMs: 10000, overtimeMs: 200000, maxAttempts: 1, overtimeAttempts: 8 },
      answerId: 103,
    });
    expect(tight.overtime).toBe(true);
    expect(tight.winner).toBe(0);
    expect(tight.attempts[0]).toBeGreaterThan(1);
    expect(tight.attempts[1]).toBeLessThanOrEqual(tight.attempts[0]);
  });

  it("2300 档对 800 档打 200 场系列赛，强者胜率超过七成", () => {
    const strong = bot("awen", 2300);
    const weak = bot("dango", 800);
    let strongWins = 0;
    let weakWins = 0;
    for (let index = 0; index < 200; index += 1) {
      const series = simulateCEERankedSeries(buildInput(seeded(1000 + index), [strong, weak]));
      if (series.winner === 0) strongWins += 1;
      if (series.winner === 1) weakWins += 1;
    }
    expect(strongWins / 200).toBeGreaterThan(0.7);
    expect(weakWins).toBeLessThan(strongWins / 2);
  });

  it("创建大脑不消耗题库以外的角色，且整局都能按 weight 抽题", () => {
    const random = seeded(12);
    const brain = createCEERankedBot({
      persona: personaOf("kaoju"),
      strength: strengthOf(1400),
      opponentRating: 1400,
      pool,
      random,
    });
    expect(brain.known.size).toBeGreaterThan(0);
    expect(brain.known.size).toBeLessThanOrEqual(pool.length);
    const first = simulateCEERankedSeries(
      buildInput(seeded(13), [bot("kaoju", 1400), bot("yemao", 1400)])
    );
    expect(first.points[0] + first.points[1]).toBeLessThanOrEqual(3);
  });
});
