/**
 * 排位题库标定：只读本地数据集，把五档答案池、人机平均步数、锚点对战矩阵与爱噶胜率打成 Markdown 打到标准输出。
 *
 * 用法：`bun run scripts/CEERankedCalibrate.ts [dbPath] [--seed N]`
 * 数据集缺省为 `Server/data/bangumi.sqlite`。离线工具，不进 CI：数字只用于人工核对
 * 「难度随档位单调递增」与分数—胜率曲线是否还贴合锚点，改动规则后重跑一次即可。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CEE_RANKED_AIGA_OPENING_ID,
  CEE_RANKED_BOT_ANCHORS,
  CEE_RANKED_PERSONAS,
  ceeRankedBotStrength,
  type CEERankedBotStrength,
  type CEERankedPersona,
  type CEERankedPersonaId,
} from "../src/domain/CEERankedBot";
import {
  CEE_RANKED_ALL_DIMENSIONS,
  evaluateCEEGuess,
  rankCEEOpenings,
  type CEERankedCandidate,
} from "../src/domain/CEERankedSolver";
import {
  simulateCEERankedGame,
  simulateCEERankedSeries,
  type CEERankedSimInput,
} from "../src/domain/CEERankedSimulation";
import { beijingDay } from "../src/domain/BeijingDay";
import { isAppError } from "../src/domain/Errors";
import { CEECharacterRepository } from "../src/infrastructure/CEECharacterRepository";
import {
  CEE_RANKED_COUNTDOWN_MS,
  CEE_RANKED_GAME_MS,
  CEE_RANKED_OVERTIME_ATTEMPTS,
  CEE_RANKED_OVERTIME_MS,
  CEE_RANKED_TIERS,
  ceeRankedTier,
  createCEERankedSettings,
  type CEERankedTierId,
} from "../src/shared/CEERankedValues";
import type { CEECharacterView, CEESettings } from "../src/shared/CEE";

const SOLO_GAMES = 300;
const SERIES_GAMES = 200;
/** Elo style 胜率曲线的斜率与跨度，与 `shared/CEERanked` 的计分口径一致。 */
const EXPECTED_WIN_K = 1.5;
const EXPECTED_WIN_SPAN = 400;

/** 带种子 PRNG（mulberry32）：标定数字必须能靠 `--seed` 复现。 */
const createRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

const personaOf = (id: CEERankedPersonaId): CEERankedPersona => {
  const persona = CEE_RANKED_PERSONAS.find((item) => item.id === id);
  if (!persona) throw new Error(`缺少人格 ${id}`);
  return persona;
};

const expectedWinRate = (ratingHigh: number, ratingLow: number): number =>
  1 / (1 + 10 ** ((ratingLow - ratingHigh) * (EXPECTED_WIN_K / EXPECTED_WIN_SPAN)));

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const fixed = (value: number, digits: number): string => value.toFixed(digits);
const displayName = (character: CEECharacterView): string =>
  character.nameCn || character.name || `#${character.id}`;

interface TierPool {
  tierId: CEERankedTierId;
  settings: CEESettings;
  candidates: CEERankedCandidate[];
  openings: Array<{ id: number; expectedRemaining: number; worstClass: number }>;
  extraViews: Map<number, CEECharacterView>;
  /** 该档题库里出现过的作品数：候选出场去重（端口只给候选，不给作品清单）。 */
  subjectCount: number;
}

const buildTierPool = async (
  repository: CEECharacterRepository,
  tierId: CEERankedTierId,
  year: number
): Promise<TierPool> => {
  const tier = ceeRankedTier(tierId);
  const settings = createCEERankedSettings(tier, year);
  const candidates = await repository.listRankedCandidates(settings);
  const openings = rankCEEOpenings(candidates, settings);
  const subjectIds = new Set<number>();
  for (const candidate of candidates)
    for (const appearance of candidate.character.appearances) subjectIds.add(appearance.id);
  const extraViews = new Map<number, CEECharacterView>();
  try {
    const aiga = await repository.getCharacter(CEE_RANKED_AIGA_OPENING_ID, settings);
    extraViews.set(aiga.id, aiga);
  } catch (error) {
    // 数据集里没有丰川祥子时爱噶退化成普通首猜；其它故障照原样抛出。
    if (!isAppError(error) || error.code !== "CEE_CHARACTER_NOT_FOUND") throw error;
  }
  return {
    tierId,
    settings,
    candidates,
    openings,
    extraViews,
    subjectCount: subjectIds.size,
  };
};

const timingOf = (settings: CEESettings): CEERankedSimInput["timing"] => ({
  countdownMs: CEE_RANKED_COUNTDOWN_MS,
  gameMs: CEE_RANKED_GAME_MS,
  overtimeMs: CEE_RANKED_OVERTIME_MS,
  overtimeAttempts: CEE_RANKED_OVERTIME_ATTEMPTS,
  maxAttempts: settings.maxAttempts,
});

