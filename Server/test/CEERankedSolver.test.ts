import { describe, expect, it } from "bun:test";
import {
  CEE_RANKED_ALL_DIMENSIONS,
  CEE_RANKED_NUMERIC_DIMENSIONS,
  ceeFeedbackSignature,
  chooseCEEBisectionGuess,
  countCEEViolations,
  evaluateCEEGuess,
  filterCEECandidates,
  rankCEEOpenings,
  type CEERankedCandidate,
  type CEERankedDimension,
  type CEERankedObservation,
} from "../src/domain/CEERankedSolver";
import { buildCEEFeedback } from "../src/domain/CEERules";
import {
  createDefaultCEESettings,
  type CEEAppearance,
  type CEECharacterView,
  type CEEFeedback,
} from "../src/shared/CEE";

// ==================== 测试夹具 ====================
const appearance = (id: number, name: string, year: number, rating: number): CEEAppearance => ({
  id,
  name,
  nameCn: name,
  year,
  rating,
  ratingCount: 100,
});

/** 全字段缺省的角色视图，只覆盖测试关心的差异。 */
const view = (overrides: Partial<CEECharacterView> & { id: number }): CEECharacterView => ({
  name: `角色${overrides.id}`,
  nameCn: `角色${overrides.id}`,
  gender: "female",
  popularity: 100,
  summary: "",
  appearances: [appearance(1, "作品甲", 2020, 8)],
  highestRating: 8,
  earliestAppearance: 2020,
  latestAppearance: 2020,
  subjectTags: ["校园"],
  characterTags: ["黑发"],
  voiceActors: ["声优甲"],
  metaTags: ["校园"],
  comparisonAppearances: [{ id: 1, name: "作品甲", nameCn: "作品甲" }],
  extraTags: [{ section: "属性", tags: ["火"] }],
  ...overrides,
});

const candidate = (
  id: number,
  weight: number,
  overrides: Partial<CEECharacterView> = {}
): CEERankedCandidate => ({ character: view({ id, ...overrides }), weight });

/** 只差热度、其余维度完全相同的四个候选，用于手算分组。 */
const popularityPool: CEERankedCandidate[] = [
  candidate(21, 1, { popularity: 10 }),
  candidate(22, 1, { popularity: 20 }),
  candidate(23, 1, { popularity: 90 }),
  candidate(24, 1, { popularity: 400 }),
];

/** 热度与登场年份两维都不同的六个候选，用于推演过滤。 */
const yearPool: CEERankedCandidate[] = [
  candidate(1, 1, { popularity: 10, earliestAppearance: 2018, latestAppearance: 2018 }),
  candidate(2, 1, { popularity: 20, earliestAppearance: 2018, latestAppearance: 2018 }),
  candidate(3, 1, { popularity: 90, earliestAppearance: 2019, latestAppearance: 2019 }),
  candidate(4, 1, { popularity: 400, earliestAppearance: 2019, latestAppearance: 2019 }),
  candidate(5, 1, { popularity: 400, earliestAppearance: 2018, latestAppearance: 2018 }),
  candidate(6, 1, { popularity: 200, earliestAppearance: 2019, latestAppearance: 2019 }),
];

const settings = createDefaultCEESettings();
const observe = (
  guessId: number,
  answerId: number,
  pool: readonly CEERankedCandidate[]
): CEERankedObservation => {
  const guess = pool.find((item) => item.character.id === guessId);
  const answer = pool.find((item) => item.character.id === answerId);
  if (!guess || !answer) throw new Error("夹具缺少角色");
  return {
    guess: guess.character,
    feedback: buildCEEFeedback(guess.character, answer.character, settings),
  };
};
const idsOf = (candidates: readonly CEERankedCandidate[]) =>
  candidates.map((item) => item.character.id);
const signature = (feedback: CEEFeedback, dim: CEERankedDimension) =>
  ceeFeedbackSignature(feedback, [dim]);

