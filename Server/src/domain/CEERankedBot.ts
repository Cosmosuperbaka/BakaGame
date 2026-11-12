import type { CEECharacterView, CEEFeedback, CEESettings } from "../shared/CEE";
import {
  CEE_RANKED_AIGA_OPENING_ID,
  clamp,
  type CEERankedBotStrength,
  type CEERankedPersona,
  type CEERankedPersonaId,
} from "./CEERankedBotProfile";
import {
  CEE_RANKED_ALL_DIMENSIONS,
  CEE_RANKED_NUMERIC_DIMENSIONS,
  type CEERankedCandidate,
  type CEERankedDimension,
  type CEERankedObservation,
  chooseCEEBisectionGuess,
  countCEEViolations,
  evaluateCEEGuess,
  filterCEECandidates,
} from "./CEERankedSolver";
import type { CEERankedOpening } from "./CEERankedOpeningBook";
import { AppError } from "./Errors";

// 排位人机的大脑与决策：知识抽取、回忆、犯错、开局、策略与爱噶。强度表见 CEERankedBotProfile，
// 思考时长见 CEERankedBotTiming。

export interface CEERankedBotBrain {
  persona: CEERankedPersona;
  strength: CEERankedBotStrength;
  /** 爱噶的猜测间隔按对手分数决定。 */
  opponentRating: number;
  known: Set<number>;
  observations: CEERankedObservation[];
  guessed: Set<number>;
  step: number;
}

/** 证据类线索：共同作品与两种标签，人机按 evidenceReliability 决定用不用得上。 */
const EVIDENCE_DIMENSIONS: readonly CEERankedDimension[] = [
  "sharedAppearances",
  "tags",
  "extraTags",
];

/** 考据君总会用上证据类维度，爱噶固定用全维度。 */
const effectiveDims = (
  personaId: CEERankedPersonaId,
  dims: readonly CEERankedDimension[]
): readonly CEERankedDimension[] => {
  if (personaId === "aiga") return [...CEE_RANKED_ALL_DIMENSIONS];
  if (personaId !== "kaoju") return dims;
  return [...dims, ...EVIDENCE_DIMENSIONS.filter((dim) => !dims.includes(dim))];
};

/** 强度表里抽出的维度子集：只保留 `dims` 与本组的交集，保持 `dims` 的先后顺序。 */
const dimsOfGroup = (
  dims: readonly CEERankedDimension[],
  group: readonly CEERankedDimension[]
): CEERankedDimension[] => dims.filter((dim) => group.includes(dim));

const randomIndex = (length: number, random: () => number): number =>
  Math.min(length - 1, Math.floor(random() * length));

const weightedIndex = (weights: readonly number[], random: () => number): number => {
  const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (total <= 0) return randomIndex(weights.length, random);
  let roll = random() * total;
  for (let index = 0; index < weights.length; index += 1) {
    roll -= Math.max(0, weights[index]);
    if (roll < 0) return index;
  }
  return weights.length - 1;
};

const pickWeighted = (
  items: readonly CEERankedCandidate[],
  weightOf: (candidate: CEERankedCandidate) => number,
  random: () => number
): CEERankedCandidate => items[weightedIndex(items.map(weightOf), random)];

const pickTied = <T>(items: readonly T[], random: () => number): T =>
  items[randomIndex(items.length, random)];

const pickHeaviest = (
  items: readonly CEERankedCandidate[],
  random: () => number
): CEERankedCandidate => {
  const best = items.reduce((max, item) => Math.max(max, item.weight), Number.NEGATIVE_INFINITY);
  return pickTied(
    items.filter((item) => item.weight === best),
    random
  );
};

/** 热度权重：指数越大越偏爱热门，热度 0 也要有权重所以基数取 1。 */
const heatWeight = (character: CEECharacterView, persona: CEERankedPersona): number =>
  Math.pow(character.popularity + 1, persona.popularityBias);

const takeRandom = (
  items: readonly CEERankedCandidate[],
  count: number,
  random: () => number
): CEERankedCandidate[] => {
  const rest = [...items];
  const taken: CEERankedCandidate[] = [];
  while (taken.length < count && rest.length)
    taken.push(rest.splice(randomIndex(rest.length, random), 1)[0]);
  return taken;
};

