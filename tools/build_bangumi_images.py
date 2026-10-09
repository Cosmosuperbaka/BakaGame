#!/usr/bin/env python3
"""构建图床缓存：从 Bangumi 反代抓 avif，落成分片 SQLite。

为什么是图像字节而不是 URL 表：只读数据集不含 `images`，运行期逐条回源会撞上游限流
（一次搜索二十条就是二十次请求）。把图抓下来存在本地，运行时按路径直读。

为什么存 SQLite 而不是 112 万个文件：1376 B 的方格图在 4 KB block 的文件系统上要占
4 KB（四倍浪费），112 万个 inode 也不划算；SQLite blob 无对齐浪费，且「本地有没有」
就是一次主键查询。

关键设计：
- **按热度降序**构建：中途中断、或先传一部分上线时，热门的先可用。
- **断点续传**：路径已在分片库里就跳过，重跑即续。
- **分片**：默认 16 片（每片约 750 MB），便于并行上传与增量同步。
- **失败不落库**：校验 avif 魔数后再写，坏文件不入库（沿用「失败绝不固化」铁律）。

用法：
    python3 tools/build_bangumi_images.py Server/data/bangumi.sqlite Server/data/images
    python3 tools/build_bangumi_images.py ... --limit 500     # 只跑前 500 条，校准体积
"""
from __future__ import annotations

import argparse
import concurrent.futures as futures
import hashlib
import json
import os
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path

DEFAULT_BASE = "https://bangumi.baka.website"
# 实测的单张字节数（阶段 0 分层抽样，用于进度里的体积估算）。
ESTIMATE = {"subject": 8374, "character_grid": 1300, "character_large": 10257}
AVIF_MAGIC = b"ftyp"


# ---------------------------------------------------------------- 取图目标

def image_targets(subject_id: int | None, character_id: int | None, images: dict) -> list[tuple[str, str]]:
    """把 API 返回的 images 转成 [(用途, 路径)]。

    档位按显示尺寸定（见 tasks/notes/bangumi-image-cache-plan.md）：
    作品封面最长显示 80×112（2x → 160 宽），取 `/r/200/`；角色图最长 96×128，
    取 `/r/400/`；角色列表是 36px 方形，取方格图原图。
    """
    targets: list[tuple[str, str]] = []
    if character_id is not None:
        grid = images.get("grid")
        if grid:
            targets.append(("character_grid", to_path(grid)))
        large = images.get("large")
        if large:
            targets.append(("character_large", resize_path(large, 400)))
    if subject_id is not None:
        large = images.get("large")
        if large:
            targets.append(("subject", resize_path(large, 200)))
    return targets


def human(size: int) -> str:
    """体积自适应单位：小批量试跑时 0.00 GiB 没有任何信息量。"""
    if size < 1024 ** 2:
        return f"{size / 1024:.0f} KiB"
    if size < 1024 ** 3:
        return f"{size / 1024 ** 2:.1f} MiB"
    return f"{size / 1024 ** 3:.2f} GiB"


def to_path(url: str) -> str:
    """反代与源站同路径，去掉主机名即可。"""
    marker = "lain.bgm.tv"
    index = url.find(marker)
    return url[index + len(marker):] if index != -1 else url


def resize_path(url: str, width: int) -> str:
    """换成指定缩放档的路径；已是 `/r/xxx/` 的先剥掉再套目标档。"""
    rest = to_path(url)
    parts = rest.split("/")
    if len(parts) > 2 and parts[1] == "r" and parts[2].isdigit():
        rest = "/" + "/".join(parts[3:])
    return f"/r/{width}{rest}"


# ---------------------------------------------------------------- 网络

