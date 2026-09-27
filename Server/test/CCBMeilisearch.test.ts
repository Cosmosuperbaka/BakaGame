import { describe, expect, test } from "bun:test";
import type { Meilisearch } from "meilisearch";
import {
  CCB_CHARACTER_RANKING_RULES,
  CCB_SUBJECT_RANKING_RULES,
  CCBMeilisearch,
} from "../src/infrastructure/CCBMeilisearch";

function createClient() {
  const requests: Array<{ index: string; query: string | undefined; options: unknown }> = [];
  const indexes = new Map<string, { uid: string; search: (query?: string | null, options?: unknown) => Promise<unknown> }>();
  const client = {
    index(uid: string) {
      const index = {
        uid,
        search: async (query?: string | null, options?: unknown) => {
          requests.push({ index: uid, query: query ?? undefined, options });
          return { hits: [{ id: uid === "ccb_characters" ? 2 : 11 }], estimatedTotalHits: 1 };
        },
      };
      indexes.set(uid, index);
      return index;
    },
  } as unknown as Meilisearch;
  return { client, requests, indexes };
}

describe("CCB Meilisearch 搜索契约", () => {
  test("角色搜索保留 Meilisearch 命中顺序并使用 Bangumi 排序过滤口径", async () => {
    const { client, requests } = createClient();
    const search = new CCBMeilisearch({ url: "http://search.invalid", client });

    expect((await search.searchCharacters("牧濑", 20)).ids).toEqual([2]);
    expect(requests[0]).toEqual({ index: "ccb_characters", query: "牧濑", options: { limit: 20, filter: ["nsfw = false"] } });
    expect(CCB_CHARACTER_RANKING_RULES).toEqual([
      "exactness", "words", "typo", "proximity", "attribute", "sort", "id:asc", "comment:desc", "collect:desc", "nsfw:asc",
    ]);
  });

  test("作品搜索按类型 OR、NSFW AND 组成过滤表达式", async () => {
    const { client, requests } = createClient();
    const search = new CCBMeilisearch({ url: "http://search.invalid", client });

    expect((await search.searchSubjects("作品", 20, [1, 2, 4, 6])).ids).toEqual([11]);
    expect(requests[0]).toEqual({
      index: "ccb_subjects", query: "作品",
      options: { limit: 20, filter: [["type = 1", "type = 2", "type = 4", "type = 6"], "nsfw = false"] },
    });
    expect(CCB_SUBJECT_RANKING_RULES).toEqual([
      "exactness", "words", "typo", "proximity", "attribute", "sort", "id:asc", "rank:asc", "score:desc", "nsfw:asc",
    ]);
  });
});
