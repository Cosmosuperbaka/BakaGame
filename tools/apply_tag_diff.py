#!/usr/bin/env python3
"""应用 CCB-TagsCI 的角色标签增量（id_tags.diff.json）。

为什么需要它：id_tags.js 是 2 MB 全量产物，标签每周都可能有细微变化，
为了一个角色改了标签就重建整个数据集不划算。上游现在额外产出 diff，
这里把它幂等地落到 `character_tags` 表。

之所以要校验 `baseSha256`：diff 只描述「相对上一版」的变化。若本地记录的
版本与 diff 的基线对不上，说明中间漏过了一轮或多轮，直接应用会**静默漏掉**
那些轮次的变更 —— 这时必须回退到用全量 id_tags.js 重建，而不是硬套。

用法：
    python3 tools/apply_tag_diff.py Server/data/bangumi.sqlite /path/id_tags.diff.json
    python3 tools/apply_tag_diff.py Server/data/bangumi.sqlite --url <diff 的 URL>
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import urllib.request
from pathlib import Path

STATE_NAME = "tag-diff-state.json"


def load_json(source: str) -> dict:
    if source.startswith(("http://", "https://")):
        request = urllib.request.Request(source, headers={"Accept": "application/json", "User-Agent": "BakaGame/1.0"})
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read())
    with open(source, encoding="utf-8") as stream:
        return json.load(stream)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("db", type=Path, help="bangumi.sqlite")
    parser.add_argument("diff", nargs="?", help="id_tags.diff.json 的路径")
    parser.add_argument("--url", help="改为从 URL 拉取 diff")
    parser.add_argument("--state", type=Path, help="已应用版本记录（默认与 db 同目录）")
    parser.add_argument("--force", action="store_true", help="基线不匹配时仍然应用（会漏变更，仅用于人工确认过的情况）")
    args = parser.parse_args()

    source = args.url or args.diff
    if not source:
        parser.error("需要给出 diff 路径或 --url")
    state_path = args.state or (args.db.parent / STATE_NAME)

    payload = load_json(source)
    base_sha = payload.get("baseSha256")
    target_sha = payload.get("targetSha256")
    if not target_sha:
        print("diff 缺少 targetSha256，拒绝应用")
        return 1

    applied = None
    if state_path.exists():
        try:
            applied = json.loads(state_path.read_text(encoding="utf-8")).get("appliedSha256")
        except (OSError, json.JSONDecodeError):
            applied = None

    counts = payload.get("counts") or {}
    print(f"diff：新增 {counts.get('added', '?')} / 变更 {counts.get('changed', '?')} / "
          f"移除 {counts.get('removed', '?')}（共 {counts.get('total', '?')} 角色）")
    print(f"基线 baseSha256 = {(base_sha or '无（上游首次产出）')[:16]}；本地已应用 = {(applied or '未记录')[:16]}")

    if applied is not None and base_sha is not None and applied != base_sha and not args.force:
        print("❌ 基线不匹配：本地处于其它版本，直接应用会漏掉中间轮次的变更。")
        print("   请改用全量 id_tags.js 重建 character_tags 后重试（或用 --force 自行承担）。")
        return 2
    if applied is None:
        print("⚠️ 本地没有已应用版本记录：本次按全量基线应用，之后会记下 targetSha256。")

    db = sqlite3.connect(args.db)
    try:
        added = payload.get("added") or {}
        changed = payload.get("changed") or {}
        removed = payload.get("removed") or []

        # 同一角色的标签是一整组：先清后插，而不是逐条 diff（position 是数组下标）。
        replaced = [(key, tags) for key, tags in list(added.items()) + list(changed.items())]
        for character_id, tags in replaced:
            db.execute("DELETE FROM character_tags WHERE character_id = ?", (int(character_id),))
            db.executemany("INSERT OR IGNORE INTO character_tags VALUES (?,?,?)",
                           ((int(character_id), position, tag) for position, tag in enumerate(tags)))
        for character_id in removed:
            db.execute("DELETE FROM character_tags WHERE character_id = ?", (int(character_id),))
        db.commit()
    finally:
        db.close()

    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({"appliedSha256": target_sha,
                                      "generatedAt": payload.get("generatedAt"),
                                      "characters": counts.get("total")}, indent=2), encoding="utf-8")
    print(f"✅ 已应用 {len(replaced)} 组标签、移除 {len(removed)} 个角色；版本记为 {target_sha[:16]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