// ==================== 用例 ====================
describe("CEE 排位反馈签名", () => {
  // 猜测热度 50、答案热度 400 且年份不同，保证每个维度都有可改的取值。
  const base: CEEFeedback = buildCEEFeedback(
    view({ id: 1, popularity: 50 }),
    view({ id: 2, popularity: 400, earliestAppearance: 2019, latestAppearance: 2019 }),
    settings
  );
  const variants: Array<[CEERankedDimension, CEEFeedback]> = [
    ["gender", { ...base, gender: { value: "male", comparison: "no" } }],
    ["popularity", { ...base, popularity: { value: 50, comparison: "=" } }],
    ["rating", { ...base, rating: { value: 8, comparison: "+" } }],
    ["appearancesCount", { ...base, appearancesCount: { value: 1, comparison: "+" } }],
    ["earliestAppearance", { ...base, earliestAppearance: { value: 2020, comparison: "=" } }],
    ["latestAppearance", { ...base, latestAppearance: { value: 2020, comparison: "-" } }],
    ["sharedAppearances", { ...base, sharedAppearances: [] }],
    ["tags", { ...base, tags: [{ text: "校园", matched: false, hidden: false, kind: "subject" }] }],
    [
      "extraTags",
      { ...base, extraTags: [{ section: "属性", tags: [{ text: "火", matched: false }] }] },
    ],
  ];

  it("维度常量覆盖表：数值六维与全维度", () => {
    expect(CEE_RANKED_NUMERIC_DIMENSIONS).toEqual([
      "gender",
      "popularity",
      "rating",
      "appearancesCount",
      "earliestAppearance",
      "latestAppearance",
    ]);
    expect(CEE_RANKED_ALL_DIMENSIONS).toEqual([
      ...CEE_RANKED_NUMERIC_DIMENSIONS,
      "sharedAppearances",
      "tags",
      "extraTags",
    ]);
  });

  it("相同反馈得到相同签名，改任一维度立刻不等、其余维度不受影响", () => {
    const full = ceeFeedbackSignature(base, CEE_RANKED_ALL_DIMENSIONS);
    expect(ceeFeedbackSignature(base, CEE_RANKED_ALL_DIMENSIONS)).toBe(full);
    for (const [dim, variant] of variants) {
      expect(ceeFeedbackSignature(variant, CEE_RANKED_ALL_DIMENSIONS)).not.toBe(full);
      const others = CEE_RANKED_ALL_DIMENSIONS.filter((item) => item !== dim);
      expect(ceeFeedbackSignature(variant, others)).toBe(ceeFeedbackSignature(base, others));
    }
  });

  it("数值与性别维度只看比较符号，猜测自身的值不参与", () => {
    const left: CEEFeedback = { ...base, popularity: { value: 50, comparison: "--" } };
    const right: CEEFeedback = { ...base, popularity: { value: 999999, comparison: "--" } };
    expect(signature(left, "popularity")).toBe(signature(right, "popularity"));
    expect(signature(left, "popularity")).toBe("popularity=--");
  });

  it("共同作品按 id 升序拼接，标签与额外标签排序后拼接", () => {
    const shared: CEEFeedback = {
      ...base,
      sharedAppearances: [
        { id: 9, name: "乙", nameCn: "乙" },
        { id: 3, name: "甲", nameCn: "甲" },
      ],
    };
    expect(signature(shared, "sharedAppearances")).toBe("sharedAppearances=3,9");
    const tags: CEEFeedback = {
      ...base,
      tags: [
        { text: "乙", matched: true, hidden: false, kind: "character" },
        { text: "甲", matched: false, hidden: false, kind: "subject" },
      ],
    };
    expect(signature(tags, "tags")).toBe("tags=character:乙:true,subject:甲:false");
    const extra: CEEFeedback = {
      ...base,
      extraTags: [
        { section: "武器", tags: [{ text: "剑", matched: false }] },
        { section: "武器", tags: [{ text: "弓", matched: true }] },
        { section: "属性", tags: [{ text: "火", matched: false }] },
      ],
    };
    expect(signature(extra, "extraTags")).toBe(
      "extraTags=属性:火:false,武器:剑:false,武器:弓:true"
    );
  });

  it("一个维度的内容冒充不了另一个维度", () => {
    const asShared: CEEFeedback = {
      ...base,
      sharedAppearances: [{ id: 12, name: "x", nameCn: "x" }],
      tags: [],
    };
    const asTag: CEEFeedback = {
      ...base,
      sharedAppearances: [],
      tags: [{ text: "12", matched: false, hidden: false, kind: "subject" }],
    };
    expect(signature(asShared, "sharedAppearances")).toBe("sharedAppearances=12");
    expect(signature(asTag, "tags")).toBe("tags=subject:12:false");
    const dims: CEERankedDimension[] = ["sharedAppearances", "tags"];
    expect(ceeFeedbackSignature(asShared, dims)).not.toBe(ceeFeedbackSignature(asTag, dims));
  });
});

