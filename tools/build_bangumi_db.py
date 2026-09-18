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
        -- 原版 `details.raw_tags`：全类型、未过滤的 {标签: 票数}。
        -- 原版的 `details.tags`（只对动画(2)/游戏(4)填充、且剔除含 "20" 的年份型标签）
        -- 由它 + 类型在运行时导出 —— 存两份会制造漂移。
        raw_tags TEXT NOT NULL, meta_tags TEXT NOT NULL, score REAL NOT NULL,
        -- 投票人数：登场作品按它降序，`shared_appearances` 的第一个共同作品依赖该顺序。
        -- dump 没有 `rating.total`，用评分直方图 `score_details` 求和（已与线上 API 对过）。
        rating_count INTEGER NOT NULL,
        -- 热度：出题时按它降序取前 `topNSubjects` 个候选作品（原版 `POST /v0/search/subjects`
        -- 的 `sort: "heat"`）。dump 没有热度字段，用收藏分布 `favorite` 五个桶求和近似
        -- —— 与歌库的 `heat` 同一个口径。
        heat INTEGER NOT NULL
      );
      CREATE TABLE character_subject_relations (
        character_id INTEGER NOT NULL, subject_id INTEGER NOT NULL,
        relation_type INTEGER NOT NULL, relation_order INTEGER NOT NULL,
        PRIMARY KEY(character_id, subject_id)
      );
      -- CCB 角色标签，来自上游 id_tags 快照（32705 角色 / 421 标签）。
      -- position 是它在 id_tags 数组里的下标：原版按 `slice(0, characterTagNum)` 取前若干个。
      CREATE TABLE character_tags (
        character_id INTEGER NOT NULL, position INTEGER NOT NULL, tag TEXT NOT NULL,
        PRIMARY KEY(character_id, tag)
      );
      -- CCB 声优：只保留作品类型为动画(2)/游戏(4)的配音关系，与原版
      -- `persons.filter(p => p.subject_type === 2 || p.subject_type === 4)` 对齐。
      -- position 是遍历顺序（原版把 `animeVAs` 当有序数组发给前端，顺序有意义）。
      CREATE TABLE character_vas (
        character_id INTEGER NOT NULL, position INTEGER NOT NULL,
        person_id INTEGER NOT NULL, name TEXT NOT NULL, name_cn TEXT NOT NULL,
        PRIMARY KEY(character_id, person_id)
      );
      CREATE INDEX csr_character ON character_subject_relations(character_id, relation_order);
      -- 出题 stage 2 要「按作品取角色」，方向与上面那条相反，必须单独建。
      CREATE INDEX csr_subject ON character_subject_relations(subject_id, relation_order);
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


# ==================== CCB 派生字段 ====================
# 逐条对照原版 `anime-character-guessr/client/src/utils/bangumi.js` 的
# `getCharacterAppearances`。与 `CCBFilter` 的差异（原版为准，因为兼容模式要求
# 反馈一致）登记在 `Agents/CCB.md`；本节只实现原版规则。
#
# **这里只物化「输入」，不物化标签池**：原版的标签池是 `filteredAppearances` 的函数，
# 而 `filteredAppearances` 依赖房间设置 `gameSettings.metaTags`（决定只看哪几个大类）
# 以及「过滤后为空则回退到全部类型」这条兜底 —— 同一个角色在不同设置下标签池不同。
# 因此标签累积必须由运行时的 `domain/CCBRules.ts` 算，落库只会把某一种设置写死。

