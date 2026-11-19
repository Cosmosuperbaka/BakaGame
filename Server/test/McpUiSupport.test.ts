import { describe, expect, test } from "bun:test";
import { idMatcher } from "../src/mcp/ui/GameUi";
import {
  ackResults,
  inputPrefixOf,
  loadSearch,
  requireSearch,
  searchResultAt,
  teamFeedback,
  teamOf,
  createUiState,
  type UiContext,
  type UiSearchState,
} from "../src/mcp/ui/Support";

const search = (patch: Partial<UiSearchState> = {}): UiSearchState => ({
  prefix: "cee.guess.search",
  purpose: "cee_guess",
  kind: "character",
  keyword: "x",
  status: "ready",
  results: [{ id: 1 }, { id: 2 }],
  ...patch,
});

const contextWith = (current?: UiSearchState): UiContext => {
  const state = createUiState();
  state.search = current;
  return { state } as unknown as UiContext;
};

describe("公共搜索态", () => {
  test("前缀对不上时按调用方给的说明拒绝，不替各玩法统一文案", () => {
    expect(() => requireSearch(contextWith(), "cee.guess.search", "换了")).toThrow("换了");
    expect(() =>
      requireSearch(
        contextWith(search({ prefix: "cee.answer.search" })),
        "cee.guess.search",
        "别处"
      )
    ).toThrow("别处");
    expect(requireSearch(contextWith(search()), "cee.guess.search", "x").results).toHaveLength(2);
  });

  test("要求非空时检索中或结果为空都拒绝", () => {
    const options = { nonEmpty: true };
    for (const current of [search({ status: "loading" }), search({ results: [] })])
      expect(() => requireSearch(contextWith(current), "cee.guess.search", "x", options)).toThrow(
        "当前没有可选结果"
      );
    expect(
      requireSearch(contextWith(search()), "cee.guess.search", "x", options).results
    ).toHaveLength(2);
  });

  test("结果序号越界或不是数字时报不存在", () => {
    expect(searchResultAt(search(), "1")).toEqual({ id: 2 });
    for (const index of ["2", "-1", "abc", ""])
      expect(() => searchResultAt(search(), index)).toThrow(`结果 ${index} 不存在`);
  });

  test("检索成功写结果，失败先记状态再抛出；应答不是对象时按空表", async () => {
    const ok = search({ status: "loading", results: [] });
    await loadSearch(ok, async () => ({ results: [{ id: 9 }, "跳过"] }));
    expect(ok).toMatchObject({ status: "ready", results: [{ id: 9 }] });

    const empty = search({ status: "loading" });
    await loadSearch(empty, async () => null);
    expect(empty).toMatchObject({ status: "ready", results: [] });

    const failed = search({ status: "loading" });
    await expect(
      loadSearch(failed, async () => {
        throw new Error("上游挂了");
      })
    ).rejects.toThrow("上游挂了");
    expect(failed).toMatchObject({ status: "error", error: "上游挂了" });
    expect(ackResults({ results: "x" })).toEqual([]);
  });

  test("输入框 id 取前缀，非输入框返回空串", () => {
    expect(inputPrefixOf("song.guess.search.input")).toBe("song.guess.search");
    expect(inputPrefixOf("song.guess.search.back")).toBe("");
  });
});

describe("公共小件", () => {
  test("队伍取值只收 1–8 与不组队", () => {
    expect(teamOf("none")).toBeNull();
    expect(teamOf("3")).toBe(3);
    expect(teamOf(8)).toBe(8);
    for (const bad of ["0", "9", "x", undefined]) expect(() => teamOf(bad)).toThrow("队伍必须是");
    expect(teamFeedback("none")).toBe("已退出队伍");
    expect(teamFeedback("2")).toBe("已加入 2 队");
  });

  test("控件匹配器同时认精确 id 与前缀", () => {
    const matches = idMatcher(["a.start"], ["a.pick."]);
    expect([
      matches("a.start"),
      matches("a.pick.7"),
      matches("a.pick"),
      matches("b.start"),
    ]).toEqual([true, true, false, false]);
  });
});
