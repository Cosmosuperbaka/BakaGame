#!/usr/bin/env python3
"""Regression tests for tools/build_bangumi_db.py.

Run directly (no pytest needed)::

    python3 tools/test_build_bangumi_db.py

The infobox samples are copied verbatim from the real Bangumi Archive dump
(``character.jsonlines`` / ``person.jsonlines``), including the ``\\r\\n`` line
endings, so the parser is exercised against production data rather than an
idealised fixture.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_bangumi_db as subject  # noqa: E402

# 真实 dump 原文（角色 1 ルルーシュ・ランペルージ）。
LELOUCH_INFOBOX = (
    "{{Infobox Crt\r\n"
    "|简体中文名= 鲁路修·兰佩路基\r\n"
    "|别名={\r\n"
    "[L.L.]\r\n"
    "[勒鲁什]\r\n"
    "[鲁鲁修]\r\n"
    "[ゼロ]\r\n"
    "[Zero]\r\n"
    "[英文名|Lelouch Lamperouge]\r\n"
    "[第二中文名|鲁路修·冯·布里塔尼亚]\r\n"
    "[纯假名|]\r\n"
    "[昵称|]\r\n"
    "}\r\n"
    "|性别= 男\r\n"
    "|生日= 12月5日\r\n"
    "|血型= A型\r\n"
    "|身高= 178cm→181cm\r\n"
)
# 真实 dump 原文（person 1 水樹奈々）——人物表同样没有 name_cn 列。
NANA_INFOBOX = (
    "{{Infobox Crt\r\n"
    "|简体中文名= 水树奈奈\r\n"
    "|别名={\r\n"
    "[第二中文名|]\r\n"
    "[日文名|近藤奈々 (こんどう なな)]\r\n"
    "}\r\n"
    "|性别= 女\r\n"
    "|生日= 1980年1月21日\r\n"
)

FAILURES: list[str] = []


def check(label: str, actual, expected) -> None:
    if actual != expected:
        FAILURES.append(f"{label}: 期望 {expected!r}，实际 {actual!r}")
        print(f"  ✗ {label}: 期望 {expected!r}，实际 {actual!r}")
    else:
        print(f"  ✓ {label}")


def check_true(label: str, condition: bool) -> None:
    if not condition:
        FAILURES.append(f"{label}: 断言不成立")
        print(f"  ✗ {label}")
    else:
        print(f"  ✓ {label}")


def test_parse_character_infobox() -> None:
    print("parse_character_infobox")
    name_cn, gender, aliases = subject.parse_character_infobox(LELOUCH_INFOBOX)
    # 这条是历史 bug 的核心回归：键前带 '|' 前缀，全等比较会永远失败。
    check("name_cn 命中", name_cn, "鲁路修·兰佩路基")
    check("gender 归一", gender, "male")
    check("别名数量", len(aliases), 7)
    check_true("别名含普通条目", "L.L." in aliases)
    check_true("别名取竖线后的值", "Lelouch Lamperouge" in aliases)
    check_true("别名不含类型前缀", "英文名" not in aliases)
    check_true("空别名被丢弃", all(a.strip() for a in aliases))

    name_cn, gender, _ = subject.parse_character_infobox(NANA_INFOBOX)
    check("人物中文名命中", name_cn, "水树奈奈")
    check("人物 gender 归一", gender, "female")

    # 反例：性别非男/女一律归一到 '?'
    for raw, expected in (("性别= 不明", "?"), ("性别=", "?"), ("性别= other", "?")):
        _, gender, _ = subject.parse_character_infobox(f"{{{{Infobox Crt\r\n|{raw}\r\n}}")
        check(f"gender 反例 {raw!r}", gender, expected)

    # 反例：完全没有 infobox 时不能抛错，且性别落到 '?'
    check("空 infobox", subject.parse_character_infobox(""), ("", "?", []))
    check("空 infobox 性别", subject.parse_character_infobox("")[1], "?")

    # 反例：只有 中文名 没有 简体中文名
    name_cn, _, _ = subject.parse_character_infobox("{{Infobox Crt\r\n|中文名= 测试\r\n}}")
    check("中文名 兜底键", name_cn, "测试")

    # 反例：多值块结束后必须继续解析后续单值键（否则 性别 会丢）
    _, gender, aliases = subject.parse_character_infobox(
        "{{Infobox Crt\r\n|别名={\r\n[A]\r\n}\r\n|性别= 女\r\n}}"
    )
    check("块后继续解析", gender, "female")
    check("块后继续解析别名", aliases, ["A"])

    # 反例：缺失类型前缀以外的畸形行不得影响其它行
    name_cn, _, _ = subject.parse_character_infobox(
        "{{Infobox Crt\r\n没有等号的行\r\n|简体中文名= 有效\r\n|随便=|带 \r\n}}"
    )
    check("畸形行被跳过", name_cn, "有效")

    # `[[内链]]` 需要清洗
    name_cn, _, _ = subject.parse_character_infobox("{{Infobox Crt\r\n|简体中文名= [[内链]]名\r\n}}")
    check("内链被清洗", name_cn, "内链名")

    # 与 Bangumi server 的 GetWikiValues 对齐：别名允许是单值，且多个
    # 中文名字段都应进入搜索别名；详情仍使用首个中文名作为 name_cn。
    name_cn, _, aliases = subject.parse_character_infobox(
        "{{Infobox Crt\r\n|中文名= 首选名\r\n|简体中文名= 简体名\r\n|别名= 单值别名\r\n}}"
    )
    check("多中文名首选", name_cn, "首选名")
    check("多中文名可搜索", aliases, ["简体名", "单值别名"])


def test_parse_music_infobox_artist() -> None:
    print("音乐条目艺术家解析")
    check("单值键", subject.parse_music_infobox_artist("{{Infobox Single\r\n|艺术家= Sound Horizon\r\n}}"), "Sound Horizon")
    check("日文键", subject.parse_music_infobox_artist("{{Infobox Album\r\n|アーティスト= Vaundy\r\n}}"), "Vaundy")
    check("歌手键", subject.parse_music_infobox_artist("{{Infobox Single\r\n|歌手= 中山エミリ\r\n}}"), "中山エミリ")
    # 多艺人时值是块形态，只认 singles 会整条漏掉（实测 YOASOBI 这类多演唱者条目）。
    check("多值块", subject.parse_music_infobox_artist("{{Infobox Album\r\n|艺术家={\r\n[YOASOBI]\r\n[Ayase]\r\n}\r\n}}"), "YOASOBI、Ayase")
    check("内链清洗", subject.parse_music_infobox_artist("{{Infobox Album\r\n|艺术家= [[KOTOKO]]\r\n}}"), "KOTOKO")
    check("无艺术家字段", subject.parse_music_infobox_artist("{{Infobox Album\r\n|发售日期= 2020\r\n}}"), "")
    check("空 infobox", subject.parse_music_infobox_artist(""), "")


def test_load_character_tags() -> None:
    print("load_character_tags（上游 id_tags.js 的裸数字键）")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "id_tags.js"
        path.write_text(
            "export const idToTags = {\n"
            '1:["紫瞳","黑发","腹黑"],\n'
            '3:["黑发"],\n'
            '7:[],\n'
            "}\n",
            encoding="utf-8",
        )
        tags = subject.load_character_tags(str(path))
    # 空标签数组不产生条目，否则会往 character_tags 写空行
    check("只保留非空条目", len(tags), 2)
    check("标签内容", tags[1], ["紫瞳", "黑发", "腹黑"])
    check("单标签", tags[3], ["黑发"])

    with tempfile.TemporaryDirectory() as tmp:
        broken = Path(tmp) / "id_tags.js"
        broken.write_text("这不是对象字面量", encoding="utf-8")
        try:
            subject.load_character_tags(str(broken))
        except SystemExit:
            check_true("内容异常时构建失败", True)
        else:
            FAILURES.append("id_tags 内容异常竟然没报错")
            print("  ✗ id_tags 内容异常竟然没报错")


def write_jsonlines(path: Path, records: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n", encoding="utf-8")


def make_extra_tags(root: Path) -> Path:
    directory = root / "extra_tags"
    directory.mkdir()
    for subject_id in json.loads(subject.EXTRA_SUBJECTS_PATH.read_text(encoding="utf-8")):
        (directory / f"{subject_id}.json").write_text("{}", encoding="utf-8")
    (directory / "18011.json").write_text(json.dumps({
        "1": {"_name": "角色名", "位置": {"打野": "<img src='/icon.png'>打野", "上路": "上路"},
              "难度": {"2": "<script>不应进入数据库</script>", "": ""}},
    }, ensure_ascii=False), encoding="utf-8")
    return directory


def test_load_extra_tags() -> None:
    print("游戏专属标签（保留文字键与顺序，拒绝缺失或损坏文件）")
    with tempfile.TemporaryDirectory() as tmp:
        directory = make_extra_tags(Path(tmp))
        rows = subject.load_character_extra_tags(str(directory))
        check("分组与标签完整保序", rows, [
            (1, 18011, 1, 0, "位置", "打野"), (1, 18011, 1, 1, "位置", "上路"),
            (1, 18011, 2, 0, "难度", "2"),
        ])
        path = directory / "18011.json"
        path.write_text('{"1":{"位置":[]}}', encoding="utf-8")
        try:
            subject.load_character_extra_tags(str(directory))
        except ValueError as error:
            check_true("损坏分组拒绝构建", "标签分组格式无效" in str(error))
        else:
            FAILURES.append("损坏分组被接受")
        path.unlink()
        try:
            subject.load_character_extra_tags(str(directory))
        except FileNotFoundError:
            pass
        else:
            FAILURES.append("缺失专属标签文件被接受")


def make_dump(root: Path) -> None:
    write_jsonlines(
        root / "subject.jsonlines",
        [
            {"id": 8, "type": 2, "name": "コードギアス", "name_cn": "反叛的鲁路修", "date": "2006-10-05", "score": 8.6, "tags": [{"name": "机战", "count": 10}], "meta_tags": ["原创"], "infobox": "", "summary": "", "favorite": {"done": 100}},
            {"id": 3154, "type": 4, "name": "STEINS;GATE", "name_cn": "命运石之门", "date": "2009-10-15", "score": 8.9, "tags": [], "meta_tags": [], "infobox": "", "summary": "", "favorite": {}},
            # type=1（书籍）用于验证声优过滤：这条关联必须被排除
            {"id": 999, "type": 1, "name": "小説版", "name_cn": "小说版", "date": "2007-01-01", "score": 7.0, "tags": [], "meta_tags": [], "infobox": "", "summary": "", "favorite": {}},
            # 音乐条目的艺术家只写在自身 infobox 里（音乐表没有该列），
            # 反向关系落库时必须把它带上，否则出题打分的歌手信号整条失效。
            {"id": 77, "type": 3, "name": "COLORS", "name_cn": "COLORS", "score": 9.0, "rank": 1,
             "infobox": "{{Infobox Single\r\n|艺术家= 島谷ひとみ\r\n}}"},
            # nsfw 作品**只从角色库剔除**，歌曲库保持全集（范围决定见 build 里的注释）。
            # 一条动画、一条游戏 —— 后者正是「成人向游戏标题进反馈」那条合规问题的来源。
            {"id": 556, "type": 2, "name": "nsfwアニメ", "name_cn": "成人向动画", "date": "2016-01-01", "score": 7.1, "tags": [], "meta_tags": [], "infobox": "", "summary": "", "favorite": {"done": 5}, "nsfw": True},
            {"id": 557, "type": 4, "name": "nsfwゲーム", "name_cn": "成人向游戏", "date": "2016-02-01", "score": 7.2, "tags": [], "meta_tags": [], "infobox": "", "summary": "", "favorite": {}, "nsfw": True},
        ],
    )
    # 动画 ↔ 音乐的反向关联：用来验证「曲目落库时把音乐条目的艺术家带上」。
    write_jsonlines(
        root / "subject-relations.jsonlines",
        [{"subject_id": 8, "related_subject_id": 77, "relation_type": 3003, "order": 0}],
    )
    write_jsonlines(
        root / "character.jsonlines",
        [
            {"id": 1, "role": 1, "name": "ルルーシュ・ランペルージ", "infobox": LELOUCH_INFOBOX, "summary": "主角。", "comments": 184, "collects": 1227},
            {"id": 2, "role": 2, "name": "フリーダムガンダム", "infobox": "{{Infobox Crt\r\n|简体中文名= 自由高达\r\n|性别= \r\n}}", "summary": "", "comments": 1, "collects": 2},
        ],
    )
    write_jsonlines(
        root / "subject-characters.jsonlines",
        [
            {"character_id": 1, "subject_id": 8, "type": 1, "order": 0},
            {"character_id": 1, "subject_id": 999, "type": 1, "order": 0},
            {"character_id": 2, "subject_id": 8, "type": 2, "order": 1},
            # nsfw 作品的关联必须一起丢掉，否则库里会留下指向不存在作品的悬空行。
            {"character_id": 1, "subject_id": 556, "type": 1, "order": 0},
            {"character_id": 1, "subject_id": 557, "type": 1, "order": 0},
        ],
    )
    write_jsonlines(
        root / "person.jsonlines",
        [{"id": 1, "name": "水樹奈々", "type": 1, "infobox": NANA_INFOBOX, "summary": ""}],
    )
    write_jsonlines(
        root / "person-characters.jsonlines",
        [
            {"person_id": 1, "subject_id": 8, "character_id": 1, "type": 0, "summary": ""},
            # 书籍作品（type=1）的配音关系必须被过滤掉
            {"person_id": 1, "subject_id": 999, "character_id": 2, "type": 0, "summary": ""},
        ],
    )


def subject_record(
    subject_id: int,
    subject_type: int,
    date: str,
    tags: list[tuple[str, int]] | None = None,
    meta_tags: list[str] | None = None,
    score: float = 0.0,
    rating_count: int = 0,
) -> dict:
    return {
        "id": subject_id,
        "type": subject_type,
        "date": date,
        "tags": [{"name": name, "count": count} for name, count in (tags or [])],
        "meta_tags": meta_tags or [],
        "score": score,
        "_rating_count": rating_count,
    }


def test_build_end_to_end() -> None:
    print("build（合成 dump 端到端）")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        dump = root / "dump"
        out = root / "out"
        dump.mkdir()
        make_dump(dump)
        tags = root / "id_tags.js"
        tags.write_text('export const idToTags = {\n1:["紫瞳","腹黑"],\n}\n', encoding="utf-8")

        subject.build(dump, out, str(tags), str(make_extra_tags(root)))

        import sqlite3

        db = sqlite3.connect(out / "bangumi.sqlite")
        row = db.execute("SELECT role, name, name_cn, gender, aliases, summary, comments, collects FROM characters WHERE id = 1").fetchone()
        check("role 落库", row[0], 1)
        check("name 落库", row[1], "ルルーシュ・ランペルージ")
        check("name_cn 落库", row[2], "鲁路修·兰佩路基")
        check("gender 落库", row[3], "male")
        check_true("aliases 落库", "L.L." in json.loads(row[4]))
        check("summary 落库", row[5], "主角。")
        check("collects 落库", row[7], 1227)

        gender = db.execute("SELECT gender FROM characters WHERE id = 2").fetchone()[0]
        check("空性别归一为 '?'", gender, "?")

        check("character_tags 行数", db.execute("SELECT count(*) FROM character_tags").fetchone()[0], 2)
        check("专属标签落库且没有展示代码", db.execute(
            "SELECT section, tag FROM character_extra_tags ORDER BY section_position, tag_position"
        ).fetchall(), [("位置", "打野"), ("位置", "上路"), ("难度", "2")])
        # 注意：SQLite 的 TEXT 排序是 BINARY，中文按码点/UTF-8 字节序，不是拼音。
        check("character_tags 内容", db.execute("SELECT tag FROM character_tags WHERE character_id = 1 ORDER BY tag").fetchall(), [("紫瞳",), ("腹黑",)])
        # position 必须保持 id_tags 的数组序：原版按 `slice(0, characterTagNum)` 取前若干个。
        check(
            "character_tags 保序",
            db.execute("SELECT tag FROM character_tags WHERE character_id = 1 ORDER BY position").fetchall(),
            [("紫瞳",), ("腹黑",)],
        )

        # 登场作品**故意不落库**：它是「关联 × 作品」的函数、还要按房间设置过滤，
        # 运行时由 CCBCharacterRepository 联表算。这里只断言原始关联齐备。
        check(
            "角色↔作品关联落库",
            db.execute("SELECT subject_id, relation_type FROM character_subject_relations WHERE character_id = 1 ORDER BY subject_id").fetchall(),
            [(8, 1), (999, 1)],
        )

        # 标签池**故意不落库**：它是房间设置（大类 + subjectTagNum/characterTagNum + commonTags）
        # 的函数，物化任意一份都会把某一种设置写死。这里只断言「输入」齐备。
        check(
            "角色库的 subjects 存 raw_tags 票数、投票人数与热度",
            db.execute("SELECT raw_tags, rating_count, heat FROM subjects WHERE id = 8").fetchone(),
            ('{"机战": 10}', 0, 100),
        )
        # 类型不设限：原版的大类过滤为空时会回退到全部类型，那时书籍/三次元的标签也要
        # 参与计算。所以 999（书籍）照样入库 —— 判据是「有没有角色关联」，不是类型。
        check(
            "非动画类型的作品同样入库（判据是有无角色关联）",
            db.execute("SELECT type FROM subjects WHERE id = 999").fetchone(),
            (1,),
        )
        check(
            "characters 表不含标签池列",
            [row[1] for row in db.execute("PRAGMA table_info(characters)")],
            ["id", "role", "name", "name_cn", "gender", "aliases", "summary", "comments", "collects"],
        )

        # nsfw 作品**一个都不能进角色库**（合规硬要求，见 Agents/CCB.md §6.5）。
        check(
            "nsfw 作品不进角色库",
            db.execute("SELECT count(*) FROM subjects WHERE id IN (556, 557)").fetchone()[0],
            0,
        )
        check(
            "nsfw 作品的关联一并剔除（不留悬空行）",
            db.execute(
                "SELECT count(*) FROM character_subject_relations WHERE subject_id IN (556, 557)"
            ).fetchone()[0],
            0,
        )
        check(
            "角色库 nsfw 计数为 0",
            db.execute("SELECT count(*) FROM subjects WHERE nsfw = 1").fetchone()[0],
            0,
        )

        vas = db.execute("SELECT character_id, position, person_id, name, name_cn FROM character_vas ORDER BY character_id").fetchall()
        check("声优只保留动画/游戏作品", vas, [(1, 0, 1, "水樹奈々", "水树奈奈")])

        # FTS 索引必须仍然可用，且能靠中文名检索
        hit = db.execute("SELECT rowid FROM character_search WHERE character_search MATCH ?", ("鲁路修*",)).fetchall()
        check_true("character_search 可检索中文名", any(r[0] == 1 for r in hit))

        # ---- 单库与裁剪 ----
        # 猜歌与 CCB 共用同一个库：subjects 不再各存一份，也不再产出两个文件。
        check_true("只产出一个库文件", (out / "bangumi.sqlite").exists())
        # 裁剪：没有角色关联、也没有关联音乐的作品永远用不到。
        # fixture 里 8（有角色 + 有音乐）与 999（有角色）留下；3154（无任何关联）被丢弃。
        check("裁剪后只剩用得到的作品", db.execute("SELECT id FROM subjects ORDER BY id").fetchall(), [(8,), (999,)])
        check("无关联作品被裁掉", db.execute("SELECT count(*) FROM subjects WHERE id = 3154").fetchone()[0], 0)
        # 音乐条目 77 只被 8 反向关联、自身没有角色关联 —— 它不会出现在任何角色的登场
        # 作品里，所以不入库；曲目信息由 subject_music_relations 承载，不依赖它在 subjects。
        check("无角色关联的音乐条目不入库", db.execute("SELECT count(*) FROM subjects WHERE id = 77").fetchone()[0], 0)
        # nsfw 一律不进：556/557 虽然有角色关联，仍在裁剪后剔除。
        check("nsfw 作品一个不留", db.execute("SELECT count(*) FROM subjects WHERE nsfw = 1").fetchone()[0], 0)
        # 曲目必须带上音乐条目 infobox 里的艺术家：出题打分的「歌手交集 ±4/3」全靠它，
        # 空着会让原版优先退化成只看曲名与专辑名（旧库实测 3 万条曲目里 0 条带 artist）。
        check(
            "曲目带艺术家落库",
            db.execute("SELECT title, artist, kind FROM subject_music_relations WHERE subject_id = 8 AND music_id = 77").fetchall(),
            [("COLORS", "島谷ひとみ", "opening")],
        )
        # image 列存在且留空：dump 不含图片，由后端更新时写入。
        check("image 列留空待更新", db.execute("SELECT image FROM subjects WHERE id = 8").fetchone()[0], "")
        db.close()


def test_build_guard() -> None:
    print("build 守卫（填充率为 0 必须让构建失败）")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        dump = root / "dump"
        out = root / "out"
        dump.mkdir()
        make_dump(dump)
        # 把所有角色的 infobox 换成解析不出中文名的内容
        write_jsonlines(
            dump / "character.jsonlines",
            [{"id": 1, "role": 1, "name": "无名", "infobox": "{{Infobox Crt\r\n|生日= 1月1日\r\n}}", "summary": "", "comments": 0, "collects": 0}],
        )
        tags = root / "id_tags.js"
        tags.write_text('export const idToTags = {\n1:["紫瞳"],\n}\n', encoding="utf-8")
        try:
            subject.build(dump, out, str(tags), str(make_extra_tags(root)))
        except SystemExit as error:
            check_true("name_cn 为 0 时构建失败", "name_cn" in str(error))
        else:
            FAILURES.append("name_cn 全空竟然构建成功了")
            print("  ✗ name_cn 全空竟然构建成功了")


def main() -> int:
    test_parse_character_infobox()
    test_parse_music_infobox_artist()
    test_load_character_tags()
    test_load_extra_tags()
    test_build_end_to_end()
    test_build_guard()
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} 条断言未通过")
        for item in FAILURES:
            print(f"  - {item}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    if shutil.which("python3") is None:
        pass  # 仅用于说明：无需外部依赖
    sys.exit(main())
