import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createCCBCharacterFixture() {
  const directory = mkdtempSync(join(tmpdir(), "bakagame-ccb-data-"));
  // 单库：猜歌与 CCB 共用同一个数据集文件（见 tools/build_bangumi_db.py）。
  const dbPath = join(directory, "bangumi.sqlite");
  const enrichmentPath = join(directory, "enrichment.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE characters(id INTEGER PRIMARY KEY,role INTEGER,name TEXT,name_cn TEXT,gender TEXT,aliases TEXT,summary TEXT,comments INTEGER,collects INTEGER);
    CREATE TABLE subjects(id INTEGER PRIMARY KEY,type INTEGER,name TEXT,name_cn TEXT,date TEXT,nsfw INTEGER,raw_tags TEXT,meta_tags TEXT,score REAL,rating_count INTEGER,heat INTEGER);
    CREATE TABLE character_subject_relations(character_id INTEGER,subject_id INTEGER,relation_type INTEGER,relation_order INTEGER,PRIMARY KEY(character_id,subject_id));
    CREATE INDEX csr_character ON character_subject_relations(character_id,relation_order);
    CREATE INDEX csr_subject ON character_subject_relations(subject_id,relation_order);
    CREATE TABLE character_tags(character_id INTEGER,position INTEGER,tag TEXT,PRIMARY KEY(character_id,tag));
    CREATE TABLE character_vas(character_id INTEGER,position INTEGER,person_id INTEGER,name TEXT,name_cn TEXT,PRIMARY KEY(character_id,person_id));
    CREATE TABLE character_extra_tags(character_id INTEGER,subject_id INTEGER,section_position INTEGER,tag_position INTEGER,section TEXT,tag TEXT,PRIMARY KEY(character_id,subject_id,section_position,tag_position));
    CREATE VIRTUAL TABLE character_search USING fts5(name,name_cn,aliases,content='characters',content_rowid='id',tokenize='trigram');`);
  const characters = [
    [1, "Makise", "牧濑红莉栖", "female", ["助手", "Christina"], 7, 100],
    [2, "Lelouch", "鲁路修", "male", ["LL", "Zero"], 3, 200],
    [3, "Game hero", "游戏主角", "male", ["百分%号", "下划_线"], 5, 50],
    [4, "Music hero", "音乐角色", "?", [], 0, 10],
    [5, "Quiet hero", "安静角色", "?", [], 0, 5],
  ] as const;
  for (const [id, name, nameCn, gender, aliases, comments, collects] of characters) {
    db.query("INSERT INTO characters VALUES (?,1,?,?,?,?,?,?,?)").run(id, name, nameCn, gender, JSON.stringify(aliases), `${nameCn}简介`, comments, collects);
    db.query("INSERT INTO character_search(rowid,name,name_cn,aliases) VALUES (?,?,?,?)").run(id, name, nameCn, JSON.stringify(aliases));
  }
  const subjects = [
    [10, 2, "动画作品", "2020-01-01", 0, { 校园: 10, 青春: 1, 漫画改: 3, "2020": 100 }, ["校园", "日本"], 8, 100, 1000],
    [11, 4, "游戏作品", "2021-01-01", 0, { 冒险: 8, GAL改: 2 }, ["Galgame"], 9, 200, 900],
    [12, 1, "书籍作品", "2019-01-01", 0, { 奇幻: 20 }, ["奇幻"], 7, 50, 800],
    [13, 3, "音乐作品", "2010-01-01", 0, { 音乐: 10 }, ["音乐"], 6, 5, 10],
    [14, 2, "未来作品", "2199-01-01", 0, { 未上映: 1000 }, ["未上映"], 10, 999, 9999],
    [15, 2, "受限作品", "2020-01-01", 1, { 受限: 1000 }, ["受限"], 10, 1000, 99999],
    [16, 2, "无年作品", "", 0, { 无年: 1000 }, ["无年"], 10, 1000, 1],
    [17, 2, "空角色作品", "2022-01-01", 0, {}, [], 5, 0, 2],
    [18, 2, "冷门作品", "2020-01-01", 0, { 安静: 1 }, [], 5, 1, 5],
  ] as const;
  for (const [id, type, name, date, nsfw, tags, metas, score, ratingCount, heat] of subjects) {
    db.query("INSERT INTO subjects VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, type, name, name, date, nsfw, JSON.stringify(tags), JSON.stringify(metas), score, ratingCount, heat);
  }
  for (const [characterId, subjectId, relation, order] of [[1,10,1,0],[1,11,2,1],[1,12,1,0],[1,14,1,0],[1,15,1,0],[1,16,1,0],[2,10,2,1],[3,11,1,0],[4,13,1,0],[5,18,1,0]]) {
    db.query("INSERT INTO character_subject_relations VALUES (?,?,?,?)").run(characterId, subjectId, relation, order);
  }
  db.exec("INSERT INTO character_tags VALUES (1,0,'蓝发'),(1,1,'眼镜'); INSERT INTO character_vas VALUES (1,0,100,'声優甲','声优甲')");
  db.close();
  return { directory, dbPath, enrichmentPath };
}
