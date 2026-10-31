import type { CEECharacterView, CEEFeedback, CEESettings } from "../shared/CEE";
import { AppError } from "./Errors";
import { buildCEEFeedback } from "./CEERules";

/** 题库里的一个候选答案：角色视图加上它被抽为答案的先验权重。 */
export interface CEERankedCandidate {
  character: CEECharacterView;
  /** 被抽为答案的先验权重（正数）。 */
  weight: number;
}

/** 人机可以拿来比对反馈的维度。 */
export type CEERankedDimension =
  | "gender"
  | "popularity"
  | "rating"
  | "appearancesCount"
  | "earliestAppearance"
  | "latestAppearance"
  | "sharedAppearances"
  | "tags"
  | "extraTags";

const COMPARISON_DIMENSIONS = [
  "gender",
  "popularity",
  "rating",
  "appearancesCount",
  "earliestAppearance",
  "latestAppearance",
] as const;
type ComparisonDimension = (typeof COMPARISON_DIMENSIONS)[number];
const COMPARISON_DIMENSION_SET: ReadonlySet<CEERankedDimension> = new Set(COMPARISON_DIMENSIONS);
const isComparisonDimension = (dim: CEERankedDimension): dim is ComparisonDimension =>
  COMPARISON_DIMENSION_SET.has(dim);

export const CEE_RANKED_ALL_DIMENSIONS: readonly CEERankedDimension[] = [
  ...COMPARISON_DIMENSIONS,
  "sharedAppearances",
  "tags",
  "extraTags",
];
/** 只含六个数值/性别维度。 */
export const CEE_RANKED_NUMERIC_DIMENSIONS: readonly CEERankedDimension[] = [
  ...COMPARISON_DIMENSIONS,
];

/** 一手猜测与实际收到的反馈；求解器靠它排除候选。 */
export interface CEERankedObservation {
  guess: CEECharacterView;
  feedback: CEEFeedback;
}

// 维度之间用 NUL 分隔：角色名与标签文本可能含逗号、冒号或竖线，维度前缀加 NUL 才能保证
// 一个维度的内容不会冒充另一个维度。
const DIMENSION_JOINER = "\u0000";
const ITEM_JOINER = ",";

const dimensionSignature = (feedback: CEEFeedback, dim: CEERankedDimension): string => {
  if (isComparisonDimension(dim)) return String(feedback[dim].comparison);
  if (dim === "sharedAppearances")
    return feedback.sharedAppearances
      .map((item) => item.id)
      .sort((a, b) => a - b)
      .join(ITEM_JOINER);
  if (dim === "tags")
    return feedback.tags
      .map((tag) => `${tag.kind}:${tag.text}:${tag.matched}`)
      .sort()
      .join(ITEM_JOINER);
  return feedback.extraTags
    .flatMap((section) =>
      section.tags.map((tag) => `${section.section}:${tag.text}:${tag.matched}`)
    )
    .sort()
    .join(ITEM_JOINER);
};

/** 把反馈按所选维度压成可比较的字符串。 */
export function ceeFeedbackSignature(
  feedback: CEEFeedback,
  dims: readonly CEERankedDimension[]
): string {
  return dims.map((dim) => `${dim}=${dimensionSignature(feedback, dim)}`).join(DIMENSION_JOINER);
}

/** 保留与全部观测一致的候选（只比较 dims 内的维度）。 */
export function filterCEECandidates(
  candidates: readonly CEERankedCandidate[],
  observations: readonly CEERankedObservation[],
  dims: readonly CEERankedDimension[],
  settings: CEESettings
): CEERankedCandidate[] {
  const expected = observations.map((observation) => ({
    guess: observation.guess,
    signature: ceeFeedbackSignature(observation.feedback, dims),
  }));
  return candidates.filter((candidate) =>
    expected.every(
      (observation) =>
        ceeFeedbackSignature(
          buildCEEFeedback(observation.guess, candidate.character, settings),
          dims
        ) === observation.signature
    )
  );
}

export interface CEERankedSplit {
  /** 按权重抽到答案时，猜完后期望还剩几个候选。 */
  expectedRemaining: number;
  /** 最大一组反馈里有几个候选（最坏情况）。 */
  worstClass: number;
  classes: number;
}

export function evaluateCEEGuess(
  guess: CEECharacterView,
  candidates: readonly CEERankedCandidate[],
  dims: readonly CEERankedDimension[],
  settings: CEESettings
): CEERankedSplit {
  const groups = new Map<string, { count: number; weight: number }>();
  for (const candidate of candidates) {
    const key = ceeFeedbackSignature(buildCEEFeedback(guess, candidate.character, settings), dims);
    const group = groups.get(key) ?? { count: 0, weight: 0 };
    group.count += 1;
    group.weight += candidate.weight;
    groups.set(key, group);
  }
  const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  if (totalWeight <= 0) return { expectedRemaining: 0, worstClass: 0, classes: groups.size };
  let expectedRemaining = 0;
  let worstClass = 0;
  for (const group of groups.values()) {
    expectedRemaining += (group.weight / totalWeight) * group.count;
    worstClass = Math.max(worstClass, group.count);
  }
  return { expectedRemaining, worstClass, classes: groups.size };
}

/** 每位候选作为首猜的评估，按 expectedRemaining 升序、worstClass 升序、id 升序。 */
export function rankCEEOpenings(
  candidates: readonly CEERankedCandidate[],
  settings: CEESettings
): Array<{ id: number; expectedRemaining: number; worstClass: number }> {
  return candidates
    .map((candidate) => {
      const split = evaluateCEEGuess(
        candidate.character,
        candidates,
        CEE_RANKED_ALL_DIMENSIONS,
        settings
      );
      return {
        id: candidate.character.id,
        expectedRemaining: split.expectedRemaining,
        worstClass: split.worstClass,
      };
    })
    .sort(
      (a, b) =>
        a.expectedRemaining - b.expectedRemaining || a.worstClass - b.worstClass || a.id - b.id
    );
}

/** 二分选法：只在 candidates 内选，按 worstClass 升序 → expectedRemaining 升序 → weight 降序 → id 升序取第一个。 */
export function chooseCEEBisectionGuess(
  candidates: readonly CEERankedCandidate[],
  settings: CEESettings,
  excluded: ReadonlySet<number>
): CEECharacterView {
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      split: evaluateCEEGuess(candidate.character, candidates, CEE_RANKED_ALL_DIMENSIONS, settings),
    }))
    .sort(
      (a, b) =>
        a.split.worstClass - b.split.worstClass ||
        a.split.expectedRemaining - b.split.expectedRemaining ||
        b.candidate.weight - a.candidate.weight ||
        a.candidate.character.id - b.candidate.character.id
    );
  const picked = ranked.find((entry) => !excluded.has(entry.candidate.character.id));
  if (!picked) throw new AppError("RANKED_NO_CANDIDATE", "题库里没有可以继续二分的选择");
  return picked.candidate.character;
}

/** 某候选与全部观测相比，在 dims 内有几个维度对不上（用于「一个都对不上」时退而求其次）。 */
export function countCEEViolations(
  candidate: CEECharacterView,
  observations: readonly CEERankedObservation[],
  dims: readonly CEERankedDimension[],
  settings: CEESettings
): number {
  return dims.filter((dim) =>
    observations.some(
      (observation) =>
        dimensionSignature(buildCEEFeedback(observation.guess, candidate, settings), dim) !==
        dimensionSignature(observation.feedback, dim)
    )
  ).length;
}
