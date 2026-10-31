/**
 * 排位人机标定：只读本地数据集，把五档答案池、人机对目标曲线的贴合度、锚点对战矩阵与爱噶胜率
 * 打成 Markdown 打到标准输出；`--tune` 模式在 d1 档搜索锚点参数。
 *
 * 用法：`bun run scripts/CEERankedCalibrate.ts [dbPath] [--seed N] [--tune]`
 * 数据集缺省为 `Server/data/bangumi.sqlite`。离线工具，不进 CI：数字只用于人工核对
 * 「难度随档位单调递增」与锚点是否还贴合真人曲线，改动规则后重跑一次即可。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CEE_RANKED_AIGA_OPENING_ID,
  CEE_RANKED_BOT_ANCHORS,
  CEE_RANKED_PERSONAS,
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
  CEE_RANKED_OPENING_BOOK,
  assembleCEERankedOpenings,
  type CEERankedOpening,
} from "../src/domain/CEERankedOpeningBook";
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
/** `--tune` 每个候选参数的模拟局数（简报要求 ≥300）。 */
const TUNE_GAMES = 300;
/** 实测值与目标的相对误差上限。 */
const TOLERANCE = 0.15;
/** 爱噶对同分基线人格的系列赛胜率目标：比普通人机难缠，但四局里输一局。 */
const AIGA_TARGET_WIN_RATE = 0.75;
/** Elo style 胜率曲线的斜率与跨度，与 `shared/CEERanked` 的计分口径一致。 */
const EXPECTED_WIN_K = 1.5;
const EXPECTED_WIN_SPAN = 400;

/**
 * 目标曲线（d1 入门档）：猜中率、猜中局的中位步数与中位用时都含加时。
 * 依据线上真人对局分布，1500 分对应真人中位，1100 / 1900 大致对应 p10 / p90。
 */
const TARGETS: ReadonlyArray<{
  rating: number;
  solveRate: number;
  medianAttempts: number;
  medianTimeMs: number;
}> = [
  { rating: 800, solveRate: 0.2, medianAttempts: 7, medianTimeMs: 190000 },
  { rating: 1100, solveRate: 0.35, medianAttempts: 6, medianTimeMs: 140000 },
  { rating: 1400, solveRate: 0.5, medianAttempts: 4.5, medianTimeMs: 100000 },
  { rating: 1700, solveRate: 0.65, medianAttempts: 3.5, medianTimeMs: 70000 },
  { rating: 2000, solveRate: 0.78, medianAttempts: 3, medianTimeMs: 50000 },
  { rating: 2300, solveRate: 0.88, medianAttempts: 2.5, medianTimeMs: 35000 },
];

/**
 * `--tune` 的搜索空间，三块各自单调：知识面与回忆率决定认不认得答案，推理等级决定线索用得多准，
 * 思考档决定快慢。推理等级把记忆、两个可靠度与犯错率捆成一档：它们彼此抵消，
 * 逐字段坐标下降会卡在「记忆很长但线索几乎不用」这类局部最优里。
 */
const KNOWLEDGE_GRID = [0.08, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.6] as const;
const RECALL_GRID = [0.05, 0.1, 0.12, 0.15, 0.2] as const;
type ReasoningFields = "memory" | "numericReliability" | "evidenceReliability" | "mistakeRate";
const REASONING_LEVELS: ReadonlyArray<Pick<CEERankedBotStrength, ReasoningFields>> = [
  { memory: 1, numericReliability: 0.2, evidenceReliability: 0.05, mistakeRate: 0.3 },
  { memory: 2, numericReliability: 0.35, evidenceReliability: 0.1, mistakeRate: 0.22 },
  { memory: 3, numericReliability: 0.5, evidenceReliability: 0.2, mistakeRate: 0.15 },
  { memory: 4, numericReliability: 0.65, evidenceReliability: 0.35, mistakeRate: 0.09 },
  { memory: 6, numericReliability: 0.8, evidenceReliability: 0.5, mistakeRate: 0.05 },
  { memory: 8, numericReliability: 0.9, evidenceReliability: 0.65, mistakeRate: 0.02 },
];
/** 思考档：之后各手与第一手的中位数，从慢到快。 */
const THINK_LEVELS: ReadonlyArray<
  Pick<CEERankedBotStrength, "thinkMedianMs" | "firstGuessMedianMs">