describe("CEE 排位候选过滤与二分评估", () => {
  it("过滤保留与人工推演一致的候选，真实答案始终在内", () => {
    const first = observe(1, 3, yearPool);
    const second = observe(6, 3, yearPool);
    expect(
      idsOf(filterCEECandidates(yearPool, [first], CEE_RANKED_NUMERIC_DIMENSIONS, settings))
    ).toEqual([3, 4, 6]);
    const afterBoth = filterCEECandidates(
      yearPool,
      [first, second],
      CEE_RANKED_NUMERIC_DIMENSIONS,
      settings
    );
    expect(idsOf(afterBoth)).toEqual([3]);
    expect(afterBoth[0].character).toBe(yearPool[2].character);
  });

  it("全维度过滤能区分标签差异，不比对标签时两个候选都留下", () => {
    const tagged = [
      candidate(1, 1, { subjectTags: ["校园"] }),
      candidate(2, 1, { subjectTags: ["运动"] }),
    ];
    const observation = observe(1, 2, tagged);
    expect(
      idsOf(filterCEECandidates(tagged, [observation], CEE_RANKED_ALL_DIMENSIONS, settings))
    ).toEqual([2]);
    expect(
      idsOf(filterCEECandidates(tagged, [observation], CEE_RANKED_NUMERIC_DIMENSIONS, settings))
    ).toEqual([1, 2]);
  });

  it("evaluateCEEGuess 在手算例子上给出精确的期望剩余与最坏组", () => {
    const guess = view({ id: 99, popularity: 100 });
    expect(
      evaluateCEEGuess(guess, popularityPool, CEE_RANKED_NUMERIC_DIMENSIONS, settings)
    ).toEqual({ expectedRemaining: 1.5, worstClass: 2, classes: 3 });
    const weighted = evaluateCEEGuess(
      guess,
      [
        candidate(21, 2, { popularity: 10 }),
        candidate(22, 1, { popularity: 20 }),
        candidate(23, 1, { popularity: 90 }),
        candidate(24, 1, { popularity: 400 }),
      ],
      CEE_RANKED_NUMERIC_DIMENSIONS,
      settings
    );
    expect(weighted.expectedRemaining).toBeCloseTo(1.6, 12);
    expect(weighted.worstClass).toBe(2);
    expect(weighted.classes).toBe(3);
    expect(evaluateCEEGuess(guess, [], CEE_RANKED_ALL_DIMENSIONS, settings)).toEqual({
      expectedRemaining: 0,
      worstClass: 0,
      classes: 0,
    });
  });

  it("rankCEEOpenings 按期望剩余、最坏组、id 升序排列", () => {
    expect(rankCEEOpenings(popularityPool, settings)).toEqual([
      { id: 22, expectedRemaining: 1.5, worstClass: 2 },
      { id: 23, expectedRemaining: 1.5, worstClass: 2 },
      { id: 21, expectedRemaining: 2.5, worstClass: 3 },
      { id: 24, expectedRemaining: 2.5, worstClass: 3 },
    ]);
  });

  it("chooseCEEBisectionGuess 取最坏组最小的候选并按规则打破并列", () => {
    expect(chooseCEEBisectionGuess(popularityPool, settings, new Set()).id).toBe(22);
    expect(chooseCEEBisectionGuess(popularityPool, settings, new Set([22])).id).toBe(23);
    expect(chooseCEEBisectionGuess(popularityPool, settings, new Set([22, 23])).id).toBe(21);
    const twins = [candidate(31, 1), candidate(32, 7), candidate(33, 1)];
    expect(chooseCEEBisectionGuess(twins, settings, new Set()).id).toBe(32);
    const equalTwins = [candidate(41, 1), candidate(42, 1), candidate(43, 1)];
    expect(chooseCEEBisectionGuess(equalTwins, settings, new Set([41])).id).toBe(42);
    // 只在传入的候选里选，不会跳到集合外的角色。
    const subset = popularityPool.slice(2);
    expect(idsOf(subset)).toContain(chooseCEEBisectionGuess(subset, settings, new Set()).id);
  });

  it("候选全被排除时明确报错而不是返回重复猜测", () => {
    expect(() =>
      chooseCEEBisectionGuess(popularityPool, settings, new Set([21, 22, 23, 24]))
    ).toThrow("题库里没有可以继续二分的选择");
  });

  it("countCEEViolations 数出对不上的维度个数", () => {
    const observations = [observe(1, 3, yearPool), observe(6, 3, yearPool)];
    expect(
      countCEEViolations(yearPool[2].character, observations, CEE_RANKED_ALL_DIMENSIONS, settings)
    ).toBe(0);
    expect(
      countCEEViolations(yearPool[3].character, observations, CEE_RANKED_ALL_DIMENSIONS, settings)
    ).toBe(1);
    expect(
      countCEEViolations(
        yearPool[1].character,
        observations,
        CEE_RANKED_NUMERIC_DIMENSIONS,
        settings
      )
    ).toBe(2);
  });
});
