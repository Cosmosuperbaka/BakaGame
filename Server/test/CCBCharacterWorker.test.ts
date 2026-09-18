import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { CCBCharacterWorkerProvider } from "../src/infrastructure/CCBCharacterWorkerProvider";
import { createDefaultCCBSettings } from "../src/shared/CCB";
import { createCCBCharacterFixture } from "./CCBCharacterFixtures";

test("角色工作线程并发查询隔离对象且关闭后拒绝请求", async () => {
  const fixture = createCCBCharacterFixture();
  const provider = new CCBCharacterWorkerProvider(fixture);
  try {
    const settings = { ...createDefaultCCBSettings(), startYear: 2020, endYear: 2020, topNSubjects: 1 };
    const [characters, subjects, selected] = await Promise.all([
      provider.searchCharacters("牧濑"), provider.searchSubjects("游戏"), provider.chooseRandomCharacter(settings, () => 0),
    ]);
    expect(characters.map((row) => row.id)).toEqual([1]);
    expect(subjects.map((row) => row.id)).toEqual([11]);
    expect(selected.id).toBe(1);
    selected.characterTags.push("客户端修改");
    expect((await provider.getCharacter(1, settings)).characterTags).toEqual(["蓝发", "眼镜"]);
    expect((await provider.getRawCharacter(1)).aliases).toEqual(["助手", "Christina"]);
    expect((await provider.getSubjectCharacters(10)).map((row) => row.id)).toEqual([1,2]);
    expect(await provider.resolveCharacterImage(1)).toBeUndefined();
    await expect(provider.importDirectory(1)).rejects.toMatchObject({ code: "CCB_IMPORT_UNAVAILABLE" });
    await expect(provider.getCharacter(999, settings)).rejects.toMatchObject({ code: "CCB_CHARACTER_NOT_FOUND" });
  } finally {
    await provider.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
  await expect(provider.searchCharacters("牧濑")).rejects.toMatchObject({ code: "CCB_DATA_UNAVAILABLE" });
});

test("缺失数据文件的初始化失败以业务错误返回，不产生未处理拒绝", async () => {
  const provider = new CCBCharacterWorkerProvider({ characterPath: `missing-${crypto.randomUUID()}.sqlite` });
  await expect(provider.searchCharacters("角色")).rejects.toMatchObject({ code: "CCB_DATA_UNAVAILABLE" });
  await expect(provider.close()).rejects.toMatchObject({ code: "CCB_DATA_UNAVAILABLE" });
});
