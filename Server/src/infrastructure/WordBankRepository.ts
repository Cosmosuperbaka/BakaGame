import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { normalizeWordPair } from "../domain/Rules";

const MAX_WORD_BANK_ENTRIES = 10_000;

export class WordBankRepository {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async readAll(): Promise<Array<[string, string]>> {
    // 词库文件损坏、格式异常或不存在时，统一安全回退为空词库，避免阻塞主流程。
    try {
      const content = await readFile(this.filePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(content) as unknown;
      } catch {
        return [];
      }

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
    const operation = this.writeQueue.then(() => this.savePairUnlocked(pair));
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async savePairUnlocked(pair: [string, string]): Promise<Array<[string, string]>> {
    // 词库文件只保存二维词语数组，不写入任何额外元数据。
    const normalizedPair = normalizeWordPair(pair);
    const allPairs = await this.readAll();
    const exists = allPairs.some(
      (entry) => entry[0] === normalizedPair[0] && entry[1] === normalizedPair[1],
    );

    if (!exists) {
      // 存储前按字典序排序，维持容量上限
      if (allPairs.length >= MAX_WORD_BANK_ENTRIES) {
        allPairs.shift();
      }
      allPairs.push(normalizedPair);
      allPairs.sort((left, right) => left.join("|").localeCompare(right.join("|")));

      const dir = dirname(this.filePath);
      await mkdir(dir, { recursive: true });
      const tempPath = `${this.filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(allPairs, null, 2)}\n`, "utf8");
      await rename(tempPath, this.filePath);
    }

    return allPairs;
  }
}