# 主角权重 3 倍、配角 1 倍（原版 `stuffFactor`）。同时也是「哪些关联算登场作品」的判据：
# 原版只认 staff 为 主角/配角，对应 dump 的 relation_type 1/2。
CCB_VA_SUBJECT_TYPES = (2, 4)


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
        "relations": scalar("SELECT count(*) FROM character_subject_relations"),
        "subjects": scalar("SELECT count(*) FROM subjects"),
        "subjects_nsfw": scalar("SELECT count(*) FROM subjects WHERE nsfw = 1"),
        "subjects_animated": scalar("SELECT count(*) FROM subjects WHERE type = 2"),
        "animated_with_heat": scalar("SELECT count(*) FROM subjects WHERE type = 2 AND heat > 0"),
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
    # nsfw 必须一个不留（合规硬要求）：这条一旦回归，成人向作品标题就会重新出现在反馈里。
    if stats["subjects_nsfw"] != 0:
        raise SystemExit(
            f"角色库仍有 {stats['subjects_nsfw']} 部 nsfw 作品：nsfw 剔除逻辑被改坏了（见 Agents/CCB.md §6.5）。"
        )
    # 出题与反馈全都要靠「关系 × 作品」联表算，这两项任一为 0 就说明 dump 没读对。
    for column in ("relations", "animated_characters", "animated_with_heat"):
        if stats[column] == 0:
            raise SystemExit(
                f"CCB 基础数据 {column} 全库为 0：dump 的 subject-characters / subject 未被正确读取，"
                "或关联/热度推导被改坏。"
            )
    return stats


