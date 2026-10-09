import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rm } from "node:fs/promises";
import { CCBCharacterRepository } from "../src/infrastructure/CCBCharacterRepository";
import { createDefaultCCBSettings } from "../src/shared/CCB";
import { createCCBCharacterFixture } from "./CCBCharacterFixtures";
import type { CCBDataOptions } from "../src/infrastructure/CCBData";
import { selectCCBExtraTags } from "../src/infrastructure/CCBCharacterDerivation";

const cleanup: Array<() => Promise<void>> = [];
const now = Date.UTC(2026, 0, 1);
const settings = () => ({ ...createDefaultCCBSettings(2026), startYear: 2010, endYear: 2026, topNSubjects: 1 });
function create(options: Partial<CCBDataOptions> = {}) {
  const fixture = createCCBCharacterFixture();
  const repository = new CCBCharacterRepository({ ...fixture, now: () => now, fetcher: async () => { throw new Error("普通查询不得访问上游"); }, ...options });
  cleanup.push(async () => { await repository.close(); await rm(fixture.directory, { recursive: true, force: true }); });
  return { ...fixture, repository };
}
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

describe("CCB 本地角色资料", () => {
  test("额外游戏作品保留独立判定关系和外部标签，不混入动画数量及标签池", async () => {
    const { repository, dbPath } = create();
    const fixture = new Database(dbPath);
    fixture.query("INSERT INTO subjects VALUES (?,4,?,?,?,0,?,?,9,500,500)").run(284157, "Genshin", "原神", "2020-09-28", '{}', '[]');
    fixture.query("INSERT INTO character_subject_relations VALUES (?,284157,1,0)").run(1);
    fixture.query("INSERT INTO character_extra_tags VALUES (1,284157,0,0,?,?)").run('属性', '风');
    fixture.query("INSERT INTO character_extra_tags VALUES (1,284157,1,0,?,?)").run('武器', '单手剑');
    fixture.close();
    const view = await repository.getCharacter(1, settings());
    expect(view.appearances.map(item => item.id)).toEqual([10]);
    expect(view.comparisonAppearances.map(item => item.id)).toEqual([10,284157]);
    expect(view.highestRating).toBe(8); expect(view.earliestAppearance).toBe(2020);
    expect(view.extraTags).toEqual([{ section: '属性', tags: ['风'] }, { section: '武器', tags: ['单手剑'] }]);
    expect(view.subjectTags).not.toContain('风');
    expect((await repository.getRawCharacter(1)).extraTagsBySubject[284157]).toEqual(view.extraTags);
    view.extraTags[0].tags.push('篡改');
    expect((await repository.getCharacter(1, settings())).extraTags[0].tags).toEqual(['风']);
    const game = await repository.getCharacter(1, { ...settings(), metaTags: ['游戏'] });
    expect(game.comparisonAppearances.filter(item => item.id === 284157)).toHaveLength(1);
  });

  test("外部标签按首个支持作品选取，不越过无标签作品也不泄漏原始引用", () => {
    const available = { 284157: [{ section: '属性', tags: ['风'] }] };
    expect(selectCCBExtraTags([{ id: 109378, name: '', nameCn: '' }, { id: 284157, name: '', nameCn: '' }], available)).toEqual([]);
    const chosen = selectCCBExtraTags([{ id: 284157, name: '', nameCn: '' }], available);
    chosen[0].tags.push('变化'); expect(available[284157][0].tags).toEqual(['风']);
  });

  test("短中文、短别名和长别名均可检索，通配符作为普通字符且结果有界", async () => {
    const { repository } = create();
    expect((await repository.searchCharacters("牧濑")).map((row) => row.id)).toEqual([1]);
    expect((await repository.searchCharacters("LL")).map((row) => row.id)).toEqual([2]);
    expect((await repository.searchCharacters("Christina")).map((row) => row.id)).toEqual([1]);
    expect((await repository.searchCharacters("%" )).map((row) => row.id)).toEqual([3]);
    expect((await repository.searchCharacters("_" )).map((row) => row.id)).toEqual([3]);
    expect(await repository.searchCharacters("\" OR \" ")).toEqual([]);
    expect(await repository.searchCharacters("", 1)).toHaveLength(1);
    expect((await repository.searchCharacters("3"))[0].nameCn).toBe("游戏主角");
  });

  test("搜索书籍、游戏和三次元口径不局限动画，按作品关联顺序取主配角", async () => {
    const { repository } = create();
    const subjects = await repository.searchSubjects("作品");
    expect(subjects.map((row) => row.type)).toContain(4);
    expect(subjects.map((row) => row.type)).toContain(1);
    expect(subjects.map((row) => row.id)).not.toContain(15);
    expect((await repository.searchSubjects("作品", 20, [4])).map((row) => row.id)).toEqual([11]);
    expect((await repository.getSubjectCharacters(10)).map((row) => row.id)).toEqual([1,2]);
    expect(await repository.getSubjectCharacters(15)).toEqual([]);
  });

  test("按编号取作品名保持输入顺序，跳过受限、缺失与重复编号", async () => {
    const { repository } = create();
    expect((await repository.getSubjects([11, 999, 10, 15, 11])).map((row) => row.id)).toEqual([11, 10]);
    expect(await repository.getSubjects([])).toEqual([]);
  });

  test("只读本地关系、角色标签和声优，剔除受限/未来/无年份作品再累积标签", async () => {
    const { repository } = create();
    const view = await repository.getCharacter(1, settings());
    expect(view.appearances.map((row) => row.id)).toEqual([10]);
    expect(view.subjectTags).toEqual(["校园", "漫画改", "青春"]);
    expect(view.characterTags).toEqual(["蓝发", "眼镜"]);
    expect(view.voiceActors).toEqual(["声優甲"]);
    expect(view.popularity).toBe(107);
    expect(view.highestRating).toBe(8);
    expect(view.earliestAppearance).toBe(2020);
    expect(view.subjectTags).not.toContain("未上映");
    await expect(repository.getCharacter(999, settings())).rejects.toMatchObject({ code: "CCB_CHARACTER_NOT_FOUND" });
  });

  test("房间类别改变会重新推导登场与标签，缺指定类别时回退全部已有关系", async () => {
    const { repository } = create();
    const game = await repository.getCharacter(1, { ...settings(), metaTags: ["游戏"] });
    expect(game.appearances.map((row) => row.id)).toEqual([11]);
    expect(game.subjectTags).toEqual(["冒险", "游戏改"]);
    const all = await repository.getCharacter(1, { ...settings(), metaTags: ["全部"] });
    expect(all.appearances.map((row) => row.id)).toEqual([11,10,12]);
    expect(all.earliestAppearance).toBe(2019);
    const music = await repository.getCharacter(4, { ...settings(), metaTags: ["书籍"] });
    expect(music.appearances.map((row) => row.id)).toEqual([13]);
    expect(music.subjectTags).toEqual(["音乐"]);
  });

  test("热度先选作品再按主配角规则选角色，额外作品和年榜独立生效", async () => {
    const { repository } = create();
    expect((await repository.chooseRandomCharacter(settings(), () => 0)).id).toBe(1);
    let values = [0, .99];
    expect((await repository.chooseRandomCharacter({ ...settings(), mainCharacterOnly: false, characterNum: 2 }, () => values.shift()!)).id).toBe(2);
    values = [.99, 0];
    expect((await repository.chooseRandomCharacter({ ...settings(), addedSubjects: [11] }, () => values.shift()!)).id).toBe(3);
    expect((await repository.chooseRandomCharacter({ ...settings(), metaTags: ["Galgame"] }, () => 0)).id).toBe(3);
    expect((await repository.chooseRandomCharacter({ ...settings(), startYear: 2020, endYear: 2020, useSubjectPerYear: true }, () => 0)).id).toBe(1);
    await expect(repository.chooseRandomCharacter({ ...settings(), startYear: 2199, endYear: 2199 }, () => 0)).rejects.toMatchObject({ code: "CCB_NO_SUBJECT" });
    await expect(repository.chooseRandomCharacter({ ...settings(), metaTags: ["不存在的筛选"] }, () => 0)).rejects.toMatchObject({ code: "CCB_NO_SUBJECT" });
  });

  test("目录只在显式导入时联网，完整分页落库后抽题且报告缺失作品", async () => {
    const requested: number[] = [];
    const { repository, dbPath, enrichmentPath } = create({ apiBase: "https://bgm.invalid", fetcher: async (input) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset")); requested.push(offset);
      return Response.json({ total: 3, data: offset === 0 ? [{ id: 11 }, { id: 999 }] : [{ id: 15 }] });
    } });
    const configuration = { ...settings(), useIndex: true, indexId: 8 };
    await expect(repository.chooseRandomCharacter(configuration)).rejects.toMatchObject({ code: "CCB_DIRECTORY_NOT_IMPORTED" });
    expect(await repository.importDirectory(8)).toEqual({ id: 8, subjectIds: [11], missingSubjectIds: [999,15], importedAt: now });
    expect(requested).toEqual([0,2]);
    expect((await repository.chooseRandomCharacter(configuration, () => 0)).id).toBe(3);
    const reopened = new CCBCharacterRepository({ dbPath, enrichmentPath, now: () => now });
    try { expect((await reopened.chooseRandomCharacter(configuration, () => 0)).id).toBe(3); }
    finally { await reopened.close(); }
  });

  test("头像请求合并并持久化白名单资料，旧快照不变、缺失字段不覆盖本地值", async () => {
    let calls = 0;
    const { repository, dbPath, enrichmentPath } = create({ apiBase: "https://bgm.invalid", imageBase: "https://images.invalid", fetcher: async () => {
      calls++;
      return Response.json({ name: "Updated", summary: "更新的简介", images: { large: "https://lain.bgm.tv/pic/crt/l/1.jpg?x=1#crop", grid: "https://lain.bgm.tv/pic/crt/g/1.jpg?x=1#crop" },
        infobox: [{ key: "别名", value: [{ k: "英文名", v: "NewAlias" }] }], stat: { collects: 500, comments: 2 } });
    } });
    const before = await repository.getCharacter(1, settings());
    const images = await Promise.all([repository.resolveCharacterImage(1), repository.resolveCharacterImage(1)]);
    expect(calls).toBe(1);
    expect(images).toEqual(["https://images.invalid/pic/crt/l/1.jpg?x=1#crop", "https://images.invalid/pic/crt/l/1.jpg?x=1#crop"]);
    // 一次回源写齐两档：随后按方格图再取，命中同一份缓存，不再打上游。
    expect(await repository.resolveCharacterImage(1, "grid")).toBe("https://images.invalid/pic/crt/g/1.jpg?x=1#crop");
    expect(calls).toBe(1);
    const after = await repository.getCharacter(1, settings());
    expect(before.name).toBe("Makise"); expect(before.imageUrl).toBeUndefined(); expect(before.popularity).toBe(107);
    expect(after.name).toBe("Updated"); expect(after.popularity).toBe(502); expect(after.gender).toBe("female"); expect(after.nameCn).toBe("牧濑红莉栖");
    expect((await repository.searchCharacters("NewAlias"))[0].id).toBe(1);
    const base = new Database(dbPath, { readonly: true });
    try { expect(base.query("SELECT name FROM characters WHERE id=1").get()).toEqual({ name: "Makise" }); } finally { base.close(); }
    const reopened = new CCBCharacterRepository({ dbPath, enrichmentPath, imageBase: "https://other.invalid" });
    try { expect(await reopened.resolveCharacterImage(1)).toBe("https://other.invalid/pic/crt/l/1.jpg?x=1#crop"); }
    finally { await reopened.close(); }
  });

  test("目录回源失败保留上一完整快照，不污染已有本地资料", async () => {
    let failing = false;
    const { repository } = create({ apiBase: "https://bgm.invalid", fetcher: async () => {
      if (failing) return new Response("失败", { status: 503 });
      return Response.json({ total: 1, data: [{ id: 11 }] });
    } });
    await repository.importDirectory(1); failing = true;
    await expect(repository.importDirectory(1)).rejects.toMatchObject({ code: "CCB_IMPORT_FAILED" });
    expect((await repository.chooseRandomCharacter({ ...settings(), useIndex: true, indexId: 1 }, () => 0)).id).toBe(3);
    expect((await repository.getCharacter(1, settings())).name).toBe("Makise");
  });
});


