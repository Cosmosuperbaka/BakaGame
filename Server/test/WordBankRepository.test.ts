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

test("高并发连续保存多个词对时保证数据完整一致且无临时文件残留", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "word-bank-high-concurrency-"));

  try {
    const repository = new WordBankRepository(join(tempDir, "word-bank.json"));
    const pairs: Array<[string, string]> = [
      ["春", "秋"],
      ["夏", "冬"],
      ["东", "西"],
      ["南", "北"],
      ["江", "河"],
      ["湖", "海"],
    ];

    await Promise.all(pairs.map((pair) => repository.savePair(pair)));

    const result = await repository.readAll();
    expect(result).toHaveLength(6);

    const { readdirSync } = await import("node:fs");
    const files = readdirSync(tempDir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("checkHealth 探测内存模式与损坏文件时的健康状态", async () => {
  const memRepo = new WordBankRepository(":memory:");
  expect(await memRepo.checkHealth()).toBe(true);

  const tempDir = mkdtempSync(join(tmpdir(), "word-bank-health-"));
  try {
    const filePath = join(tempDir, "word-bank.json");
    const validRepo = new WordBankRepository(filePath);
    await validRepo.savePair(["测试", "验证"]);
    expect(await validRepo.checkHealth()).toBe(true);

    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, "invalid json content", "utf8");
    expect(await validRepo.checkHealth()).toBe(false);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

test("drainWrites 正确排空写队列并保障最终落盘", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "word-bank-drain-"));
  try {
    const filePath = join(tempDir, "word-bank.json");
    const repo = new WordBankRepository(filePath);

    // 触发写任务但不直接 await savePair
    const p1 = repo.savePair(["晴天", "雨天"]);
    const p2 = repo.savePair(["白天", "黑夜"]);

    // 等待排空
    await repo.drainWrites();
    await Promise.all([p1, p2]);

    const result = await repo.readAll();
    expect(result).toHaveLength(2);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

