#!/usr/bin/env python3
"""用 Bangumi API 刷新作品标签（dump 的 tags 被截断到 11 个，API 给 30 个）。

为什么要单独一个脚本：数据集的结构、关系、名称来自 dump（那是完整的），
唯独**标签字段不可信** —— 实测 5 个样本全部只有 11 个标签，而 API 返回 30 个，
缺的都是「鲁路修」「战斗」「大河内一楼」这类真正有信息量的标签。
标签直接决定 CCB 的标签池与猜歌的结算摘要，少了就是玩法质量下降。

只更新 `subjects.tags`（名称数组）与 `subjects.raw_tags`（{名称: 票数}），
不动其它字段 —— 所以可反复重跑，也是运行时更新器的原型。

用法：
    python3 tools/refresh_subject_tags.py Server/data/bangumi.sqlite
    python3 tools/refresh_subject_tags.py ... --limit 500      # 抽查
"""
from __future__ import annotations

import argparse
import concurrent.futures as futures
import json
import sqlite3
import sys
import threading
import time
import urllib.request

DEFAULT_BASE = "https://bangumi.baka.website"
# 写入串行化：连接跨线程复用（check_same_thread=False），执行 SQL 时必须持锁。
write_lock = threading.Lock()


def fetch_tags(base: str, subject_id: int, timeout: int = 30) -> list[dict] | None:
    request = urllib.request.Request(f"{base}/v0/subjects/{subject_id}",
                                     headers={"Accept": "application/json", "User-Agent": "BakaGame/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read())
    except Exception:  # noqa: BLE001
        return None
    tags = body.get("tags")
    return tags if isinstance(tags, list) else []


def to_columns(tags: list[dict]) -> tuple[str, str]:
    """转成两列：`tags` 是名称数组（官方 document.Tag 口径），`raw_tags` 是 {名称: 票数}。"""
    names = [str(item.get("name", "")) for item in tags if item.get("name")]
    counts = {str(item.get("name", "")): int(item.get("count", 0) or 0) for item in tags if item.get("name")}
    return json.dumps(names, ensure_ascii=False), json.dumps(counts, ensure_ascii=False)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("db", help="bangumi.sqlite")
    parser.add_argument("--base", default=DEFAULT_BASE)
    parser.add_argument("--concurrency", type=int, default=48)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--only-missing", action="store_true",
                        help="只刷新 raw_tags 为空的条目（首次补齐用；全量重刷用于修正历史偏差）")
    args = parser.parse_args()

    db = sqlite3.connect(args.db, check_same_thread=False)
    try:
        query = "SELECT id FROM subjects ORDER BY heat DESC, id ASC"
        if args.only_missing:
            query = "SELECT id FROM subjects WHERE raw_tags IN ('', '{}') ORDER BY heat DESC, id ASC"
        ids = [row[0] for row in db.execute(query)]
        if args.limit:
            ids = ids[: args.limit]
        print(f"待刷新 {len(ids):,} 个作品的标签（并发 {args.concurrency}）")

        started = time.time()
        updated = failed = tags_total = 0
        pending: list[tuple[str, str, int]] = []

        def handle(subject_id: int):
            return subject_id, fetch_tags(args.base, subject_id)

        with futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            for index, (subject_id, tags) in enumerate(pool.map(handle, ids), start=1):
                if tags is None:
                    failed += 1
                elif tags:
                    names, counts = to_columns(tags)
                    pending.append((names, counts, subject_id))
                    tags_total += len(tags)
                    updated += 1
                if len(pending) >= 500:
                    with write_lock:
                        db.executemany("UPDATE subjects SET tags = ?, raw_tags = ? WHERE id = ?", pending)
                        db.commit()
                        pending.clear()
                if index % 5000 == 0 or index == len(ids):
                    elapsed = time.time() - started
                    rate = index / elapsed if elapsed else 0
                    print(f"  [{index:,}/{len(ids):,}] 更新 {updated:,} 失败 {failed:,} "
                          f"标签 {tags_total:,} | {rate:.0f} 条/s | 已用 {elapsed / 60:.1f} 分", flush=True)
        if pending:
            db.executemany("UPDATE subjects SET tags = ?, raw_tags = ? WHERE id = ?", pending)
        db.commit()
        average = tags_total / updated if updated else 0
        print(f"完成：更新 {updated:,} 条，平均标签 {average:.1f} 个/条，失败 {failed:,}，"
              f"用时 {(time.time() - started) / 60:.1f} 分")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