/** 爱噶单人求解：对手是只认识 1 个角色的空壳（`drawKnown` 至少抽一个），它偷到答案的概率约 1/池大小。 */
const shellStrength = (strength: CEERankedBotStrength): CEERankedBotStrength => ({
  ...strength,
  knowledge: 0,
  recallRate: 0,
  mistakeRate: 0,
});

/** 按权重抽一道题当本局答案，口径与 `simulateCEERankedSeries` 的选题一致。 */
const drawAnswerId = (pool: CEERankedCandidate[], random: () => number): number => {
  const total = pool.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  let roll = random() * total;
  for (const item of pool) {
    roll -= Math.max(0, item.weight);
    if (roll < 0) return item.character.id;
  }
  return pool[pool.length - 1].character.id;
};

const runSolo = (
  pool: TierPool,
  rating: number,
  strength: CEERankedBotStrength,
  random: () => number
): { meanAttempts: number; solveRate: number } => {
  const aiga = personaOf("aiga");
  const shell = personaOf("awen");
  let solved = 0;
  let attempts = 0;
  for (let game = 0; game < SOLO_GAMES; game += 1) {
    const result = simulateCEERankedGame({
      answerId: drawAnswerId(pool.candidates, random),
      pool: pool.candidates,
      openings: pool.openings,
      settings: pool.settings,
      extraViews: pool.extraViews,
      timing: timingOf(pool.settings),
      random,
      bots: [
        { persona: aiga, strength, opponentRating: rating },
        { persona: shell, strength: shellStrength(strength), opponentRating: rating },
      ],
    });
    if (result.winner !== 0) continue;
    solved += 1;
    attempts += result.attempts[0];
  }
  return {
    meanAttempts: solved ? attempts / solved : Number.NaN,
    solveRate: solved / SOLO_GAMES,
  };
};

const runSeriesWinRate = (
  pool: TierPool,
  left: CEERankedSimInput["bots"][number],
  right: CEERankedSimInput["bots"][number],
  random: () => number
): number => {
  let points = 0;
  for (let match = 0; match < SERIES_GAMES; match += 1) {
    const series = simulateCEERankedSeries({
      pool: pool.candidates,
      openings: pool.openings,
      settings: pool.settings,
      extraViews: pool.extraViews,
      timing: timingOf(pool.settings),
      random,
      bots: [left, right],
    });
    // 平局按各 0.5 分计，与积分口径一致。
    points += series.winner === null ? 0.5 : series.winner === 0 ? 1 : 0;
  }
  return points / SERIES_GAMES;
};

/** 解析 `[dbPath] [--seed N]`：位置参数与 `--seed` 的取值都不当作数据集路径。 */
const parseArgs = (): { dbPath: string; seed: number } => {
  const argv = process.argv.slice(2);
  const seedFlag = argv.indexOf("--seed");
  const seed = seedFlag < 0 ? 42 : Number(argv[seedFlag + 1]);
  const defaultDbPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "data",
    "bangumi.sqlite"
  );
  const dbPath = resolve(
    argv.filter((arg, index) => !arg.startsWith("--") && index !== seedFlag + 1)[0] ?? defaultDbPath
  );
  return { dbPath, seed };
};

const tierPoolOf = (pools: TierPool[], tierId: CEERankedTierId): TierPool | undefined =>
  pools.find((pool) => pool.tierId === tierId);

/** 丰川祥子的首猜质量：在池里读排名，不在池里按场外猜测现算，读不到视图就是数据集没这个角色。 */
const aigaRemainingOf = (pool: TierPool, inPool: boolean): string => {
  const view = pool.extraViews.get(CEE_RANKED_AIGA_OPENING_ID);
  if (!view) return "无此角色";
  if (inPool)
    return fixed(
      pool.openings.find((entry) => entry.id === CEE_RANKED_AIGA_OPENING_ID)?.expectedRemaining ??
        Number.NaN,
      2
    );
  return fixed(
    evaluateCEEGuess(view, pool.candidates, CEE_RANKED_ALL_DIMENSIONS, pool.settings)
      .expectedRemaining,
    2
  );
};

const overviewRow = (pool: TierPool): string => {
  const best = pool.openings[0];
  const bestCharacter = pool.candidates.find(
    (candidate) => candidate.character.id === best?.id
  )?.character;
  const inPool = pool.candidates.some(
    (candidate) => candidate.character.id === CEE_RANKED_AIGA_OPENING_ID
  );
  return `| ${pool.tierId} | ${pool.settings.startYear}–${pool.settings.endYear} | ${
    pool.subjectCount
  } | ${pool.candidates.length} | ${bestCharacter ? displayName(bestCharacter) : "—"} | ${
    best ? fixed(best.expectedRemaining, 2) : "—"
  } | ${best ? best.worstClass : "—"} | ${inPool ? "是" : "否"} | ${aigaRemainingOf(
    pool,
    inPool
  )} |`;
};

