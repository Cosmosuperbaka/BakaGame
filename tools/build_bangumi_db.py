#!/usr/bin/env python3
"""Build the two read-only Bangumi databases from an Archive dump."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sqlite3
import tempfile
import urllib.request
from pathlib import Path

# CCB 角色标签的权威来源：CCB-TagsCI 每周一 04:00（北京时间）把合并了用户反馈的
# id_tags.js 推到这个路径。**不要**在仓库里存快照——它每周都会变，存下来必然过期。
DEFAULT_TAGS_URL = "https://raw.githubusercontent.com/Cosmosuperbaka/CCB-TagsCI/master/outputs/id_tags.js"

# 角色 infobox 里「中文名」与「性别」的候选键。归档 dump 的 infobox 是 wiki 模板原文，
# 键形如 ``|简体中文名= 鲁路修·兰佩路基``；角色表本身**没有** name_cn / gender 列，
# 只能从 infobox 里取。
INFOBOX_NAME_KEYS = ("中文名", "简体中文名", "繁體中文名", "繁体中文名", "姓名", "名称", "名字", "本名")
INFOBOX_GENDER_KEYS = ("性别", "性別", "gender")
INFOBOX_ALIAS_KEYS = ("别名", "別名")
# Bangumi 的性别只有 male / female 两种取值，其余一律归一到 '?'，
# 与 CCB 的反馈判定（非 male/female 即 '?'）保持同一口径。
GENDER_MAP = {
    "男": "male", "男性": "male", "male": "male", "m": "male", "1": "male",
    "女": "female", "女性": "female", "female": "female", "f": "female", "2": "female",
}
UNKNOWN_GENDER = "?"


def lines(path: Path):
    with path.open("r", encoding="utf-8") as stream:
        for raw in stream:
            raw = raw.strip()
            if raw:
                yield json.loads(raw)


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def setup_song(db: sqlite3.Connection):
    db.executescript("""
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=OFF;
      CREATE TABLE subjects (
        id INTEGER PRIMARY KEY, type INTEGER NOT NULL, name TEXT NOT NULL,
        name_cn TEXT NOT NULL, infobox TEXT NOT NULL, summary TEXT NOT NULL,
        date TEXT NOT NULL, nsfw INTEGER NOT NULL, tags TEXT NOT NULL,
        meta_tags TEXT NOT NULL, score REAL NOT NULL, rank INTEGER NOT NULL,
        heat INTEGER NOT NULL, image TEXT NOT NULL
      );
      CREATE TABLE music_subjects (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_cn TEXT NOT NULL,
        score REAL NOT NULL, rank INTEGER NOT NULL
      );
      CREATE TABLE subject_music_relations (
        subject_id INTEGER NOT NULL, music_id INTEGER NOT NULL,
        relation_type INTEGER NOT NULL, relation_order INTEGER NOT NULL,
        title TEXT NOT NULL, artist TEXT, kind TEXT NOT NULL,
        PRIMARY KEY(subject_id, music_id)
      );
      CREATE INDEX subjects_type_date ON subjects(type, date);
      CREATE INDEX subjects_heat ON subjects(heat DESC);
      CREATE INDEX relations_subject_order ON subject_music_relations(subject_id, relation_order);
      CREATE INDEX relations_kind ON subject_music_relations(subject_id, kind);
      CREATE VIRTUAL TABLE subject_search USING fts5(name, name_cn, content='subjects', content_rowid='id', tokenize='trigram');
      CREATE VIRTUAL TABLE music_search USING fts5(name, name_cn, content='music_subjects', content_rowid='id', tokenize='trigram');
    """)


def setup_character(db: sqlite3.Connection):
    db.executescript("""
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=OFF;
      CREATE TABLE characters (
        id INTEGER PRIMARY KEY, role INTEGER NOT NULL, name TEXT NOT NULL,
        name_cn TEXT NOT NULL, gender TEXT NOT NULL, aliases TEXT NOT NULL,
        summary TEXT NOT NULL, comments INTEGER NOT NULL, collects INTEGER NOT NULL
      );
      CREATE TABLE subjects (
        id INTEGER PRIMARY KEY, type INTEGER NOT NULL, name TEXT NOT NULL,
        name_cn TEXT NOT NULL, date TEXT NOT NULL, nsfw INTEGER NOT NULL,
        tags TEXT NOT NULL, meta_tags TEXT NOT NULL, score REAL NOT NULL
      );
      CREATE TABLE character_subject_relations (
        character_id INTEGER NOT NULL, subject_id INTEGER NOT NULL,
        relation_type INTEGER NOT NULL, relation_order INTEGER NOT NULL,
        PRIMARY KEY(character_id, subject_id)
      );
      -- CCB 角色标签，来自上游 id_tags 快照（32705 角色 / 421 标签）。
      CREATE TABLE character_tags (
        character_id INTEGER NOT NULL, tag TEXT NOT NULL,
        PRIMARY KEY(character_id, tag)
      );
      -- CCB 声优：只保留作品类型为动画(2)/游戏(4)的配音关系，与原版
      -- `persons.filter(p => p.subject_type === 2 || p.subject_type === 4)` 对齐。
      CREATE TABLE character_vas (
        character_id INTEGER NOT NULL, person_id INTEGER NOT NULL,
        name TEXT NOT NULL, name_cn TEXT NOT NULL,
        PRIMARY KEY(character_id, person_id)
      );
      CREATE INDEX csr_character ON character_subject_relations(character_id, relation_order);
      CREATE INDEX csubjects_type_date ON subjects(type, date);
      CREATE INDEX characters_collects ON characters(collects DESC);
      CREATE INDEX character_tags_tag ON character_tags(tag, character_id);
      -- 注意：不要给 character_vas 再加 (character_id, person_id) 索引，
      -- 主键已经就是这两列，重复索引只会白占体积。
      CREATE VIRTUAL TABLE character_search USING fts5(name, name_cn, aliases, content='characters', content_rowid='id', tokenize='trigram');
    """)


KIND_PATTERNS = [
    ("opening", ("片头", "片頭", "opening")),
    ("ending", ("片尾", "片尾", "ending")),
    ("insert", ("插入", "插曲", "insert")),
    ("ost", ("原声", "soundtrack", "ost")),
    ("character", ("角色", "character")),
    ("remix", ("remix", "重混")),
    ("doujin", ("同人",)),
    ("image", ("印象", "image")),
    ("vocaloid", ("vocaloid",)),
    ("drama", ("drama", "广播剧", "廣播劇")),
    ("radio", ("radio", "广播", "廣播")),
    ("arrange", ("arrange", "改编", "編曲")),
    ("single", ("单曲", "單曲", "single")),
    ("collection", ("精选", "精選", "collection", "best")),
    ("reading", ("朗读", "朗讀")),
    ("artistAlbum", ("艺人", "藝人", "album")),
    ("theme", ("主题", "主題", "theme", "tm")),
]

def track_kind(text: str) -> str:
    low = text.lower()
    if re.search(r"\bop\d*\b", low): return "opening"
    if re.search(r"\bed\d*\b", low): return "ending"
    if re.search(r"\bin\d*\b", low): return "insert"
    for kind, words in KIND_PATTERNS:
        if any(w.lower() in low for w in words): return kind
    return "theme"

def parse_infobox_tracks(infobox: str):
    tracks=[]
    for line in infobox.splitlines():
        if "=" not in line: continue
        key, value = [x.strip() for x in line.split("=",1)]
        if not value or any(x in key for x in ("分镜","演出","制作","作画","作词","作曲","编曲","監督","导演","设定","设计")): continue
        if not any(x in key.lower() for x in ("主题","片头","片尾","插入","opening","ending","insert","op","ed","in","ost","原声","character","角色","image","印象","remix","drama","radio","vocal","arrange","单曲","精选","朗读","艺人")): continue
        kind=track_kind(key)
        for part in re.split(r"[；;\n]+", value):
            part=part.strip().strip("{}[]")
            if not part: continue
            chunks=re.split(r"\s+[—－-]\s+|\s*/\s*|／", part, maxsplit=1)
            title=chunks[0].strip(" 『』「」")
            artist=chunks[1].strip() if len(chunks)>1 else None
            if len(title)>=2: tracks.append((title,artist,kind))
    seen=set(); out=[]
    for t in tracks:
        k=(t[2],t[0].lower(),(t[1] or '').lower())
        if k not in seen: seen.add(k); out.append(t)
    return out


def clean_infobox_value(value: str) -> str:
    """去掉 wiki 内链/模板标记。"""
    for token in ("[[", "]]", "{{", "}}"):
        value = value.replace(token, "")
    return value.strip()


def parse_infobox(infobox: str) -> tuple[dict[str, str], dict[str, list[str]]]:
    """把归档 dump 的 wiki infobox 原文解析成 (单值键表, 多值块表)。

    dump 里的 infobox 形如::

        {{Infobox Crt\\r\\n
        |简体中文名= 鲁路修·兰佩路基\\r\\n
        |别名={\\r\\n
        [L.L.]\\r\\n
        [英文名|Lelouch Lamperouge]\\r\\n
        }\\r\\n
        |性别= 男\\r\\n

    **键前带一个 ``|`` 前缀**，所以必须先去前缀再匹配，否则与 ``"中文名"``
    之类的全等比较永远不成立 —— 这正是历史上 name_cn / gender 全库为空的根因。
    多值块的值以 ``{`` 起头，条目逐行写成 ``[值]`` 或 ``[类型|值]``。
    """
    singles: dict[str, str] = {}
    blocks: dict[str, list[str]] = {}
    if not infobox:
        return singles, blocks

    pending_block: str | None = None
    for raw in infobox.splitlines():
        line = raw.strip()
        if not line or line.startswith("{{"):
            continue
        if pending_block is not None:
            if line.startswith("["):
                entry = line.strip("[]").strip()
                # ``[英文名|Lelouch Lamperouge]`` 取竖线后的实际值
                if "|" in entry:
                    entry = entry.split("|", 1)[1]
                entry = clean_infobox_value(entry)
                if entry:
                    blocks.setdefault(pending_block, []).append(entry)
                continue
            pending_block = None
            if line == "}":
                continue
        if not line.startswith("|") or "=" not in line:
            continue
        key, value = line[1:].split("=", 1)
        key, value = key.strip(), value.strip()
        if not key:
            continue
        if value.startswith("{"):
            pending_block = key
            continue
        if value and key not in singles:
            singles[key] = value
    return singles, blocks


def normalize_gender(value: str) -> str:
    if not value:
        return UNKNOWN_GENDER
    text = clean_infobox_value(value).strip().lower()
    if not text:
        return UNKNOWN_GENDER
    if text in GENDER_MAP:
        return GENDER_MAP[text]
    if "男" in text:
        return "male"
    if "女" in text:
        return "female"
    return UNKNOWN_GENDER


def first_matching(singles: dict[str, str], keys) -> str:
    for key in keys:
        value = singles.get(key)
        if value:
            return clean_infobox_value(value)
    return ""


def parse_character_infobox(infobox: str) -> tuple[str, str, list[str]]:
    """返回 (中文名, 归一性别, 别名列表)。"""
    singles, blocks = parse_infobox(infobox)
    name_cn = first_matching(singles, INFOBOX_NAME_KEYS)
    gender = normalize_gender(first_matching(singles, INFOBOX_GENDER_KEYS))
    aliases: list[str] = []
    for key in INFOBOX_ALIAS_KEYS:
        for alias in blocks.get(key, []):
            if alias and alias not in aliases:
                aliases.append(alias)
    return name_cn, gender, aliases


# 上游 id_tags.js 里数字键是**裸写法**（`1:["紫瞳",...]`），不是合法 JSON。
# 每行一个条目，所以只在行首匹配键，不会误伤标签文本里的数字冒号。
_BARE_NUMERIC_KEY = re.compile(r"^(\s*)(\d+)(\s*):", re.MULTILINE)


def load_character_tags(source: str) -> dict[int, list[str]]:
    """读取上游 id_tags.js，返回 ``{角色 id: [标签, ...]}``。

    ``source`` 可以是 URL（构建期的正常形态）或本地文件路径（离线开发/自测）。
    """
    if source.startswith(("http://", "https://")):
        with urllib.request.urlopen(source, timeout=120) as response:
            text = response.read().decode("utf-8")
    else:
        text = Path(source).read_text(encoding="utf-8")

    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise SystemExit(f"id_tags 内容异常，找不到对象字面量：{source}")
    text = _BARE_NUMERIC_KEY.sub(r'\1"\2"\3:', text[start : end + 1])
    # JS 允许结尾多余逗号，JSON 不允许。
    text = re.sub(r",\s*([}\]])", r"\1", text)
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as error:
        raise SystemExit(f"id_tags 解析失败（{source}）：{error}") from error

    result: dict[int, list[str]] = {}
    for key, values in raw.items():
        if not isinstance(values, list):
            continue
        tags = [tag for tag in values if isinstance(tag, str) and tag]
        if tags:
            result[int(key)] = tags
    return result


CHARACTER_FLOOR_MESSAGE = (
    "角色字段填充率异常：{column} 全库为 0。归档 dump 的 name_cn / gender 只能从 "
    "infobox 解析，键前带 '|' 前缀，解析失败即全空 —— 历史上正是这个原因导致 "
    "name_cn 与 gender 长期为空。请先核对 infobox 格式再重跑。"
)


def report_character_stats(db: sqlite3.Connection) -> dict[str, int]:
    def scalar(query: str) -> int:
        return int(db.execute(query).fetchone()[0])

    stats = {
        "characters": scalar("SELECT count(*) FROM characters"),
        "name_cn": scalar("SELECT count(*) FROM characters WHERE name_cn <> ''"),
        "gender_known": scalar("SELECT count(*) FROM characters WHERE gender IN ('male','female')"),
        "summary": scalar("SELECT count(*) FROM characters WHERE summary <> ''"),
        "aliases": scalar("SELECT count(*) FROM characters WHERE aliases NOT IN ('', '[]')"),
        "tags": scalar("SELECT count(*) FROM character_tags"),
        "tagged_characters": scalar("SELECT count(DISTINCT character_id) FROM character_tags"),
        "vas": scalar("SELECT count(*) FROM character_vas"),
        "va_characters": scalar("SELECT count(DISTINCT character_id) FROM character_vas"),
        "animated_characters": scalar(
            "SELECT count(DISTINCT r.character_id) FROM character_subject_relations r "
            "JOIN subjects s ON s.id = r.subject_id WHERE s.type = 2"
        ),
    }
    total = stats["characters"]
    print("[character db] 填充率报告")
    for key, value in stats.items():
        ratio = (value / total * 100) if total else 0
        print(f"  {key:<22}{value:>9}  ({ratio:5.1f}%)")
    if total == 0:
        raise SystemExit("角色表为空：dump 目录可能不对。")
    for column in ("name_cn", "gender_known"):
        if stats[column] == 0:
            raise SystemExit(CHARACTER_FLOOR_MESSAGE.format(column=column))
    if stats["tags"] == 0:
        raise SystemExit("character_tags 为空：上游 id_tags 未被正确读取（检查 --tags 地址或网络）。")
    return stats


def build(dump: Path, out: Path, tags_source: str = DEFAULT_TAGS_URL):
    out.mkdir(parents=True, exist_ok=True)
    subjects: dict[int, dict] = {}
    for item in lines(dump / "subject.jsonlines"):
        subjects[item["id"]] = item

    character_tags = load_character_tags(tags_source)
    print(f"[character db] 角色标签 {len(character_tags)} 个角色，来自 {tags_source}")

    # 产物先写进同盘临时目录，再原子替换到目标路径，中途失败不留半成品。
    # 两个坑都要防：① 连接必须在 replace 之前关闭（Windows 不允许重命名仍被打开的
    # 文件）；② 清理临时目录必须 ignore_errors，否则删不掉时抛出的 PermissionError
    # 会把真正的失败原因（下面的填充率守卫）整个吞掉。
    temp = tempfile.mkdtemp(dir=out)
    song_path = Path(temp) / "bangumi-song.sqlite"
    char_path = Path(temp) / "bangumi-character.sqlite"
    song = sqlite3.connect(song_path)
    char = sqlite3.connect(char_path)
    try:
        setup_song(song); setup_character(char)
        song_sub = song.cursor(); char_sub = char.cursor()
        for item in subjects.values():
            tags = json.dumps([x.get("name", "") for x in item.get("tags", [])], ensure_ascii=False)
            meta = json.dumps(item.get("meta_tags", []), ensure_ascii=False)
            fav = item.get("favorite", {})
            heat = sum(int(fav.get(k, 0) or 0) for k in ("wish", "done", "doing", "on_hold", "dropped"))
            row = (item["id"], item.get("type", 0), item.get("name", ""), item.get("name_cn", ""), item.get("infobox", ""), item.get("summary", ""), item.get("date", ""), int(bool(item.get("nsfw", False))), tags, meta, float(item.get("score", 0) or 0), int(item.get("rank", 0) or 0), heat, "")
            if item.get("type") == 2: song_sub.execute("INSERT INTO subjects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row)
            elif item.get("type") == 3: song_sub.execute("INSERT INTO music_subjects VALUES (?,?,?,?,?)", (item["id"], item.get("name", ""), item.get("name_cn", ""), float(item.get("score", 0) or 0), int(item.get("rank", 0) or 0)))
            if item.get("type") != 3: char_sub.execute("INSERT INTO subjects VALUES (?,?,?,?,?,?,?,?,?)", (item["id"], item.get("type", 0), item.get("name", ""), item.get("name_cn", ""), item.get("date", ""), int(bool(item.get("nsfw", False))), tags, meta, float(item.get("score", 0) or 0)))
        for rel in lines(dump / "subject-relations.jsonlines"):
            a_item, b_item = subjects.get(rel["subject_id"], {}), subjects.get(rel["related_subject_id"], {})
            if a_item.get("type") == 2 and b_item.get("type") == 3:
                title = b_item.get("name_cn") or b_item.get("name") or ""
                relation_type = int(rel.get("relation_type", 0) or 0)
                # 关联类型码语义（用真实数据集全量核对）：3003 片头曲、3004 片尾曲、
                # 3005 插入歌、3002 角色歌、3006 印象曲、3001 主题歌/原声带。
                # 旧映射把 3002~3005 整体错位一格，导致片头曲被标成 ED、角色歌被标成 OP。
                kind = {3001: "theme", 3002: "character", 3003: "opening", 3004: "ending", 3005: "insert", 3006: "image"}.get(relation_type, track_kind(title))
                song_sub.execute("INSERT OR IGNORE INTO subject_music_relations VALUES (?,?,?,?,?,?,?)", (rel["subject_id"], rel["related_subject_id"], relation_type, rel.get("order", 0), title, None, kind))
        for item in subjects.values():
            if item.get("type") != 2: continue
            for order, (title, artist, kind) in enumerate(parse_infobox_tracks(item.get("infobox", ""))):
                song_sub.execute("INSERT OR IGNORE INTO subject_music_relations VALUES (?,?,?,?,?,?,?)", (item["id"], -((item["id"] * 10000) + order + 1), 0, order, title, artist, kind))
        for item in lines(dump / "character.jsonlines"):
            name_cn, gender, aliases = parse_character_infobox(item.get("infobox", ""))
            char_sub.execute("INSERT INTO characters VALUES (?,?,?,?,?,?,?,?,?)", (
                item["id"], int(item.get("role", 0) or 0), item.get("name", ""), name_cn, gender,
                json.dumps(aliases, ensure_ascii=False), item.get("summary", ""),
                item.get("comments", 0), item.get("collects", 0),
            ))
        for rel in lines(dump / "subject-characters.jsonlines"):
            char_sub.execute("INSERT OR IGNORE INTO character_subject_relations VALUES (?,?,?,?)", (rel["character_id"], rel["subject_id"], rel.get("type", 0), rel.get("order", 0)))

        # ---- CCB 角色标签（上游 id_tags 快照） ----
        for character_id, tags in character_tags.items():
            char_sub.executemany("INSERT OR IGNORE INTO character_tags VALUES (?,?)", ((character_id, tag) for tag in tags))

        # ---- CCB 声优（person-characters + person） ----
        # person.jsonlines 同样没有 name_cn 列，中文名也要落到 infobox 解析上。
        persons: dict[int, tuple[str, str]] = {}
        for item in lines(dump / "person.jsonlines"):
            singles, _ = parse_infobox(item.get("infobox", ""))
            persons[item["id"]] = (item.get("name", ""), first_matching(singles, INFOBOX_NAME_KEYS))
        for rel in lines(dump / "person-characters.jsonlines"):
            subject = subjects.get(rel.get("subject_id"))
            if not subject or subject.get("type") not in (2, 4):
                continue
            person = persons.get(rel.get("person_id"))
            if not person or not person[0]:
                continue
            char_sub.execute("INSERT OR IGNORE INTO character_vas VALUES (?,?,?,?)", (rel["character_id"], rel["person_id"], person[0], person[1]))

        song.executescript("INSERT INTO subject_search(rowid,name,name_cn) SELECT id,name,name_cn FROM subjects; INSERT INTO music_search(rowid,name,name_cn) SELECT id,name,name_cn FROM music_subjects;")
        char.execute("INSERT INTO character_search(rowid,name,name_cn,aliases) SELECT id,name,name_cn,aliases FROM characters;")
        song.commit(); char.commit()
        # 填充率守卫：任一项为 0 都在这里抛错，由 finally 收拾现场。
        report_character_stats(char)

        song.close(); char.close()
        for source, target in ((song_path, out / song_path.name), (char_path, out / char_path.name)):
            source.replace(target)
    finally:
        song.close(); char.close()
        shutil.rmtree(temp, ignore_errors=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("dump", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument(
        "--tags",
        default=DEFAULT_TAGS_URL,
        help="上游 id_tags.js 的 URL 或本地路径（默认取 CCB-TagsCI 每周产出的文件）",
    )
    args = parser.parse_args()
    build(args.dump, args.out, args.tags)
