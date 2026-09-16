#!/usr/bin/env python3
"""Import the CCB character-tag table into ``Server/data/character-tags.json``.

The source of truth is the CCB upstream file ``client/src/data/id_tags.js``
(32k characters / ~421 distinct tags).  Bangumi's own server never serves this
table back: ``POST /api/character-tags`` and ``POST /api/game-character-tags``
are write-only sinks into MongoDB, so the snapshot has to be vendored.
CCBFilter's ``dump/id_tags.json`` is the same data already converted to JSON.

Output format (compact, so the file stays a plain git object rather than LFS):

    {
      "source": "anime-character-guessr/client/src/data/id_tags.js",
      "tagCount": 421,
      "entryCount": 32709,
      "tags": ["紫瞳", "黑发", ...],
      "characters": { "1": [0, 3, 5], "2": [11, 7] }
    }

``characters`` values index into ``tags``.  Keying on an id dictionary instead
of repeating the tag strings keeps the file roughly 40% smaller.

Usage:
    python3 tools/import_character_tags.py <id_tags.js|id_tags.json> Server/data/character-tags.json
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

SOURCE = "anime-character-guessr/client/src/data/id_tags.js"
# ``export const idToTags = {1: ["a"], ...}`` is JS, not JSON: numeric keys are
# bare.  Quote them before parsing, the same way CCBFilter does.
_BARE_NUMERIC_KEY = re.compile(r"^(\s*)(\d+)(\s*):", re.MULTILINE)


def load_source(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".js":
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end <= start:
            raise SystemExit(f"未在 {path} 中找到对象字面量")
        text = _BARE_NUMERIC_KEY.sub(r'\1"\2"\3:', text[start : end + 1])
        # JS 允许结尾多余逗号，JSON 不允许。
        text = re.sub(r",\s*([}\]])", r"\1", text)
    data = json.loads(text)
    if not isinstance(data, dict):
        raise SystemExit(f"{path} 顶层必须是对象")
    return data


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="id_tags.js 或已转换的 id_tags.json")
    parser.add_argument("out", type=Path)
    args = parser.parse_args()

    raw = load_source(args.source)

    tag_index: dict[str, int] = {}
    tags: list[str] = []
    characters: dict[str, list[int]] = {}
    for key, values in raw.items():
        cid = int(key)
        if not isinstance(values, list):
            continue
        indexes: list[int] = []
        for tag in values:
            if not isinstance(tag, str) or not tag:
                continue
            position = tag_index.get(tag)
            if position is None:
                position = len(tags)
                tag_index[tag] = position
                tags.append(tag)
            if position not in indexes:
                indexes.append(position)
        if indexes:
            characters[str(cid)] = indexes

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(
            {
                "source": SOURCE,
                "tagCount": len(tags),
                "entryCount": len(characters),
                "tags": tags,
                "characters": characters,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )

    size = args.out.stat().st_size
    print(f"角色标签已写入 {args.out}")
    print(f"  角色 {len(characters)} 个 / 标签 {len(tags)} 个 / {size / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
