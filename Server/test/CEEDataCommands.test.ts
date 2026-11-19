import { describe, expect, test } from "bun:test";
import type { CEEDataProvider } from "../src/infrastructure/CEEData";
import { runCEEDataCommand } from "../src/application/CEEDataCommands";

/** 夹具只返回占位数据：按无类型口径调用，断言只看形状与转发。 */
const run = runCEEDataCommand as (
  data: CEEDataProvider,
  type: string,
  payload: unknown
) => Promise<unknown>;

const recordingProvider = () => {
  const calls: unknown[][] = [];
  const record =
    (name: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return Promise.resolve(result);
    };
  const data = {
    searchCharacters: record("searchCharacters", [{ id: 1 }]),
    searchSubjects: record("searchSubjects", [{ id: 2 }]),
    getSubjectCharacters: record("getSubjectCharacters", [{ id: 3 }]),
    getSubjects: record("getSubjects", [{ id: 4 }]),
    importDirectory: record("importDirectory", { marker: 5 }),
    resolveCharacterImage: record("resolveCharacterImage", "char.png"),
    resolveSubjectImage: record("resolveSubjectImage", "subject.png"),
  } as unknown as CEEDataProvider;
  return { data, calls };
};

describe("数据类命令的公共实现", () => {
  test("每条命令取对应的数据方法并按原形状包装响应", async () => {
    const { data, calls } = recordingProvider();
    expect(await run(data, "cee.character.search", { keyword: "a" })).toEqual({
      results: [{ id: 1 }],
    });
    expect(await run(data, "cee.subject.search", { keyword: "b" })).toEqual({
      results: [{ id: 2 }],
    });
    expect(await run(data, "cee.subject.characters", { subjectId: 7 })).toEqual({
      results: [{ id: 3 }],
    });
    expect(await run(data, "cee.subject.lookup", { subjectIds: [1, 2] })).toEqual({
      results: [{ id: 4 }],
    });
    expect(await run(data, "cee.directory.import", { indexId: 9 })).toEqual({
      marker: 5,
    });
    expect(await run(data, "cee.subject.image", { subjectId: 8 })).toEqual({
      imageUrl: "subject.png",
    });
    expect(calls).toEqual([
      ["searchCharacters", "a"],
      ["searchSubjects", "b"],
      ["getSubjectCharacters", 7],
      ["getSubjects", [1, 2]],
      ["importDirectory", 9],
      ["resolveSubjectImage", 8],
    ]);
  });

  test("角色图缺省尺寸取方格图，显式尺寸原样传递", async () => {
    const { data, calls } = recordingProvider();
    await run(data, "cee.character.image", { characterId: 1 });
    await run(data, "cee.character.image", { characterId: 2, size: "large" });
    expect(calls).toEqual([
      ["resolveCharacterImage", 1, "grid"],
      ["resolveCharacterImage", 2, "large"],
    ]);
  });
});