> = [
  { thinkMedianMs: 50000, firstGuessMedianMs: 17000 },
  { thinkMedianMs: 45000, firstGuessMedianMs: 15000 },
  { thinkMedianMs: 40000, firstGuessMedianMs: 13000 },
  { thinkMedianMs: 36000, firstGuessMedianMs: 12000 },
  { thinkMedianMs: 31000, firstGuessMedianMs: 11000 },
  { thinkMedianMs: 27000, firstGuessMedianMs: 10000 },
  { thinkMedianMs: 23000, firstGuessMedianMs: 9000 },
  { thinkMedianMs: 20000, firstGuessMedianMs: 8000 },
  { thinkMedianMs: 17000, firstGuessMedianMs: 7000 },
  { thinkMedianMs: 15000, firstGuessMedianMs: 6000 },
  { thinkMedianMs: 13000, firstGuessMedianMs: 5500 },
  { thinkMedianMs: 11000, firstGuessMedianMs: 5000 },
  { thinkMedianMs: 9000, firstGuessMedianMs: 4000 },
];

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

/**
 * 标定用基线人格：六个人格各带自己的思考倍率与犯错倍率，锚点必须表示「没有人格加成」的基线，
 * 否则同一档在不同人格之间会因为倍率而整体偏移。id 沿用 awen，只是数值取中性值。
 */
const BASELINE_PERSONA: CEERankedPersona = {
  id: "awen",
  name: "标定基线",
  popularityBias: 0.5,
  mistakeFactor: 1,
  thinkFactor: 1,
  lockOffset: 0,
  idleRate: 0,
  tempo: "steady",
  openingStyle: "ranked",
};

const expectedWinRate = (ratingHigh: number, ratingLow: number): number =>
  1 / (1 + 10 ** ((ratingLow - ratingHigh) * (EXPECTED_WIN_K / EXPECTED_WIN_SPAN)));

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const fixed = (value: number, digits: number): string => value.toFixed(digits);
const seconds = (value: number): string => `${(value / 1000).toFixed(0)}s`;
const displayName = (character: CEECharacterView): string =>
  character.nameCn || character.name || `#${character.id}`;

