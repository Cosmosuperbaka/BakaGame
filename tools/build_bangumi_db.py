#!/usr/bin/env python3
"""Build the two read-only Bangumi databases from an Archive dump."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import tempfile
from pathlib import Path


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
        PRIMARY KEY(subject_id, music_id)
      );
      CREATE INDEX subjects_type_date ON subjects(type, date);
      CREATE INDEX subjects_heat ON subjects(heat DESC);
      CREATE INDEX relations_subject_order ON subject_music_relations(subject_id, relation_order);
      CREATE VIRTUAL TABLE subject_search USING fts5(name, name_cn, content='subjects', content_rowid='id', tokenize='trigram');
      CREATE VIRTUAL TABLE music_search USING fts5(name, name_cn, content='music_subjects', content_rowid='id', tokenize='trigram');
    """)


def setup_character(db: sqlite3.Connection):
    db.executescript("""
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=OFF;
      CREATE TABLE characters (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_cn TEXT NOT NULL,
        gender TEXT NOT NULL, aliases TEXT NOT NULL, comments INTEGER NOT NULL,
        collects INTEGER NOT NULL
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
      CREATE INDEX csr_character ON character_subject_relations(character_id, relation_order);
      CREATE INDEX csubjects_type_date ON subjects(type, date);
      CREATE VIRTUAL TABLE character_search USING fts5(name, name_cn, aliases, content='characters', content_rowid='id', tokenize='trigram');
    """)


def build(dump: Path, out: Path):
    out.mkdir(parents=True, exist_ok=True)
    subjects: dict[int, dict] = {}
    for item in lines(dump / "subject.jsonlines"):
        subjects[item["id"]] = item

    with tempfile.TemporaryDirectory(dir=out) as temp:
        song_path = Path(temp) / "bangumi-song.sqlite"
        char_path = Path(temp) / "bangumi-character.sqlite"
        song = sqlite3.connect(song_path)
        char = sqlite3.connect(char_path)
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
            a, b = subjects.get(rel["subject_id"], {}).get("type"), subjects.get(rel["related_subject_id"], {}).get("type")
            if a == 2 and b == 3: song_sub.execute("INSERT OR IGNORE INTO subject_music_relations VALUES (?,?,?,?)", (rel["subject_id"], rel["related_subject_id"], rel.get("relation_type", 0), rel.get("order", 0)))
        for item in lines(dump / "character.jsonlines"):
            infobox = item.get("infobox", "")
            name_cn = ""
            gender = ""
            for raw in infobox.splitlines():
                if "=" not in raw: continue
                key, value = raw.split("=", 1)
                key, value = key.strip(), value.strip()
                if key in ("简体中文名", "繁体中文名", "中文名") and not name_cn: name_cn = value
                if key in ("性别", "性別", "gender") and not gender: gender = value
            aliases = []
            if "别名=" in infobox or "別名=" in infobox: aliases.append(name_cn)
            char_sub.execute("INSERT INTO characters VALUES (?,?,?,?,?,?,?)", (item["id"], item.get("name", ""), name_cn, gender, json.dumps(aliases, ensure_ascii=False), item.get("comments", 0), item.get("collects", 0)))
        for rel in lines(dump / "subject-characters.jsonlines"):
            char_sub.execute("INSERT OR IGNORE INTO character_subject_relations VALUES (?,?,?,?)", (rel["character_id"], rel["subject_id"], rel.get("type", 0), rel.get("order", 0)))
        song.executescript("INSERT INTO subject_search(rowid,name,name_cn) SELECT id,name,name_cn FROM subjects; INSERT INTO music_search(rowid,name,name_cn) SELECT id,name,name_cn FROM music_subjects;")
        char.execute("INSERT INTO character_search(rowid,name,name_cn,aliases) SELECT id,name,name_cn,aliases FROM characters;")
        song.commit(); char.commit(); song.close(); char.close()
        for source, target in ((song_path, out / song_path.name), (char_path, out / char_path.name)):
            source.replace(target)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("dump", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args()
    build(args.dump, args.out)
