import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CCBCharacterRepository } from "../src/infrastructure/CCBCharacterRepository";
import { DEFAULT_CCB_SETTINGS, type CCBGameSettings } from "../src/shared/Index";

/** 固定「今天」：2026-09-17 本地时间，用于未上映判定。 */
const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();

const settings = (patch: Partial<CCBGameSettings> = {}): CCBGameSettings => ({
  ...DEFAULT_CCB_SETTINGS,
  ...patch,
  metaTags: patch.metaTags ?? DEFAULT_CCB_SETTINGS.metaTags,
  useHints: patch.useHints ?? DEFAULT_CCB_SETTINGS.useHints,
});

let directory = "";
let repository: CCBCharacterRepository;
let characterId = 0;
let randomValue = 0;

const createFixture = (path: string): void => {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE characters (
      id INTEGER PRIMARY KEY, role INTEGER NOT NULL, name TEXT NOT NULL,
      name_cn TEXT NOT NULL, gender TEXT NOT NULL, aliases TEXT NOT NULL,
      summary TEXT NOT NULL, comments INTEGER NOT NULL, collects INTEGER NOT NULL
    );
    CREATE TABLE subjects (
      id INTEGER PRIMARY KEY, type INTEGER NOT NULL, name TEXT NOT NULL,
      name_cn TEXT NOT NULL, date TEXT NOT NULL, nsfw INTEGER NOT NULL,
      raw_tags TEXT NOT NULL, meta_tags TEXT NOT NULL, score REAL NOT NULL,
      rating_count INTEGER NOT NULL, heat INTEGER NOT NULL
    );
    CREATE TABLE character_subject_relations (
      character_id INTEGER NOT NULL, subject_id INTEGER NOT NULL,
      relation_type INTEGER NOT NULL, relation_order INTEGER NOT NULL,
      PRIMARY KEY(character_id, subject_id)
    );
    CREATE TABLE character_tags (
      character_id INTEGER NOT NULL, position INTEGER NOT NULL, tag TEXT NOT NULL,
      PRIMARY KEY(character_id, tag)
    );
    CREATE TABLE character_vas (
      character_id INTEGER NOT NULL, position INTEGER NOT NULL,
      person_id INTEGER NOT NULL, name TEXT NOT NULL, name_cn TEXT NOT NULL,
      PRIMARY KEY(character_id, person_id)
    );
    CREATE VIRTUAL TABLE character_search USING fts5(
      name, name_cn, aliases, content='characters', content_rowid='id', tokenize='trigram'
    );
  `);

  const character = db.query(
    "INSERT INTO characters VALUES (?,?,?,?,?,?,?,?,?)",
  );
  character.run(1, 1, "アルファ", "阿尔法", "male", '["Alpha"]', "主角。", 20, 100);
  character.run(2, 1, "ベータ", "", "女", "[]", "", 0, 50);
  character.run(3, 1, "ガンマ", "伽马", "", "[]", "", 0, 10);
  character.run(4, 1, "デルタ", "德尔塔", "female", "[]", "", 0, 5);
  character.run(5, 1, "イプシロン", "伊普西龙", "male", "[]", "", 0, 1);

  const subject = db.query("INSERT INTO subjects VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  // 1000：2010 年动画，热度最高
  subject.run(1000, 2, "アルファ作品", "阿尔法作品", "2010-04-01", 0, '{"科幻":100,"TV":50,"2010":5}', '["科幻","TV","日本","原创"]', 8.0, 1000, 500);
  // 1001：2011 年游戏
  subject.run(1001, 4, "ベータ作品", "贝塔作品", "2011-06-01", 0, '{"ADV":80,"2011":3}', '["ADV","游戏改"]', 7.0, 500, 900);
  // 1002：2012 年动画
  subject.run(1002, 2, "ガンマ作品", "伽马作品", "2012-01-01", 0, "{}", '["奇幻"]', 9.0, 10, 100);
  // 1003：2013 年音乐（type=3），只在「大类过滤为空」的回退分支里才会被算进来
  subject.run(1003, 3, "主題歌", "主题歌", "2013-01-01", 0, '{"OP":30}', "[]", 6.0, 5, 10);
  // 1004：没有发布日期 → 原版 `details.year === null`，整条丢弃
  subject.run(1004, 2, "日付なし", "无日期", "", 0, '{"治愈":20}', '["治愈"]', 5.0, 20, 50);
  // 1005：未上映
  subject.run(1005, 2, "未来作", "未来作", "2999-01-01", 0, "{}", "[]", 5.0, 1, 20);

  const relation = db.query("INSERT INTO character_subject_relations VALUES (?,?,?,?)");
  relation.run(1, 1000, 1, 0);
  relation.run(1, 1001, 1, 1);
  relation.run(1, 1002, 2, 0);
  relation.run(1, 1003, 1, 0);
  relation.run(1, 1004, 1, 0);
  relation.run(1, 1005, 1, 0);
  relation.run(2, 1000, 2, 0);
  // 角色 4 只有一条「无年份」的关联 → 有关联但登场作品为空，highestRating 必须是 -1 而不是 0
  relation.run(4, 1004, 1, 0);
  // 角色 5：配角、order 3，用于验证 characterNum 截断
  relation.run(5, 1000, 2, 3);

  const tag = db.query("INSERT INTO character_tags VALUES (?,?,?)");
  tag.run(1, 0, "紫瞳");
  tag.run(1, 1, "腹黑");

  const va = db.query("INSERT INTO character_vas VALUES (?,?,?,?,?)");
  va.run(1, 0, 10, "声優A", "声优甲");
  va.run(1, 1, 11, "声優B", "声优乙");

  db.exec("INSERT INTO character_search(character_search) VALUES('rebuild')");
  db.close();
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ccb-repo-"));
  const path = join(directory, "bangumi-character.sqlite");
  createFixture(path);
  randomValue = 0;
  repository = new CCBCharacterRepository({
    characterDbPath: path,
    now: () => NOW,
    random: () => randomValue,
  });
});

afterEach(() => {
  repository.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("CCBCharacterRepository 出题两级采样", () => {
  test("第一级：年份区间 + 大类 + 热度降序", () => {
    const options = settings({ metaTags: [""], startYear: 2010, endYear: 2012, topNSubjects: 10 });
    // 候选只有 1000(2010) 与 1002(2012)：1004 无日期、1005 未上映都被区间挡掉
    randomValue = 0;
    expect(repository.pickRandomSubject(options)?.id).toBe(1000);
    randomValue = 0.999;
    expect(repository.pickRandomSubject(options)?.id).toBe(1002);
  });

  test("第一级：meta 过滤项按原版口径传参（不剔除「动画」）", () => {
    // 原版 `baseMetaTags` 只剔除 游戏/书籍/三次元/全部，所以「动画」会被当成 meta 标签过滤项，
    // 而没有作品的 meta_tags 里含「动画」→ 选不到作品。这是原版行为，不是 bug。
    expect(
      repository.pickRandomSubject(settings({ metaTags: ["动画"], startYear: 2010, endYear: 2012 })),
    ).toBeUndefined();
    // 加上真实存在的 meta 标签就能选到
    expect(
      repository.pickRandomSubject(settings({ metaTags: ["游戏", "ADV"], startYear: 2011, endYear: 2011 }))
        ?.id,
    ).toBe(1001);
  });

  test("第一级：按年份均分抽样只取该年", () => {
    const options = settings({
      metaTags: [""],
      startYear: 2010,
      endYear: 2012,
      useSubjectPerYear: true,
      topNSubjects: 10,
    });
    randomValue = 0; // 年份 = 2010
    expect(repository.pickRandomSubject(options)?.id).toBe(1000);
  });

  test("第二级：主角+配角按 relation_order 取前 characterNum 个", () => {
    // 1000 的角色：1(主角,order0)、2(配角,order0)、5(配角,order3)
    // 默认 `mainCharacterOnly: true` 只取主角，这里显式关掉才能看到配角。
    const both = settings({ characterNum: 10, mainCharacterOnly: false });
    randomValue = 0;
    expect(repository.pickRandomCharacter(1000, both)).toBe(1);
    randomValue = 0.999;
    expect(repository.pickRandomCharacter(1000, both)).toBe(5);
    // 截到 2 个 → 角色 5 出局
    randomValue = 0.999;
    expect(repository.pickRandomCharacter(1000, settings({ characterNum: 2, mainCharacterOnly: false }))).toBe(2);
  });

  test("第二级：mainCharacterOnly 只取主角", () => {
    randomValue = 0.999;
    expect(repository.pickRandomCharacter(1000, settings({ mainCharacterOnly: true }))).toBe(1);
    // 没有主角的作品选不出角色
    expect(repository.pickRandomCharacter(1002, settings({ mainCharacterOnly: true }))).toBeUndefined();
  });
});

describe("CCBCharacterRepository 反馈视图", () => {
  test("基础字段：gender 归一、popularity、登场作品按 rating_count 降序", () => {
    const view = repository.buildCharacterView(1, settings({ metaTags: [""] }))!;
    expect({ gender: view.gender, popularity: view.popularity }).toEqual({ gender: "male", popularity: 120 });
    // 1000(rating_count 1000) 在 1002(10) 之前；1004 无日期、1005 未上映、1001/1003 不是动画
    expect(view.appearanceIds).toEqual([1000, 1002]);
    expect(view.appearances).toEqual(["アルファ作品", "ガンマ作品"]);
    expect(view.appearancesCn).toEqual(["阿尔法作品", "伽马作品"]);
    expect({ latest: view.latestAppearance, earliest: view.earliestAppearance, highest: view.highestRating }).toEqual(
      { latest: 2012, earliest: 2010, highest: 9 },
    );
  });

  test("大类过滤后为空时回退到全部类型（含音乐）", () => {
    // 书籍(1) 没有任何作品 → 回退全部类型，于是 1000/1001/1002/1003 全进
    const view = repository.buildCharacterView(1, settings({ metaTags: ["书籍"] }))!;
    expect(view.appearanceIds).toEqual([1000, 1001, 1002, 1003]);
    expect(view.latestAppearance).toBe(2013);
  });

  test("有声优但无有效登场作品：highestRating 是 -1；完全无关联才是 0", () => {
    expect(repository.buildCharacterView(4, settings())!.highestRating).toBe(-1);
    expect(repository.buildCharacterView(4, settings())!.latestAppearance).toBe(-1);
    const noRelation = repository.buildCharacterView(3, settings())!;
    expect(noRelation.highestRating).toBe(0);
    expect(noRelation.appearances).toEqual([]);
    expect(noRelation.gender).toBe("?");
  });

  test("角色标签与声优保序", () => {
    const view = repository.buildCharacterView(1, settings())!;
    expect(view.characterTags).toEqual(["紫瞳", "腹黑"]);
    expect(view.animeVAs).toEqual(["声優A", "声優B"]);
  });

  test("默认模式的标签池：来源标签只取最高权重、meta 标签补足到 subjectTagNum、角色标签与地区标签追加", () => {
    const view = repository.buildCharacterView(1, settings({ metaTags: [""], commonTags: false, subjectTagNum: 3 }))!;
    // 作品 1000：「原创」是来源标签被跳过、「日本」进地区集合，其余进 meta 权重；
    // 作品 1002 的「奇幻」权重 1。
    // 没有来源标签计数 → 池首不是来源标签；meta 权重 科幻3 = TV3 > 奇幻1（同权重保持出现顺序）。
    // 补满 3 个后普通标签循环立即 break。
    expect(view.metaTags).toEqual(["科幻", "TV", "奇幻", "紫瞳", "腹黑", "日本"]);
    expect(view.rawTags).toEqual([]);
  });

  test("commonTags 模式的候选池：只用 raw_tags、剔含 20 的名字、无低权重项时退化成 subjectTagNum 个", () => {
    const view = repository.buildCharacterView(1, settings({ metaTags: [""], commonTags: true }))!;
    // 作品 1000 的 raw_tags：科幻 100*3、TV 50*3，「2010」被剔除；作品 1002 没有 raw_tags。
    // 没有任何条目低于 10% 阈值 → findIndex 返回 -1 → slice(0, max(-1, 3)) = 前 3 个（这里只有 2 个）。
    expect(view.rawTags).toEqual([
      ["科幻", 300],
      ["TV", 150],
    ]);
    expect(view.metaTags).toEqual([]);
  });

  test("配角权重是主角的 1/3", () => {
    // 角色 2 只有 1000 的配角关联：科幻 100*1 = 100
    const view = repository.buildCharacterView(2, settings({ metaTags: [""], commonTags: true }))!;
    expect(view.rawTags).toEqual([["科幻", 100], ["TV", 50]]);
  });

  test("未知角色返回 undefined", () => {
    expect(repository.buildCharacterView(9999, settings())).toBeUndefined();
  });
});

describe("CCBCharacterRepository 角色检索", () => {
  test("三字及以上走 FTS5 trigram", () => {
    const hits = repository.searchCharacters("伊普西龙");
    expect(hits.map((hit) => hit.id)).toContain(5);
    expect(hits[0]).toMatchObject({ id: 5, name: "イプシロン", nameCn: "伊普西龙", popularity: 1 });
  });

  test("短于三字必须回退 LIKE（trigram 对短查询必然 0 命中）", () => {
    expect(repository.searchCharacters("伊普").map((hit) => hit.id)).toContain(5);
    expect(repository.searchCharacters("阿尔").map((hit) => hit.id)).toContain(1);
    // 中文名缺失时回落到原名
    expect(repository.searchCharacters("ベータ")[0]).toMatchObject({ id: 2, nameCn: "ベータ" });
  });

  test("空查询返回空数组", () => {
    expect(repository.searchCharacters("   ")).toEqual([]);
  });
});
