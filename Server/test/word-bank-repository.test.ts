import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WordBankRepository } from "../src/infrastructure/word-bank-repository";

// 词库仓储只允许保存最小结构：string[][]。
test("词库只保存二维词语数组且会去重", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "word-bank-"));

  try {
    const repository = new WordBankRepository(join(tempDir, "word-bank.json"));
    await repository.savePair([" 猫 ", "狗"]);
    await repository.savePair(["狗", "猫"]);

    const content = JSON.parse(
      readFileSync(join(tempDir, "word-bank.json"), "utf8"),
    ) as string[][];

    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
    expect(content[0]).toHaveLength(2);
    expect(typeof content[0][0]).toBe("string");
    expect(typeof content[0][1]).toBe("string");
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});
