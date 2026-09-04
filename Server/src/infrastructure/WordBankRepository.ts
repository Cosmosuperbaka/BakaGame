import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { AppError } from "../domain/Errors";
import { normalizeWordPair } from "../domain/Rules";

const MAX_WORD_BANK_ENTRIES = 10_000;

export class WordBankRepository {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async readAll(): Promise<Array<[string, string]>> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch (error) {
      throw new AppError("WORDBANK_CORRUPT", "词库文件内容不是合法的 JSON", { cause: error });
    }

    if (!Array.isArray(parsed)) {
      throw new AppError("WORDBANK_CORRUPT", "词库文件格式不正确：根节点必须为数组");
    }

    return parsed.map((entry, index) => {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        typeof entry[1] !== "string"
      ) {
        throw new AppError("WORDBANK_CORRUPT", `词库在索引 ${index} 处的条目格式不正确`);
      }
      return normalizeWordPair([entry[0], entry[1]]);
    });
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

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await rename(tempPath, this.filePath);
          break;
        } catch (error) {
          if (attempt === 2) {
            try {
              await unlink(tempPath);
            } catch {
              // 忽略临时文件删除异常，透传主错误
            }
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
        }
      }
    }

    return allPairs;
  }

  async checkHealth(): Promise<boolean> {
    try {
      if (this.filePath === ":memory:") return true;
      await this.readAll();
      return true;
    } catch {
      return false;
    }
  }

  async drainWrites(): Promise<void> {
    await this.writeQueue;
  }
}
