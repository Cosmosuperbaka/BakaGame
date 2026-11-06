/**
 * 把 konsheng/Sensitive-lexicon（MIT）的 Vocabulary/*.txt 合并成 src/infrastructure/SensitiveLexicon.json。
 *
 * 用法：`bun run scripts/BuildSensitiveLexicon.ts <词库 Vocabulary 目录> <提交哈希>`。
 * 只收录与聊天安全相关的类别；广告、网址、泛化的民生与第三方大词表误伤过多，不收录。
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeSensitiveText } from "../src/infrastructure/SensitiveText";

const FILES = [
  "色情类型",
  "色情词库",
  "暴恐词库",
  "反动词库",
  "政治类型",
  "涉枪涉爆",
  "补充词库",
  "贪腐词库",
  "其他词库",
  "新思想启蒙",
];

const directory = process.argv[2];
const commit = process.argv[3];
if (!directory || !commit)
  throw new Error("用法：BuildSensitiveLexicon <Vocabulary 目录> <提交哈希>");

const words = new Set<string>();
for (const name of FILES) {
  const text = await readFile(resolve(directory, `${name}.txt`), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const word = line.trim();
    if (!word) continue;
    // 归一化后少于 2 个字符的单字词不收录；词表在运行时用同一口径再次归一化。
    if (normalizeSensitiveText(word).chars.length < 2) continue;
    words.add(word);
  }
}

const output = {
  source: "https://github.com/konsheng/Sensitive-lexicon",
  license: "MIT",
  copyright: "Copyright (c) 2024~2099 Konsheng",
  commit,
  files: FILES.map((name) => `Vocabulary/${name}.txt`),
  words: [...words].sort((left, right) => left.localeCompare(right, "zh-Hans")),
};
await writeFile(
  resolve(import.meta.dir, "../src/infrastructure/SensitiveLexicon.json"),
  `${JSON.stringify(output)}\n`
);
console.log(`写入 ${output.words.length} 条`);
