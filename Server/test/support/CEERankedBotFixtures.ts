import {
  CEE_RANKED_PERSONAS,
  ceeRankedBotStrength,
  type CEERankedBotStrength,
  type CEERankedPersona,
  type CEERankedPersonaId,
} from "../../src/domain/CEERankedBotProfile";
import {
  ceeRankedBotEligible,
  nextCEERankedBotGuess,
  recordCEERankedBotFeedback,
  type CEERankedBotBrain,
} from "../../src/domain/CEERankedBot";
import {
  type CEERankedCandidate,
  type CEERankedObservation,
  rankCEEOpenings,
} from "../../src/domain/CEERankedSolver";
import { type CEERankedOpening } from "../../src/domain/CEERankedOpeningBook";
import { buildCEEFeedback } from "../../src/domain/CEERules";
import {
  createDefaultCEESettings,
  type CEEAppearance,
  type CEECharacterView,
  type CEEExtraTagSection,
} from "../../src/shared/CEE";
import { scripted } from "./Random";

const appearance = (id: number, year: number, rating: number): CEEAppearance => ({
  id,
  name: `作品${id}`,
  nameCn: `作品${id}`,
  year,
  rating,
  ratingCount: 100,
});

export const view = (overrides: Partial<CEECharacterView> & { id: number }): CEECharacterView => ({
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

interface Spec {
  id: number;
  weight: number;
  gender: "male" | "female";
  popularity: number;
  works: number[][];
  subject: string[];
  character: string[];
  voice: string[];
  extra: CEEExtraTagSection[];
}

const SPECS: Spec[] = [
  {
    id: 101,
    weight: 2,
    gender: "female",
    popularity: 300,
    works: [
      [1, 2021, 9],
      [2, 2022, 7],
    ],
    subject: ["校园", "奇幻"],
    character: ["黑发"],
    voice: ["声优甲"],
    extra: [{ section: "属性", tags: ["火"] }],
  },
  {
    id: 102,
    weight: 1,
    gender: "male",
    popularity: 120,
    works: [[3, 2019, 8]],
    subject: ["运动"],
    character: ["短发"],
    voice: ["声优乙"],
    extra: [{ section: "武器", tags: ["剑"] }],
  },
  {
    id: 103,
    weight: 1.5,
    gender: "female",
    popularity: 400,
    works: [
      [1, 2021, 9],
      [4, 2023, 6],
    ],
    subject: ["校园"],
    character: ["长发"],
    voice: ["声优丙"],
    extra: [{ section: "属性", tags: ["水"] }],
  },
  {
    id: 104,
    weight: 1,
    gender: "male",
    popularity: 60,
    works: [[5, 2016, 7]],
    subject: ["科幻"],
    character: ["眼镜"],
    voice: ["声优甲"],
    extra: [{ section: "武器", tags: ["枪"] }],
  },
  {
    id: 105,
    weight: 1,
    gender: "female",
    popularity: 220,
    works: [
      [2, 2022, 7],
      [6, 2020, 8],
    ],
    subject: ["奇幻"],
    character: ["双马尾"],
    voice: ["声优丁"],
    extra: [{ section: "属性", tags: ["风"] }],
  },
  {
    id: 106,
    weight: 3,
    gender: "male",
    popularity: 350,
    works: [[4, 2023, 6]],
    subject: ["悬疑"],
    character: ["面具"],
    voice: ["声优戊"],
    extra: [{ section: "武器", tags: ["刀"] }],
  },
  {
    id: 107,
    weight: 1,
    gender: "female",
    popularity: 90,
    works: [
      [5, 2016, 7],
      [3, 2019, 8],
    ],
    subject: ["科幻", "日常"],
    character: ["呆毛"],
    voice: ["声优乙"],
    extra: [{ section: "属性", tags: ["光"] }],
  },
  {
    id: 108,
    weight: 1,
    gender: "male",
    popularity: 480,
    works: [
      [6, 2020, 8],
      [1, 2021, 9],
    ],
    subject: ["日常"],
    character: ["老成"],
    voice: ["声优丙"],
    extra: [{ section: "武器", tags: ["拳套"] }],
  },
  {
    id: 109,
    weight: 1,
    gender: "female",
    popularity: 150,
    works: [[7, 2015, 6]],
    subject: ["音乐"],
    character: ["耳机"],
    voice: ["声优己"],
    extra: [{ section: "属性", tags: ["暗"] }],
  },
  {
    id: 110,
    weight: 1,
    gender: "male",
    popularity: 260,
    works: [
      [7, 2015, 6],
      [2, 2022, 7],
    ],
    subject: ["音乐", "奇幻"],
    character: ["金发"],
    voice: ["声优丁"],
    extra: [{ section: "武器", tags: ["吉他"] }],
  },
];

export const settings = createDefaultCEESettings();
export const pool: CEERankedCandidate[] = SPECS.map((spec) => {
  const appearances = spec.works.map(([id, year, rating]) => appearance(id, year, rating));
  return {
    weight: spec.weight,
    character: view({
      id: spec.id,
      gender: spec.gender,
      popularity: spec.popularity,
      appearances,
      highestRating: Math.max(...appearances.map((item) => item.rating)),
      earliestAppearance: Math.min(...appearances.map((item) => item.year)),
      latestAppearance: Math.max(...appearances.map((item) => item.year)),
      subjectTags: spec.subject,
      characterTags: spec.character,
      voiceActors: spec.voice,
      comparisonAppearances: appearances.map((item) => ({
        id: item.id,
        name: item.name,
        nameCn: item.nameCn,
      })),
      extraTags: spec.extra,
    }),
  };
});
export const poolIds = pool.map((item) => item.character.id);
export const idsOf = (candidates: readonly CEERankedCandidate[]): number[] =>
  candidates.map((item) => item.character.id);
export const viewOf = (id: number): CEECharacterView => {
  const found = pool.find((item) => item.character.id === id);
  if (!found) throw new Error(`夹具缺少角色 ${id}`);
  return found.character;
};
/**
 * 夹具开局谱：按本场题库评估整档候选，`solver` / `famous` 由用例点亮。
 *
 * 默认全 false —— 需要开局谱的用例自己指定，避免「没点亮也能被抽到」这种假通过。
 */
const openingBook = (options: { solver?: number[]; famous?: number[] } = {}): CEERankedOpening[] =>
  rankCEEOpenings(pool, settings).map((entry) => ({
    ...entry,
    solver: options.solver?.includes(entry.id) ?? false,
    famous: options.famous?.includes(entry.id) ?? false,
    popularity: viewOf(entry.id).popularity,
  }));
export const openings = openingBook();
/** 构造一段开局列表：expectedRemaining 按给出顺序递增，方便断言「前 K 个」。 */
export const scriptedOpenings = (
  ids: number[],
  flags: { solver?: boolean; famous?: boolean; popularity?: number } = {}
): CEERankedOpening[] =>
  ids.map((id, index) => ({
    id,
    expectedRemaining: index + 1,
    worstClass: 1,
    solver: flags.solver ?? true,
    famous: flags.famous ?? true,
    popularity: flags.popularity ?? 100,
  }));
export const personaOf = (id: CEERankedPersonaId): CEERankedPersona => {
  const found = CEE_RANKED_PERSONAS.find((persona) => persona.id === id);
  if (!found) throw new Error(`缺少人格 ${id}`);
  return found;
};
export const anchorStrength = (rating: number): CEERankedBotStrength =>
  ceeRankedBotStrength(rating, scripted([0.5]));
export const unguessed = (brain: CEERankedBotBrain): CEERankedCandidate[] =>
  pool.filter((item) => !brain.guessed.has(item.character.id));
export const observe = (guessId: number, answerId: number): CEERankedObservation => {
  const guess = viewOf(guessId);
  const answer = viewOf(answerId);
  return { guess, feedback: buildCEEFeedback(guess, answer, settings) };
};

/** 让大脑打一局并返回猜测序列；题库外的首猜（爱噶）只计次数。 */
export const playGuesses = (
  brain: CEERankedBotBrain,
  answerId: number,
  random: () => number,
  extras: ReadonlyMap<number, CEECharacterView> = new Map()
): number[] => {
  const answer = viewOf(answerId);
  const guesses: number[] = [];
  while (guesses.length <= poolIds.length + 2 && ceeRankedBotEligible(brain, pool).length > 0) {
    const id = nextCEERankedBotGuess(brain, pool, openings, settings, random);
    guesses.push(id);
    const character = extras.get(id) ?? (poolIds.includes(id) ? viewOf(id) : undefined);
    if (character)
      recordCEERankedBotFeedback(brain, character, buildCEEFeedback(character, answer, settings));
    else {
      brain.guessed.add(id);
      brain.step += 1;
    }
    if (id === answerId) break;
  }
  return guesses;
};