test("角色搜索每个候选只读一次补充资料，冷热排序保留改名精确命中", async () => {
  for (const size of [20, 50]) {
    const { repository, dbPath } = create();
    const fixture = new Database(dbPath);
    for (let index = 0; index < size; index++) {
      const id = 100 + index, name = `命中${index}`;
      fixture.query("INSERT INTO characters VALUES (?,1,?,?,'?','[]','',0,?)").run(id, name, name, index);
    }
    fixture.close();
    const enrichment = (repository as unknown as { enrichment: { db: Database; readCharacter: (id: number) => unknown; readImage: (id: number) => unknown } }).enrichment;
    enrichment.db.query("INSERT INTO ccb_character_enrichment VALUES (?,1,?,?)").run(100, JSON.stringify({ name: "命", nameCn: "命" }), now);
    let reads = 0;
    const character = enrichment.readCharacter.bind(enrichment), image = enrichment.readImage.bind(enrichment);
    enrichment.readCharacter = id => { reads++; return character(id); };
    enrichment.readImage = id => { reads++; return image(id); };
    for (let pass = 0; pass < 2; pass++) {
      reads = 0;
      const results = await repository.searchCharacters("命", size);
      expect(results).toHaveLength(size);
      expect(results[0].id).toBe(100);
      expect(reads).toBe(size * 2);
      expect(results[1].id).toBe(100 + size - 1);
    }
  }
});
