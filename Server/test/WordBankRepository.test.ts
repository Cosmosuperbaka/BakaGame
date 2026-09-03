import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WordBankRepository } from "../src/infrastructure/WordBankRepository";

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

test("并发保存不同词对时不会互相覆盖", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "word-bank-concurrent-"));

  try {
    const repository = new WordBankRepository(join(tempDir, "word-bank.json"));
    await Promise.all([
      repository.savePair(["猫", "狗"]),
      repository.savePair(["苹果", "香蕉"]),
    ]);

    const content = JSON.parse(
      readFileSync(join(tempDir, "word-bank.json"), "utf8"),
    ) as string[][];

    expect(content).toHaveLength(2);
    expect(content).toContainEqual(["狗", "猫"]);
    expect(content).toContainEqual(["苹果", "香蕉"]);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("词库文件内容损坏时应抛出错误保护数据，阻止破坏性覆盖", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "word-bank-corrupt-"));

  try {
    const filePath = join(tempDir, "word-bank.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, "invalid-json-content-{{{", "utf8");

    const repository = new WordBankRepository(filePath);
    await expect(repository.readAll()).rejects.toThrow("词库文件内容不是合法的 JSON");

    // 拒绝盲目写回，阻止破坏性覆盖清空已有文件
    await expect(repository.savePair(["月亮", "太阳"])).rejects.toThrow();
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