/** 按 knowledge × 题库大小（至少 1 个）以热度为权重无放回抽取认识的角色。 */
const drawKnown = (
  knowledge: number,
  pool: readonly CEERankedCandidate[],
  random: () => number
): Set<number> => {
  const target = Math.min(pool.length, Math.max(1, Math.round(knowledge * pool.length)));
  const rest = [...pool];
  const known = new Set<number>();
  while (known.size < target && rest.length) {
    const picked = pickWeighted(rest, (item) => item.character.popularity + 1, random);
    known.add(picked.character.id);
    rest.splice(rest.indexOf(picked), 1);
  }
  return known;
};

export function createCEERankedBot(input: {
  persona: CEERankedPersona;
  strength: CEERankedBotStrength;
  opponentRating: number;
  pool: readonly CEERankedCandidate[];
  random: () => number;
}): CEERankedBotBrain {
  const dims = effectiveDims(input.persona.id, input.strength.dims);
  // 爱噶的推理固定：记忆与可靠度不看强度表，否则她的步数会随强度档抖动。
  const strength: CEERankedBotStrength =
    input.persona.id === "aiga"
      ? {
          ...input.strength,
          dims,
          memory: Number.POSITIVE_INFINITY,
          numericReliability: 1,
          evidenceReliability: 1,
        }
      : { ...input.strength, dims };
  const known =
    input.persona.id === "aiga"
      ? new Set(input.pool.map((item) => item.character.id))
      : drawKnown(strength.knowledge, input.pool, input.random);
  return {
    persona: input.persona,
    strength,
    opponentRating: input.opponentRating,
    known,
    observations: [],
    guessed: new Set(),
    step: 0,
  };
}

export function recordCEERankedBotFeedback(
  brain: CEERankedBotBrain,
  guess: CEECharacterView,
  feedback: CEEFeedback
): void {
  brain.observations.push({ guess, feedback });
  brain.guessed.add(guess.id);
  brain.step += 1;
}

/** 该人格此刻还能猜的题库候选：没猜过，且要么认识、要么是爱噶（整个题库都认识）。 */
export const ceeRankedBotEligible = (
  brain: CEERankedBotBrain,
  pool: readonly CEERankedCandidate[]
): CEERankedCandidate[] =>
  pool.filter(
    (item) =>
      !brain.guessed.has(item.character.id) &&
      (brain.persona.id === "aiga" || brain.known.has(item.character.id))
  );

/** 同一步抽到的一份「记忆」：最近 memory 条观测，以及每条观测各自用得上哪些维度。 */
interface CEERankedRecall {
  observations: readonly CEERankedObservation[];
  dimsPerObservation: readonly (readonly CEERankedDimension[])[];
}

/**
 * 回忆这一步：只取最后 memory 条反馈，每条按两个可靠度各抽一次，决定数值组与证据组线索
 * 是否用上。同一步只抽一次，让回忆、犯错、下注与策略都基于同一份结果。
 */
const drawRecall = (brain: CEERankedBotBrain, random: () => number): CEERankedRecall => {
  const { memory, numericReliability, evidenceReliability, dims } = brain.strength;
  const observations = brain.observations.slice(
    Math.max(0, brain.observations.length - Math.trunc(memory))
  );
  const dimsPerObservation = observations.map(() => {
    const numeric =
      random() < numericReliability ? dimsOfGroup(dims, CEE_RANKED_NUMERIC_DIMENSIONS) : [];
    const evidence = random() < evidenceReliability ? dimsOfGroup(dims, EVIDENCE_DIMENSIONS) : [];
    return [...numeric, ...evidence];
  });
  return { observations, dimsPerObservation };
};

const consistentFor = (
  brain: CEERankedBotBrain,
  candidates: readonly CEERankedCandidate[],
  recall: CEERankedRecall,
  settings: CEESettings
): CEERankedCandidate[] =>
  filterCEECandidates(
    candidates,
    recall.observations,
    brain.strength.dims,
    settings,
    recall.dimsPerObservation
  );