def fetch_json(base: str, path: str, timeout: int = 30):
    request = urllib.request.Request(base + path, headers={"Accept": "application/json", "User-Agent": "BakaGame/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except Exception:  # noqa: BLE001
        return None


def fetch_image(base: str, path: str, timeout: int = 40) -> bytes | None:
    request = urllib.request.Request(base + path, headers={"Accept": "image/avif", "User-Agent": "BakaGame/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------- 分片存储

SCHEMA = """
CREATE TABLE IF NOT EXISTS images (
  path TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  content_type TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
"""


class Shards:
    """按路径 CRC 分片落盘；每片一个 SQLite，便于并行上传与增量同步。"""

    def __init__(self, directory: Path, count: int):
        self.directory = directory
        self.count = count
        directory.mkdir(parents=True, exist_ok=True)
        self.connections = []
        for index in range(count):
            # check_same_thread=False：连接在下载线程池里被复用，必须允许跨线程。
            # 并发安全由调用侧的 write_lock 保证（写入串行，下载仍在锁外并发）。
            connection = sqlite3.connect(directory / f"images-{index:02d}.sqlite", check_same_thread=False)
            connection.executescript("PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF;" + SCHEMA)
            self.connections.append(connection)
        # 一次性把已有路径读进内存：490 万次「查一下有没有」不该都走 SQL。
        self.existing: set[str] = set()
        for connection in self.connections:
            self.existing.update(row[0] for row in connection.execute("SELECT path FROM images"))

    def has(self, path: str) -> bool:
        return path in self.existing

    def put(self, path: str, payload: bytes, content_type: str) -> None:
        shard = self.connections[zlib.crc32(path.encode()) % self.count]
        shard.execute("INSERT OR REPLACE INTO images VALUES (?,?,?,?)", (path, payload, content_type, int(time.time())))
        self.existing.add(path)

    def flush(self) -> None:
        for connection in self.connections:
            connection.commit()

    def close(self) -> None:
        for connection in self.connections:
            connection.commit()
            connection.close()


# ---------------------------------------------------------------- 主流程

def load_work(db_path: Path) -> list[tuple[int | None, int | None, int]]:
    """按热度降序给出待处理条目：[(subject_id, character_id, rank)]。

    作品与角色交错排（各自组内按热度降序），保证无论从哪一步中断，
    已完成的都是两边最热门的那部分。
    """
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        subjects = [row[0] for row in db.execute("SELECT id FROM subjects ORDER BY heat DESC, id ASC")]
        characters = [row[0] for row in db.execute("SELECT id FROM characters ORDER BY collects DESC, id ASC")]
    finally:
        db.close()
    # 交错：作品更少（3.6 万）且直接决定列表观感，优先全部排在前面。
    work: list[tuple[int | None, int | None, int]] = [(sid, None, index) for index, sid in enumerate(subjects)]
    work += [(None, cid, index) for index, cid in enumerate(characters)]
    return work


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("db", type=Path, help="bangumi.sqlite（提供 id 与热度排序）")
    parser.add_argument("out", type=Path, help="输出目录（分片库与清单）")
    parser.add_argument("--base", default=DEFAULT_BASE, help="反代基址")
    parser.add_argument("--shards", type=int, default=16)
    parser.add_argument("--concurrency", type=int, default=32, help="图片下载并发（实测 32→约 40 req/s 饱和）")
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 条（试跑/校准）")
    parser.add_argument("--skip-meta-backfill", action="store_true", help="不回填 db 的 image 列")
    args = parser.parse_args()

    print(f"读取待处理条目：{args.db}")
    work = load_work(args.db)
    if args.limit:
        work = work[: args.limit]
    print(f"  共 {len(work):,} 条（作品 {sum(1 for s, _, _ in work if s is not None):,} / "
          f"角色 {sum(1 for _, c, _ in work if c is not None):,}）")

    shards = Shards(args.out, args.shards)
    print(f"分片 {args.shards} 个，已有图片 {len(shards.existing):,} 张（断点续传基线）")

    started = time.time()
    stats = {"downloaded": 0, "skipped": 0, "missing": 0, "failed": 0, "bytes": 0}
    pending_backfill: list[tuple[str, int]] = []

    def handle(entry: tuple[int | None, int | None, int]) -> tuple[str, int, int, int, int, int | None, str | None]:
        """单条：取元数据 → 挑目标路径 → 缺什么下什么。只返回统计，不直接改闭包状态。"""
        subject_id, character_id, _ = entry
        resource = f"/v0/subjects/{subject_id}" if subject_id is not None else f"/v0/characters/{character_id}"
        body = fetch_json(args.base, resource)
        if body is None:
            return ("missing", 0, 0, 0, 0, None, None)
        images = body.get("images") or {}
        targets = image_targets(subject_id, character_id, images)
        if not targets:
            return ("done", 0, 0, 0, 0, subject_id, images.get("large"))
        skipped = saved = failed = size = 0
        for _, target in targets:
            if shards.has(target):
                skipped += 1
                continue
            payload = fetch_image(args.base, target)
            # 校验 avif 魔数后再落库：坏字节一旦入库，运行时就再也不会重下。
            if payload is None or AVIF_MAGIC not in payload[:16]:
                failed += 1
                continue
            # 分片连接不是线程安全的，用锁把写入这一小段串行化（下载仍在锁外并发）。
            with write_lock:
                shards.put(target, payload, "image/avif")
            saved += 1
            size += len(payload)
        return ("done", skipped, saved, failed, size, subject_id, images.get("large"))

    write_lock = threading.Lock()

    with futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        for index, result in enumerate(pool.map(handle, work), start=1):
            status, skipped, saved, failed, size, subject_id, subject_image = result
            if status == "missing":
                stats["missing"] += 1
            stats["skipped"] += skipped
            stats["downloaded"] += saved
            stats["failed"] += failed
            stats["bytes"] += size
            if subject_image is not None and subject_id is not None:
                pending_backfill.append((subject_image, subject_id))
            if index % 2000 == 0 or index == len(work):
                elapsed = time.time() - started
                rate = index / elapsed if elapsed else 0
                remain = (len(work) - index) / rate if rate else 0
                print(f"  [{index:,}/{len(work):,}] 新下 {stats['downloaded']:,} 跳过 {stats['skipped']:,} "
                      f"缺图 {stats['missing']:,} 失败 {stats['failed']:,} | {human(stats['bytes'])} | "
                      f"{rate:.1f} 条/s | 已用 {elapsed / 60:.1f} 分 预计剩余 {remain / 60:.0f} 分", flush=True)

    shards.flush()

    if pending_backfill and not args.skip_meta_backfill:
        print(f"回填 {len(pending_backfill):,} 条作品的 image 列")
        db = sqlite3.connect(args.db)
        try:
            db.executemany("UPDATE subjects SET image = ? WHERE id = ?", pending_backfill)
            db.commit()
        finally:
            db.close()

    print("计算分片校验和 ...")
    manifest = {"generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "shards": [], "total": {}}
    grand_count = grand_bytes = 0
    for path in sorted(args.out.glob("images-*.sqlite")):
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1 << 22), b""):
                digest.update(chunk)
        connection = sqlite3.connect(path)
        try:
            count, size = connection.execute("SELECT count(*), coalesce(sum(length(bytes)),0) FROM images").fetchone()
        finally:
            connection.close()
        grand_count += count
        grand_bytes += size
        manifest["shards"].append({"name": path.name, "count": count, "bytes": size,
                                   "sha256": digest.hexdigest(), "size": path.stat().st_size})
    manifest["total"] = {"images": grand_count, "bytes": grand_bytes, "elapsedSeconds": int(time.time() - started)}
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    shards.close()

    print(f"完成：{grand_count:,} 张 / {human(grand_bytes)}"
          f"（估算基线 {sum(ESTIMATE.values()) / 1024:.1f} KB/条），用时 {(time.time() - started) / 60:.1f} 分")
    print(f"清单：{args.out / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
