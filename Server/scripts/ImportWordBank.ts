/**
 * 一次性迁移：把旧版 `storage/word-bank.json` 的词对导入数据库 `word_pair`。
 *
 * 用法：`bun run scripts/ImportWordBank.ts [文件路径]`（缺省 `storage/word-bank.json`）。
 * 读取 `DATABASE_URL`，先应用迁移；重复执行安全（已存在的词对跳过，不累加次数）。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeWordPair } from "../src/domain/Rules";
import { createDatabase } from "../src/infrastructure/db/Database";
import { wordPair } from "../src/infrastructure/db/Schema";

const filePath = resolve(process.argv[2] ?? resolve(import.meta.dir, "../storage/word-bank.json"));
const url = Bun.env.DATABASE_URL?.trim();
if (!url) throw new Error("缺少 DATABASE_URL");

const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
if (!Array.isArray(parsed)) throw new Error("词库文件根节点必须为数组");

const pairs = new Map<string, [string, string]>();
let skipped = 0;
for (const [index, entry] of parsed.entries()) {
  if (
    !Array.isArray(entry) ||
    entry.length !== 2 ||
    typeof entry[0] !== "string" ||
    typeof entry[1] !== "string"
  ) {
    throw new Error(`索引 ${index} 处的条目格式不正确`);
  }
  try {
    const pair = normalizeWordPair([entry[0], entry[1]]);
    pairs.set(pair.join("\u0000"), pair);
  } catch {
    skipped++;
  }
}

const database = createDatabase(url);
try {
  await database.ready;
  const rows = [...pairs.values()].map(([wordA, wordB]) => ({ wordA, wordB }));
  for (let offset = 0; offset < rows.length; offset += 500) {
    await database.db
      .insert(wordPair)
      .ignore()
      .values(rows.slice(offset, offset + 500));
  }
  console.log(`已导入 ${rows.length} 个词对（跳过非法条目 ${skipped} 个）`);
} finally {
  await database.close();
}
