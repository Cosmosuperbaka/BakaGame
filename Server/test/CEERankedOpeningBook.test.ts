import { describe, expect, it } from "bun:test";
import { CEE_RANKED_AIGA_OPENING_ID } from "../src/domain/CEERankedBot";
import {
  assembleCEERankedOpenings,
  CEE_RANKED_OPENING_BOOK,
  CEE_RANKED_OPENING_POPULARITY_MIN,
} from "../src/domain/CEERankedOpeningBook";
import type { CEERankedCandidate } from "../src/domain/CEERankedSolver";
import { createDefaultCEESettings, type CEECharacterView } from "../src/shared/CEE";

const settings = createDefaultCEESettings();

const view = (overrides: Partial<CEECharacterView> & { id: number }): CEECharacterView => ({
  name: `角色${overrides.id}`,
  nameCn: `角色${overrides.id}`,
  gender: "female",
  popularity: 100,
  summary: "",
  appearances: [{ id: 1, name: "作品1", nameCn: "作品1", year: 2020, rating: 8, ratingCount: 100 }],
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

const candidate = (id: number, popularity: number): CEERankedCandidate => ({
  weight: 1,
  character: view({ id, popularity }),
});

/** 题库里只有开局谱中的这两位；其余开局谱角色走 viewOf。 */
const pool: CEERankedCandidate[] = [candidate(8, 500), candidate(362, 400)];

/** 数据集里有的开局谱角色：48 冷门（低于下限）、4704 正常、丰川祥子在题库外。 */
const DATASET = new Map<number, CEECharacterView>([
  [48, view({ id: 48, popularity: CEE_RANKED_OPENING_POPULARITY_MIN - 1 })],
  [2162, view({ id: 2162, popularity: 900 })],
  [
    CEE_RANKED_AIGA_OPENING_ID,
    view({ id: CEE_RANKED_AIGA_OPENING_ID, name: "丰川祥子", popularity: 700 }),
  ],
]);

/** 记录取过哪些编号，并断言题库内的开局不会重复去向仓储要视图。 */
const assemble = (requested: number[]) =>
  assembleCEERankedOpenings({
    candidates: pool,
    settings,
    viewOf: async (id) => {
      requested.push(id);
      expect(pool.some((item) => item.character.id === id)).toBe(false);
      return DATASET.get(id);
    },
    extraIds: [CEE_RANKED_AIGA_OPENING_ID],
  });

describe("CEE 排位开局谱数据", () => {
  it("编号唯一且升序，每个条目至少一个标记为真", () => {
    const ids = CEE_RANKED_OPENING_BOOK.map((entry) => entry.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CEE_RANKED_OPENING_BOOK.every((entry) => entry.solver || entry.famous)).toBe(true);
    expect(CEE_RANKED_OPENING_BOOK.every((entry) => entry.name.length > 0)).toBe(true);
  });

  it("丰川祥子在 famous 名单里，爱噶的固定首猜不受热度下限约束", () => {
    const aiga = CEE_RANKED_OPENING_BOOK.find((entry) => entry.id === CEE_RANKED_AIGA_OPENING_ID);
    expect(aiga).toMatchObject({ famous: true, name: "丰川祥子" });
  });
});

describe("CEE 排位开局谱装配", () => {
  it("题库内复用候选视图、题库外取视图，冷门开局不进 openings", async () => {
    const requested: number[] = [];
    const { openings, extras } = await assemble(requested);
    expect(openings.map((entry) => entry.id)).toEqual([8, 362, 2162, CEE_RANKED_AIGA_OPENING_ID]);
    // 48 在数据集里但热度不达标：不进开局列表，视图仍留给 extras。
    expect(openings.some((entry) => entry.id === 48)).toBe(false);
    expect(extras.map((item) => item.id)).toEqual([48, 2162, CEE_RANKED_AIGA_OPENING_ID]);
    // 题库内的开局不向仓储重复要视图。
    expect(requested).not.toContain(8);
    expect(requested).not.toContain(362);
    expect(new Set(requested).size).toBe(requested.length);
  });

  it("openings 带上开局谱标记与自身热度，按切分效果升序", async () => {
    const { openings } = await assemble([]);
    expect(openings.map((entry) => entry.solver)).toEqual([true, true, false, false]);
    expect(openings.map((entry) => entry.famous)).toEqual([true, false, true, true]);
    const byFlag = openings.filter((entry) => entry.id === 8)[0];
    expect(byFlag).toMatchObject({ popularity: 500, solver: true, famous: true });
    const values = openings.map((entry) => entry.expectedRemaining);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    // 并列时按最坏组、再按编号打破，保证同一份题库装配结果稳定。
    for (const [index, entry] of openings.entries()) {
      if (index === 0) continue;
      const previous = openings[index - 1];
      expect(
        previous.expectedRemaining < entry.expectedRemaining ||
          (previous.expectedRemaining === entry.expectedRemaining &&
            (previous.worstClass < entry.worstClass ||
              (previous.worstClass === entry.worstClass && previous.id < entry.id)))
      ).toBe(true);
    }
  });

  it("数据集里没有的开局谱角色直接跳过，extraIds 为空时不影响 extras", async () => {
    const requested: number[] = [];
    const input = {
      candidates: pool,
      settings,
      viewOf: async (id: number) => {
        requested.push(id);
        return DATASET.get(id);
      },
    };
    const { extras } = await assembleCEERankedOpenings(input);
    // 开局谱里绝大多数编号在夹具数据集里取不到视图，装配不得报错。
    expect(requested.length).toBe(CEE_RANKED_OPENING_BOOK.length - 2);
    // 丰川祥子本来就在开局谱里，不靠 extraIds 也会被取到。
    expect(extras.map((item) => item.id)).toEqual([48, 2162, CEE_RANKED_AIGA_OPENING_ID]);
  });

  it("题库为空时期望剩余按空集合评估，装配仍然给出全部可达开局", async () => {
    const { openings, extras } = await assembleCEERankedOpenings({
      candidates: [],
      settings,
      viewOf: async (id) => DATASET.get(id) ?? (id === 8 || id === 362 ? view({ id }) : undefined),
      extraIds: [CEE_RANKED_AIGA_OPENING_ID, CEE_RANKED_AIGA_OPENING_ID],
    });
    // 没有候选时评估恒为 0，排序退化成编号升序；热度不达标的 48 依旧不进列表。
    expect(openings.map((entry) => entry.id)).toEqual([8, 362, 2162, CEE_RANKED_AIGA_OPENING_ID]);
    expect(openings.every((entry) => entry.expectedRemaining === 0)).toBe(true);
    expect(extras.map((item) => item.id)).toEqual([8, 48, 362, 2162, CEE_RANKED_AIGA_OPENING_ID]);
  });
});