/** 一致候选为空时按概率「想起」一个一致但原本不认识的角色。 */
const recallConsistent = (
  brain: CEERankedBotBrain,
  eligible: readonly CEERankedCandidate[],
  pool: readonly CEERankedCandidate[],
  recall: CEERankedRecall,
  settings: CEESettings,
  random: () => number
): CEERankedCandidate[] => {
  if (random() >= brain.strength.recallRate) return [];
  const strangers = pool.filter(
    (item) => !brain.known.has(item.character.id) && !brain.guessed.has(item.character.id)
  );
  const remembered = consistentFor(brain, strangers, recall, settings);
  if (!remembered.length) return [];
  const recalled = pickWeighted(remembered, (item) => item.character.popularity + 1, random);
  brain.known.add(recalled.character.id);
  return consistentFor(brain, [...eligible, recalled], recall, settings);
};

const fewestViolations = (
  brain: CEERankedBotBrain,
  candidates: readonly CEERankedCandidate[],
  settings: CEESettings
): CEERankedCandidate[] => {
  let best = Number.POSITIVE_INFINITY;
  const tied: CEERankedCandidate[] = [];
  for (const candidate of candidates) {
    const count = countCEEViolations(
      candidate.character,
      brain.observations,
      brain.strength.dims,
      settings
    );
    if (count < best) {
      best = count;
      tied.length = 0;
      tied.push(candidate);
    } else if (count === best) tied.push(candidate);
  }
  return tied;
};

const slipGuess = (
  brain: CEERankedBotBrain,
  eligible: readonly CEERankedCandidate[],
  consistent: readonly CEERankedCandidate[],
  random: () => number
): number | null => {
  const chance = clamp(brain.strength.mistakeRate * brain.persona.mistakeFactor, 0, 1);
  if (chance <= 0 || random() >= chance) return null;
  const consistentIds = new Set(consistent.map((item) => item.character.id));
  const slips = eligible.filter((item) => !consistentIds.has(item.character.id));
  return slips.length ? pickTied(slips, random).character.id : null;
};

/** 开局热度权重：与 `heatWeight` 同口径，热度 0 也要有权重所以基数取 1。 */
const openingWeight = (opening: CEERankedOpening, persona: CEERankedPersona): number =>
  Math.pow(opening.popularity + 1, persona.popularityBias);

const openingGuess = (
  brain: CEERankedBotBrain,
  eligible: readonly CEERankedCandidate[],
  openings: ReadonlyArray<CEERankedOpening>,
  random: () => number
): number => {
  const fresh = openings.filter((entry) => !brain.guessed.has(entry.id));
  const { openingTopK } = brain.strength;
  // 开局谱角色不要求在本场题库里，也不要求她「被认识」：猜她照样有反馈。
  const options =
    brain.persona.openingStyle === "ranked" && openingTopK > 0
      ? fresh.slice(0, openingTopK)
      : fresh.filter((entry) => entry.famous);
  if (options.length) {
    const weights = options.map((entry) => openingWeight(entry, brain.persona));
    return options[weightedIndex(weights, random)].id;
  }
  return pickWeighted(eligible, (item) => heatWeight(item.character, brain.persona), random)
    .character.id;
};

/** sampled 的评估名额：一致集里取一半，其余名额给已知但未猜过的角色。 */
const sampledCandidates = (
  brain: CEERankedBotBrain,
  eligible: readonly CEERankedCandidate[],
  consistent: readonly CEERankedCandidate[],
  random: () => number
): CEERankedCandidate[] => {
  const quota = Math.max(1, brain.strength.sampleSize);
  const consistentIds = new Set(consistent.map((item) => item.character.id));
  const fromConsistent = takeRandom(consistent, Math.max(1, Math.floor(quota / 2)), random);
  const others = eligible.filter((item) => !consistentIds.has(item.character.id));
  return [...fromConsistent, ...takeRandom(others, quota - fromConsistent.length, random)];
};