const median = (values: readonly number[]): number => {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

interface TierPool {
  tierId: CEERankedTierId;
  settings: CEESettings;
  candidates: CEERankedCandidate[];
  /** 开局谱装配出的开局，按本场题库的切分效果排序。 */
  openings: CEERankedOpening[];
  /** 本题库之外、人机会猜到的开局视图（含爱噶首猜）。 */
  extraViews: Map<number, CEECharacterView>;
  /** `rankCEEOpenings` 的结果：题库内最优首猜，只用于报告对照。 */
  inPoolOpenings: Array<{ id: number; expectedRemaining: number; worstClass: number }>;
  /** 该档题库里出现过的作品数：候选出场去重（端口只给候选，不给作品清单）。 */
  subjectCount: number;
}

/** 角色视图：数据集里没有就返回 undefined，其它故障照抛。 */
const viewOfCharacter = async (
  repository: CEECharacterRepository,
  id: number,
  settings: CEESettings
): Promise<CEECharacterView | undefined> => {
  try {
    return await repository.getCharacter(id, settings);
  } catch (error) {
    if (isAppError(error) && error.code === "CEE_CHARACTER_NOT_FOUND") return undefined;
    throw error;
  }
};

const buildTierPool = async (
  repository: CEECharacterRepository,
  tierId: CEERankedTierId,
  year: number
): Promise<TierPool> => {
  const tier = ceeRankedTier(tierId);
  const settings = createCEERankedSettings(tier, year);
  const candidates = await repository.listRankedCandidates(settings);
  const { openings, extras } = await assembleCEERankedOpenings({
    candidates,
    settings,
    viewOf: (id) => viewOfCharacter(repository, id, settings),
    extraIds: [CEE_RANKED_AIGA_OPENING_ID],
  });
  const subjectIds = new Set<number>();
  for (const candidate of candidates)
    for (const appearance of candidate.character.appearances) subjectIds.add(appearance.id);
  return {
    tierId,
    settings,
    candidates,
    openings,
    extraViews: new Map(extras.map((view) => [view.id, view])),
    inPoolOpenings: rankCEEOpenings(candidates, settings),
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

/** 陪跑的空壳：只认识 1 个角色、不回忆、犯错慢到 90 秒上限，偷到答案的概率约 1/池大小。 */
const shellStrength = (strength: CEERankedBotStrength): CEERankedBotStrength => ({
  ...strength,
  knowledge: 0,
  recallRate: 0,
  mistakeRate: 0,
  firstGuessMedianMs: 90000,
  thinkMedianMs: 90000,
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

interface SoloMetrics {
  solveRate: number;
  medianAttempts: number;
  medianTimeMs: number;
}

/** 单人解题：基线人格对空壳陪跑，统计猜中率与猜中局的中位步数、中位用时。 */
const runSoloMetrics = (
  pool: TierPool,
  persona: CEERankedPersona,
  strength: CEERankedBotStrength,
  opponentRating: number,
  random: () => number,
  games: number
): SoloMetrics => {
  const shell = personaOf("awen");
  const attempts: number[] = [];
  const times: number[] = [];
  for (let game = 0; game < games; game += 1) {
    const result = simulateCEERankedGame({
      answerId: drawAnswerId(pool.candidates, random),
      pool: pool.candidates,
      openings: pool.openings,
      settings: pool.settings,
      extraViews: pool.extraViews,
      timing: timingOf(pool.settings),
      random,
      bots: [
        { persona, strength, opponentRating },
        { persona: shell, strength: shellStrength(strength), opponentRating: 1200 },
      ],
    });
    if (result.winner !== 0) continue;
    attempts.push(result.attempts[0]);
    times.push(result.finishMs);
  }
  return {
    solveRate: attempts.length / games,
    medianAttempts: median(attempts),
    medianTimeMs: median(times),
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

/** 解析 `[dbPath] [--seed N] [--tune]`：位置参数与 `--seed` 的取值都不当作数据集路径。 */
const parseArgs = (): { dbPath: string; seed: number; tune: boolean } => {
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
    argv.filter(
      (arg, index) => !arg.startsWith("--") && (seedFlag < 0 || index !== seedFlag + 1)
    )[0] ?? defaultDbPath
  );
  return { dbPath, seed, tune: argv.includes("--tune") };
};

const tierPoolOf = (pools: TierPool[], tierId: CEERankedTierId): TierPool | undefined =>
  pools.find((pool) => pool.tierId === tierId);

/** 丰川祥子的首猜质量：在池里读排名，不在池里按场外猜测现算，读不到视图就是数据集没这个角色。 */
const aigaRemainingOf = (pool: TierPool, inPool: boolean): string => {
  // 她在池里时视图在候选里，不在 extras 里（extras 只放题库外的角色）。
  if (inPool)
    return fixed(
      pool.inPoolOpenings.find((entry) => entry.id === CEE_RANKED_AIGA_OPENING_ID)
        ?.expectedRemaining ?? Number.NaN,
      2
    );
  const view = pool.extraViews.get(CEE_RANKED_AIGA_OPENING_ID);
  if (!view) return "无此角色";
  return fixed(
    evaluateCEEGuess(view, pool.candidates, CEE_RANKED_ALL_DIMENSIONS, pool.settings)
      .expectedRemaining,
    2
  );
};

const nameOfOpening = (pool: TierPool, id: number | undefined): string => {
  if (id === undefined) return "—";
  const inPool = pool.candidates.find((item) => item.character.id === id)?.character;
  return displayName(inPool ?? pool.extraViews.get(id) ?? ({ id } as CEECharacterView));
};

const overviewRow = (pool: TierPool): string => {
  const bookBest = pool.openings[0];
  const best = pool.inPoolOpenings[0];
  const bestCharacter = pool.candidates.find(
    (candidate) => candidate.character.id === best?.id
  )?.character;
  const inPool = pool.candidates.some(
    (candidate) => candidate.character.id === CEE_RANKED_AIGA_OPENING_ID
  );
  return `| ${pool.tierId} | ${pool.settings.startYear}–${pool.settings.endYear} | ${
    pool.subjectCount
  } | ${pool.candidates.length} | ${nameOfOpening(pool, bookBest?.id)} | ${
    bookBest ? fixed(bookBest.expectedRemaining, 2) : "—"
  } | ${bestCharacter ? displayName(bestCharacter) : "—"} | ${
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
    "| 档 | 年代 | 作品数 | 池大小 | 开局谱最优开局 | 开局谱 expectedRemaining | 题库内最优首猜 | 题库内 expectedRemaining | worstClass | 丰川祥子在池 | 她作为首猜的 expectedRemaining |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const pool of pools) lines.push(overviewRow(pool));
  lines.push("");
  lines.push(
    `开局谱共 ${CEE_RANKED_OPENING_BOOK.length} 条，热度不低于 \`CEE_RANKED_OPENING_POPULARITY_MIN\` 且视图可取的才进场。`
  );
  lines.push("作品数按候选出场作品去重统计（题库端口只返回角色，不返回作品清单）。");
  return lines;
};

const relativeError = (value: number, target: number): number =>
  Math.abs(value - target) / Math.abs(target);

const toleranceMark = (metrics: SoloMetrics, target: (typeof TARGETS)[number]): string => {
  const errors = [
    relativeError(metrics.solveRate, target.solveRate),
    relativeError(metrics.medianAttempts, target.medianAttempts),
    relativeError(metrics.medianTimeMs, target.medianTimeMs),
  ];
  return errors.every((error) => error <= TOLERANCE)
    ? "✓"
    : `偏 ${fixed(Math.max(...errors) * 100, 0)}%`;
};

/** 每个锚点在指定档位上的实测，与目标曲线并排打印。 */
const curveSection = (pools: TierPool[], random: () => number): string[] => {
  const lines: string[] = [
    "",
    `## 二、目标曲线对照（基线人格单人解题，每格 ${SOLO_GAMES} 局；目标为 d1 档标定值）`,
    "",
    "| 档 | 锚点 | 目标猜中率 | 实测猜中率 | 目标步数 | 实测步数 | 目标用时 | 实测用时 | 判定 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const tierId of ["d1", "d3", "d5"] as CEERankedTierId[]) {
    const pool = tierPoolOf(pools, tierId);
    if (!pool) continue;
    for (const target of TARGETS) {
      const anchor = CEE_RANKED_BOT_ANCHORS.find((item) => item.rating === target.rating);
      if (!anchor) continue;
      const metrics = runSoloMetrics(
        pool,
        BASELINE_PERSONA,
        anchor.strength,
        target.rating,
        random,
        SOLO_GAMES
      );
      lines.push(
        `| ${tierId} | ${target.rating} | ${percent(target.solveRate)} | ${percent(
          metrics.solveRate
        )} | ${fixed(target.medianAttempts, 1)} | ${fixed(metrics.medianAttempts, 1)} | ${seconds(
          target.medianTimeMs
        )} | ${seconds(metrics.medianTimeMs)} | ${
          tierId === "d1" ? toleranceMark(metrics, target) : "—"
        } |`
      );
    }
  }
  lines.push("");
  lines.push("d3、d5 用同一组目标只作对照：同一锚点在更难的档位应当更难。");
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
    `## 四、爱噶对齐（爱噶 opponentRating = R，对 R 锚点强度的基线人格，各 ${SERIES_GAMES} 场系列赛；d1 目标 ${percent(
      AIGA_TARGET_WIN_RATE
    )}）`,
    "",
    "| 档 | R | 爱噶胜率 |",
    "| --- | --- | --- |",
  ];
  const aiga = personaOf("aiga");
  for (const tierId of ["d1", "d3", "d5"] as CEERankedTierId[]) {
    const pool = tierPoolOf(pools, tierId);
    if (!pool) continue;
    for (const anchor of CEE_RANKED_BOT_ANCHORS) {
      // 爱噶不看强度表，两边传同一份锚点强度即可；她的速度只跟 opponentRating 走。
      const winRate = runSeriesWinRate(
        pool,
        { persona: aiga, strength: anchor.strength, opponentRating: anchor.rating },
        { persona: BASELINE_PERSONA, strength: anchor.strength, opponentRating: anchor.rating },
        random
      );
      lines.push(`| ${tierId} | ${anchor.rating} | ${percent(winRate)} |`);
    }
  }
  lines.push("");
  lines.push(
    "她比同分人机强出的部分按 `CEE_RANKED_BOT_BIAS_PRIOR.aiga` 记在计分上；上线后由自动校准按真人战绩修正。"
  );
  return lines;
};

/** 爱噶的用时：她的间隔只跟对手分数走，这里列出各分数下的猜中率与中位用时供核对。 */
const aigaTimingSection = (pools: TierPool[], random: () => number): string[] => {
  const lines: string[] = [
    "",
    `## 五、爱噶用时对照（d1，基线人格当空壳陪跑她，每格 ${SOLO_GAMES} 局）`,
    "",
    "| 对手分数 | 她的中位用时 | 她的猜中率 |",
    "| --- | --- | --- |",
  ];
  const d1 = tierPoolOf(pools, "d1");
  if (!d1) return lines;
  const aiga = personaOf("aiga");
  for (const target of TARGETS) {
    // 爱噶自己不看强度表，陪跑空壳用 d1 锚点的强度即可；她的间隔只跟对手分数走。
    const strength = CEE_RANKED_BOT_ANCHORS[0].strength;
    const metrics = runSoloMetrics(d1, aiga, strength, target.rating, random, SOLO_GAMES);
    lines.push(
      `| ${target.rating} | ${seconds(metrics.medianTimeMs)} | ${percent(metrics.solveRate)} |`
    );
  }
  return lines;
};

// ==================== --tune ====================

/** 一个锚点的取值：四块各取网格下标，下标越大越强。 */
interface TuneChoice {
  knowledge: number;
  recall: number;
  reasoning: number;
  think: number;
}

interface TuneResult {
  rating: number;
  choice: TuneChoice;
  strength: CEERankedBotStrength;
  metrics: SoloMetrics;
}

const strengthOf = (base: CEERankedBotStrength, choice: TuneChoice): CEERankedBotStrength => ({
  ...base,
  knowledge: KNOWLEDGE_GRID[choice.knowledge],
  recallRate: RECALL_GRID[choice.recall],
  ...REASONING_LEVELS[choice.reasoning],
  ...THINK_LEVELS[choice.think],
});

/**
 * 猜中率权重 3：它直接决定真人赢不赢得了；70 人的入门池里人机步数普遍到不了真人的 6～7 步，
 * 步数与用时只作次要项，避免为了凑步数把猜中率拉偏。
 */
const objectiveOf = (metrics: SoloMetrics, target: (typeof TARGETS)[number]): number =>
  3 * relativeError(metrics.solveRate, target.solveRate) ** 2 +
  relativeError(metrics.medianAttempts, target.medianAttempts) ** 2 +
  relativeError(metrics.medianTimeMs, target.medianTimeMs) ** 2;

const range = (from: number, length: number): number[] =>
  Array.from({ length: length - from }, (_, offset) => from + offset);

/** 起始思考档：取离当前锚点 thinkMedianMs 最近的一档，且不慢于更弱一档。 */
const initialThink = (anchor: CEERankedBotStrength, floor: number): number => {
  let best = floor;
  for (const index of range(floor, THINK_LEVELS.length))
    if (
      Math.abs(THINK_LEVELS[index].thinkMedianMs - anchor.thinkMedianMs) <
      Math.abs(THINK_LEVELS[best].thinkMedianMs - anchor.thinkMedianMs)
    )
      best = index;
  return best;
};

/**
 * 每个锚点：固定思考档，网格搜知识面 × 回忆率 × 推理等级；再固定这三项扫思考档；再网格搜一遍。
 * 各下标都不小于已调好的更弱一档，整表因此单调。同一锚点的每个候选从同一个种子重新起骰
 * （公共随机数），候选之间是配对比较，不会被抽样噪声带着走。
 */
const tuneAnchor = (
  pool: TierPool,
  index: number,
  previous: TuneChoice | undefined,
  seed: number
): TuneResult => {
  const target = TARGETS[index];
  const anchor = CEE_RANKED_BOT_ANCHORS[index];
  const floor: TuneChoice = previous ?? { knowledge: 0, recall: 0, reasoning: 0, think: 0 };
  const evaluate = (choice: TuneChoice): { metrics: SoloMetrics; score: number } => {
    const metrics = runSoloMetrics(
      pool,
      BASELINE_PERSONA,
      strengthOf(anchor.strength, choice),
      target.rating,
      createRandom(seed),
      TUNE_GAMES
    );
    return { metrics, score: objectiveOf(metrics, target) };
  };
  let choice: TuneChoice = { ...floor, think: initialThink(anchor.strength, floor.think) };
  let best = evaluate(choice);
  const consider = (candidate: TuneChoice): void => {
    const trial = evaluate(candidate);
    if (trial.score < best.score) {
      best = trial;
      choice = candidate;
    }
  };
  const searchKnowledge = (): void => {
    const think = choice.think;
    for (const knowledge of range(floor.knowledge, KNOWLEDGE_GRID.length))
      for (const recall of range(floor.recall, RECALL_GRID.length))
        for (const reasoning of range(floor.reasoning, REASONING_LEVELS.length))
          consider({ knowledge, recall, reasoning, think });
  };
  searchKnowledge();
  for (const think of range(floor.think, THINK_LEVELS.length)) consider({ ...choice, think });
  searchKnowledge();
  return {
    rating: anchor.rating,
    choice,
    strength: strengthOf(anchor.strength, choice),
    metrics: best.metrics,
  };
};

const tuneSection = (pool: TierPool, seed: number): string[] => {
  const lines: string[] = [
    "",
    `## 标定搜索（d1，基线人格单人解题，每个候选参数 ${TUNE_GAMES} 局，种子 ${seed}）`,
    "",
    "| 锚点 | knowledge | recallRate | 推理等级 | firstGuessMs | thinkMs | 猜中率 | 步数 | 用时 | 判定 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const results: TuneResult[] = [];
  for (const [index, target] of TARGETS.entries()) {
    // 每档一个种子：档内候选配对比较，跨档之间独立。
    const result = tuneAnchor(pool, index, results[index - 1]?.choice, seed * 1000 + index);
    results.push(result);
    const { strength, metrics } = result;
    lines.push(
      `| ${result.rating} | ${fixed(strength.knowledge, 2)} | ${fixed(strength.recallRate, 2)} | L${
        result.choice.reasoning
      } | ${strength.firstGuessMedianMs} | ${strength.thinkMedianMs} | ${percent(
        metrics.solveRate
      )} | ${fixed(metrics.medianAttempts, 1)} | ${seconds(metrics.medianTimeMs)} | ${toleranceMark(
        metrics,
        target
      )} |`
    );
  }
  lines.push("");
  lines.push(
    "写回 `CEE_RANKED_BOT_ANCHORS` 时只替换下面这些字段，维度、策略、锁定阈值、开局 K 与 `thinkSigma` 不动。"
  );
  lines.push("");
  lines.push(
    "搜索结果只作参考：知识面与推理等级能互相替代，多组取值都贴合 d1 目标，贪心搜索还会在第一档就把知识面抬高、锁死后面各档。写回前对照默认模式的 d3、d5 两档，优先选两者都随分数平稳上升的组合。"
  );
  lines.push("");
  lines.push("```ts");
  for (const [index, result] of results.entries()) {
    const target = TARGETS[index];
    const { strength, metrics } = result;
    lines.push(
      `// ${result.rating}：目标 ${percent(target.solveRate)} / ${fixed(
        target.medianAttempts,
        1
      )} 步 / ${seconds(target.medianTimeMs)}；实测 ${percent(metrics.solveRate)} / ${fixed(
        metrics.medianAttempts,
        1
      )} 步 / ${seconds(metrics.medianTimeMs)}`
    );
    lines.push(
      `knowledge: ${strength.knowledge}, recallRate: ${strength.recallRate}, mistakeRate: ${strength.mistakeRate},`
    );
    lines.push(
      `memory: ${strength.memory}, numericReliability: ${strength.numericReliability}, evidenceReliability: ${strength.evidenceReliability},`
    );
    lines.push(
      `firstGuessMedianMs: ${strength.firstGuessMedianMs}, thinkMedianMs: ${strength.thinkMedianMs},`
    );
  }
  lines.push("```");
  return lines;
};

const main = async (): Promise<void> => {
  const { dbPath, seed, tune } = parseArgs();
  const day = beijingDay(Date.now());
  const year = Number(day.slice(0, 4));
  const repository = new CEECharacterRepository({ dbPath, readonly: true });
  await repository.initialize();
  const pools: TierPool[] = [];
  for (const tier of CEE_RANKED_TIERS) pools.push(await buildTierPool(repository, tier.id, year));
  await repository.close();

  const header = [
    "# 排位人机标定",
    "",
    `- 数据集：\`${dbPath}\``,
    `- 种子：${seed}（用法：\`bun run scripts/CEERankedCalibrate.ts [dbPath] [--seed N] [--tune]\`）`,
    `- 北京日：${day}，题库年代按 ${year} 计算`,
  ];
  if (tune) {
    const d1 = tierPoolOf(pools, "d1");
    if (!d1) throw new Error("缺少 d1 档题库");
    console.log([...header, ...tuneSection(d1, seed)].join("\n"));
    return;
  }
  const random = createRandom(seed);
  console.log(
    [
      ...header,
      ...overviewSection(pools),
      ...curveSection(pools, random),
      ...matrixSection(pools, random),
      ...aigaSection(pools, random),
      ...aigaTimingSection(pools, random),
    ].join("\n")
  );
};

await main();