def build(dump: Path, out: Path, tags_source: str = DEFAULT_TAGS_URL):
    out.mkdir(parents=True, exist_ok=True)
    subjects: dict[int, dict] = {}
    # NSFW 作品 id：**只从角色库剔除**（合规要求，见 `Agents/CCB.md §6.5`）。
    # 原版从不看 `nsfw`，成人向作品标题会直接出现在反馈里 —— 这是本项目对原版的刻意偏离。
    # 歌曲库保持全集：那边的 `subjects` 只存动画(type 2)，而「NSFW 动画进不进歌曲题库」
    # 是另一个产品决定，不在本次范围内，硬塞进来会连带改动 Songuessr 的题库。
    nsfw_subject_ids: set[int] = set()
    for item in lines(dump / "subject.jsonlines"):
        subjects[item["id"]] = item
        if item.get("nsfw"):
            nsfw_subject_ids.add(item["id"])
    print(f"[character db] dump 内 nsfw 作品 {len(nsfw_subject_ids)} 部，只从角色库剔除")

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
            # 角色库存的是原版 `details.raw_tags`：**全类型、未过滤**的 {标签: 票数}。
            # 原版的 `details.tags`（只对动画/游戏填充、且剔除含 "20" 的年份型标签）
            # 由它 + 作品类型在运行时导出，两份都存会制造漂移。
            raw_tags = json.dumps(
                {x.get("name", ""): int(x.get("count", 0) or 0) for x in item.get("tags", []) if x.get("name")},
                ensure_ascii=False,
            )
            meta = json.dumps(item.get("meta_tags", []), ensure_ascii=False)
            # 投票人数 = 评分分布直方图求和（dump 没有直接给 rating.total）。
            rating_count = sum(int(value or 0) for value in (item.get("score_details") or {}).values())
            item["_rating_count"] = rating_count
            fav = item.get("favorite", {})
            heat = sum(int(fav.get(k, 0) or 0) for k in ("wish", "done", "doing", "on_hold", "dropped"))
            row = (item["id"], item.get("type", 0), item.get("name", ""), item.get("name_cn", ""), item.get("infobox", ""), item.get("summary", ""), item.get("date", ""), int(bool(item.get("nsfw", False))), tags, meta, float(item.get("score", 0) or 0), int(item.get("rank", 0) or 0), heat, "")
            if item.get("type") == 2: song_sub.execute("INSERT INTO subjects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row)
            elif item.get("type") == 3: song_sub.execute("INSERT INTO music_subjects VALUES (?,?,?,?,?)", (item["id"], item.get("name", ""), item.get("name_cn", ""), float(item.get("score", 0) or 0), int(item.get("rank", 0) or 0)))
            # 角色库收**全部类型**的条目（含音乐 3）：原版的登场作品在「按大类过滤后为空」
            # 时会回退到全部类型，那时音乐/书籍/三次元的标签也要参与计算。
            # 但 **nsfw 一律不进角色库** —— 进了就会出现在反馈的登场作品里。
            if item["id"] in nsfw_subject_ids:
                continue
            char_sub.execute("INSERT INTO subjects VALUES (?,?,?,?,?,?,?,?,?,?,?)", (item["id"], item.get("type", 0), item.get("name", ""), item.get("name_cn", ""), item.get("date", ""), int(bool(item.get("nsfw", False))), raw_tags, meta, float(item.get("score", 0) or 0), rating_count, heat))
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
        # ---- CCB 角色 ↔ 作品关联（登场作品与标签池都由运行时联表算）----
        # 主键 (character_id, subject_id) + INSERT OR IGNORE 已经去重，无需在内存里再判一次。
        for rel in lines(dump / "subject-characters.jsonlines"):
            # 已剔除的 nsfw 作品连关联一起丢：留着就是指向不存在作品的悬空行。
            if rel["subject_id"] in nsfw_subject_ids:
                continue
            char_sub.execute("INSERT OR IGNORE INTO character_subject_relations VALUES (?,?,?,?)", (rel["character_id"], rel["subject_id"], rel.get("type", 0), rel.get("order", 0)))

        # ---- CCB 声优（person-characters + person） ----
        # person.jsonlines 同样没有 name_cn 列，中文名也要落到 infobox 解析上。
        # 只保留作品类型为动画(2)/游戏的(4)的配音关系，与原版
        # `persons.filter(p => p.subject_type === 2 || p.subject_type === 4)` 对齐。
        persons: dict[int, tuple[str, str]] = {}
        for item in lines(dump / "person.jsonlines"):
            singles, _ = parse_infobox(item.get("infobox", ""))
            persons[item["id"]] = (item.get("name", ""), first_matching(singles, INFOBOX_NAME_KEYS))
        # 顺序即 dump 文件顺序，也就是原版 `animeVAs`（一个 Set，按遍历顺序）的顺序；
        # 它在反馈里是有序数组，所以 position 必须落库。
        vas_by_character: dict[int, list[tuple[int, str, str]]] = {}
        seen_va: set[tuple[int, int]] = set()
        for rel in lines(dump / "person-characters.jsonlines"):
            subject = subjects.get(rel.get("subject_id"))
            if not subject or subject.get("type") not in CCB_VA_SUBJECT_TYPES:
                continue
            person = persons.get(rel.get("person_id"))
            if not person or not person[0]:
                continue
            relation = (rel["character_id"], rel["person_id"])
            if relation in seen_va:
                continue
            seen_va.add(relation)
            # 原版用日文原名（`person.name`）进标签池与 CV 列表，中文名只另存一列。
            vas_by_character.setdefault(rel["character_id"], []).append(
                (rel["person_id"], person[0], person[1])
            )
        for character_id, entries in vas_by_character.items():
            char_sub.executemany(
                "INSERT INTO character_vas VALUES (?,?,?,?,?)",
                (
                    (character_id, position, person_id, name, name_cn)
                    for position, (person_id, name, name_cn) in enumerate(entries)
                ),
            )

        # ---- 角色本体 ----
        # 登场作品**不落库**：它是 `character_subject_relations × subjects` 的函数，
        # 还要按房间设置的大类过滤，且原版在运行时才做「年份有效/未上映」判定。
        # 物化一份只会制造第二真相源（且算标签权重必需的 `relation_type` 也不在里面）。
        # 运行时由 `infrastructure/CCBCharacterRepository.ts` 联表算。
        for item in lines(dump / "character.jsonlines"):
            character_id = item["id"]
            name_cn, gender, aliases = parse_character_infobox(item.get("infobox", ""))
            char_sub.execute("INSERT INTO characters VALUES (?,?,?,?,?,?,?,?,?)", (
                character_id, int(item.get("role", 0) or 0), item.get("name", ""), name_cn, gender,
                json.dumps(aliases, ensure_ascii=False), item.get("summary", ""),
                item.get("comments", 0), item.get("collects", 0),
            ))

        # ---- CCB 角色标签（上游 id_tags 快照） ----
        for character_id, tags in character_tags.items():
            char_sub.executemany(
                "INSERT OR IGNORE INTO character_tags VALUES (?,?,?)",
                ((character_id, position, tag) for position, tag in enumerate(tags)),
            )

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