const overviewSection = (pools: TierPool[]): string[] => {
  const lines: string[] = [
    "",
    "## 一、难度档概览",
    "",
    "| 档 | 年代 | 作品数 | 池大小 | 最优首猜 | expectedRemaining | worstClass | 丰川祥子在池 | 她作为首猜的 expectedRemaining |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const pool of pools) lines.push(overviewRow(pool));
  lines.push("");
  lines.push("作品数按候选出场作品去重统计（题库端口只返回角色，不返回作品清单）。");
  return lines;
};

const soloSection = (pools: TierPool[], random: () => number): string[] => {
  const lines: string[] = [
    "",
    `## 二、人机平均步数（爱噶单人求解，每档 × 每个强度锚点各 ${SOLO_GAMES} 局）`,
    "",
    "| 档 | 对手分数 | 平均猜中步数 | 猜中率 |",
    "| --- | --- | --- | --- |",
  ];
  for (const pool of pools) {
    for (const anchor of CEE_RANKED_BOT_ANCHORS) {
      const solo = runSolo(pool, anchor.rating, anchor.strength, random);
      lines.push(
        `| ${pool.tierId} | ${anchor.rating} | ${
          Number.isNaN(solo.meanAttempts) ? "—" : fixed(solo.meanAttempts, 2)
        } | ${percent(solo.solveRate)} |`
      );
    }
  }
  return lines;
};

const matrixSection = (pools: TierPool[], random: () => number): string[] => {
  const lines: string[] = [
    "",
    `## 三、锚点对战矩阵（d3，相邻锚点各 ${SERIES_GAMES} 场系列赛，双方都用阿稳）`,
    "",
    "| 高分 | 低分 | 实际胜率 | 期望胜率 | 差值 |",
    "| --- | --- | --- | --- | --- |",
  ];
  const d3 = tierPoolOf(pools, "d3");
  if (!d3) return lines;
  const awen = personaOf("awen");
  for (let index = 1; index < CEE_RANKED_BOT_ANCHORS.length; index += 1) {
    const high = CEE_RANKED_BOT_ANCHORS[index];
    const low = CEE_RANKED_BOT_ANCHORS[index - 1];
    const actual = runSeriesWinRate(
      d3,
      { persona: awen, strength: high.strength, opponentRating: low.rating },
      { persona: awen, strength: low.strength, opponentRating: high.rating },
      random
    );
    const expected = expectedWinRate(high.rating, low.rating);
    lines.push(
      `| ${high.rating} | ${low.rating} | ${percent(actual)} | ${percent(expected)} | ${fixed(
        actual - expected,
        3
      )} |`
    );
  }
  return lines;
};

const aigaSection = (pools: TierPool[], random: () => number): string[] => {
  const lines: string[] = [
    "",
    `## 四、爱噶对齐（爱噶 opponentRating = R，对强度 R 的阿稳，各 ${SERIES_GAMES} 场系列赛）`,
    "",
    "| 档 | R | 爱噶胜率 |",
    "| --- | --- | --- |",
  ];
  const aiga = personaOf("aiga");
  const awen = personaOf("awen");
  for (const tierId of ["d1", "d3", "d5"] as CEERankedTierId[]) {
    const pool = tierPoolOf(pools, tierId);
    if (!pool) continue;
    for (const rating of [1100, 1500, 1900, 2300]) {
      // `() => 1` 让离散字段不偏移，取该分数对应的纯净插值强度，胜负只由分数决定。
      const strength = ceeRankedBotStrength(rating, () => 1);
      const winRate = runSeriesWinRate(
        pool,
        { persona: aiga, strength, opponentRating: rating },
        { persona: awen, strength, opponentRating: rating },
        random
      );
      lines.push(`| ${tierId} | ${rating} | ${percent(winRate)} |`);
    }
  }
  return lines;
};

const main = async (): Promise<void> => {
  const { dbPath, seed } = parseArgs();
  const day = beijingDay(Date.now());
  const year = Number(day.slice(0, 4));
  const repository = new CEECharacterRepository({ dbPath, readonly: true });
  await repository.initialize();
  const pools: TierPool[] = [];
  for (const tier of CEE_RANKED_TIERS) pools.push(await buildTierPool(repository, tier.id, year));
  await repository.close();

  const random = createRandom(seed);
  console.log(
    [
      "# 排位题库标定",
      "",
      `- 数据集：\`${dbPath}\``,
      `- 种子：${seed}（用法：\`bun run scripts/CEERankedCalibrate.ts [dbPath] [--seed N]\`）`,
      `- 北京日：${day}，题库年代按 ${year} 计算`,
      ...overviewSection(pools),
      ...soloSection(pools, random),
      ...matrixSection(pools, random),
      ...aigaSection(pools, random),
    ].join("\n")
  );
};

await main();