const scoredGuess = (
  brain: CEERankedBotBrain,
  guesses: readonly CEERankedCandidate[],
  consistent: readonly CEERankedCandidate[],
  settings: CEESettings,
  random: () => number
): number => {
  const consistentIds = new Set(consistent.map((item) => item.character.id));
  const ranked = guesses
    .map((item) => ({
      item,
      split: evaluateCEEGuess(item.character, consistent, brain.strength.dims, settings),
    }))
    .sort(
      (a, b) =>
        a.split.expectedRemaining - b.split.expectedRemaining ||
        Number(consistentIds.has(b.item.character.id)) -
          Number(consistentIds.has(a.item.character.id)) ||
        b.item.weight - a.item.weight ||
        a.item.character.id - b.item.character.id
    );
  if (brain.strength.noise > 0 && ranked.length > 1 && random() < brain.strength.noise) {
    const top = ranked.slice(0, 3);
    return top[randomIndex(top.length, random)].item.character.id;
  }
  return ranked[0].item.character.id;
};

const strategyGuess = (
  brain: CEERankedBotBrain,
  eligible: readonly CEERankedCandidate[],
  consistent: readonly CEERankedCandidate[],
  settings: CEESettings,
  random: () => number
): number => {
  const { strategy } = brain.strength;
  if (strategy === "random")
    return pickWeighted(eligible, (item) => heatWeight(item.character, brain.persona), random)
      .character.id;
  if (strategy === "consistent")
    return pickWeighted(
      consistent,
      (item) => item.weight * heatWeight(item.character, brain.persona),
      random
    ).character.id;
  const guesses =
    strategy === "optimal" ? eligible : sampledCandidates(brain, eligible, consistent, random);
  return scoredGuess(brain, guesses, consistent, settings, random);
};

const aigaGuess = (
  brain: CEERankedBotBrain,
  pool: readonly CEERankedCandidate[],
  settings: CEESettings
): number => {
  if (brain.step === 0) return CEE_RANKED_AIGA_OPENING_ID;
  const pending = ceeRankedBotEligible(brain, pool);
  const consistent = filterCEECandidates(
    pending,
    brain.observations,
    CEE_RANKED_ALL_DIMENSIONS,
    settings
  );
  if (consistent.length) return chooseCEEBisectionGuess(consistent, settings, brain.guessed).id;
  if (!pending.length) throw new AppError("RANKED_NO_CANDIDATE", "人机已没有可猜的已知角色");
  const tied = fewestViolations(brain, pending, settings);
  return Math.min(...tied.map((item) => item.character.id));
};

const regularGuess = (
  brain: CEERankedBotBrain,
  pool: readonly CEERankedCandidate[],
  openings: ReadonlyArray<CEERankedOpening>,
  settings: CEESettings,
  random: () => number
): number => {
  const eligible = ceeRankedBotEligible(brain, pool);
  if (!eligible.length) throw new AppError("RANKED_NO_CANDIDATE", "人机已没有可猜的已知角色");
  if (brain.step === 0) return openingGuess(brain, eligible, openings, random);
  const recall = drawRecall(brain, random);
  let consistent = consistentFor(brain, eligible, recall, settings);
  if (!consistent.length) {
    consistent = recallConsistent(brain, eligible, pool, recall, settings, random);
    if (!consistent.length)
      return pickTied(fewestViolations(brain, eligible, settings), random).character.id;
  }
  const slipped = slipGuess(brain, eligible, consistent, random);
  if (slipped !== null) return slipped;
  const lockLimit = Math.max(1, brain.strength.lockThreshold + brain.persona.lockOffset);
  if (consistent.length <= lockLimit) return pickHeaviest(consistent, random).character.id;
  return strategyGuess(brain, eligible, consistent, settings, random);
};

export function nextCEERankedBotGuess(
  brain: CEERankedBotBrain,
  pool: readonly CEERankedCandidate[],
  openings: ReadonlyArray<CEERankedOpening>,
  settings: CEESettings,
  random: () => number
): number {
  // 爱噶的出手是固定规则，不消耗 random；random 只用于她的思考时长。
  if (brain.persona.id === "aiga") return aigaGuess(brain, pool, settings);
  return regularGuess(brain, pool, openings, settings, random);
}
