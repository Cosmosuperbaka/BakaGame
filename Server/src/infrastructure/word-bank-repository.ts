import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { normalizeWordPair } from "../domain/rules";

export class WordBankRepository {
  constructor(private readonly filePath: string) {}

  async readAll(): Promise<Array<[string, string]>> {
    // 词库文件损坏或不存在时，统一回退为空词库。
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as unknown;

      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter(
          (entry): entry is [string, string] =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === "string" &&
            typeof entry[1] === "string",
        )
        .map((entry) => normalizeWordPair(entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  async savePair(pair: [string, string]): Promise<Array<[string, string]>> {
    // 词库文件只保存二维词语数组，不写入任何额外元数据。
    const normalizedPair = normalizeWordPair(pair);
    const allPairs = await this.readAll();
    const exists = allPairs.some(
      (entry) => entry[0] === normalizedPair[0] && entry[1] === normalizedPair[1],
    );

    if (!exists) {
      // 存储前按字典序排序，尽量让 Git diff 和人工检查都更稳定。
      allPairs.push(normalizedPair);
      allPairs.sort((left, right) => left.join("|").localeCompare(right.join("|")));
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, `${JSON.stringify(allPairs, null, 2)}\n`, "utf8");
    }

    return allPairs;
  }
}
