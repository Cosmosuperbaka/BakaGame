import { describe, expect, it } from "bun:test";
import { createDatabase } from "../src/infrastructure/db/Database";
import { splitStatements } from "../scripts/RunOneOffSql";

// 端口 1 必然被拒，连接失败是瞬时的：既能触发重试，又不会拖慢用例。
const UNREACHABLE_URL = "mysql://user:pass@127.0.0.1:1/bakagame";

describe("Database（启动连通性检查的失败语义）", () => {
  it("连不上时按 attempts 重试，耗尽后才把 ready 钉死为失败", async () => {
    const attempts: number[] = [];
    const database = createDatabase(UNREACHABLE_URL, {
      attempts: 2,
      onRetry: ({ attempt }) => attempts.push(attempt),
    });

    await expect(database.ready).rejects.toThrow();
    expect(attempts).toEqual([1]);
    await database.close();
  });

  it("attempts 为 1 时不重试", async () => {
    const attempts: number[] = [];
    const database = createDatabase(UNREACHABLE_URL, {
      attempts: 1,
      onRetry: ({ attempt }) => attempts.push(attempt),
    });

    await expect(database.ready).rejects.toThrow();
    expect(attempts).toEqual([]);
    await database.close();
  });

  it("非法连接串立即失败，不进入重试", () => {
    expect(() => createDatabase("not-a-url")).toThrow(/DATABASE_URL/);
  });
});

describe("一次性 SQL 脚本切分", () => {
  it("按 drizzle 的语句分隔符切分，保留语句内的换行", () => {
    expect(
      splitStatements(
        "CREATE TABLE `a` (\n  `id` int\n);\n--> statement-breakpoint\nALTER TABLE `a` ADD `b` int;"
      )
    ).toEqual(["CREATE TABLE `a` (\n  `id` int\n)", "ALTER TABLE `a` ADD `b` int"]);
  });

  it("没有分隔符时按行尾分号切分，并跳过注释与空语句", () => {
    expect(
      splitStatements(
        "-- 给反馈加索引\nALTER TABLE `f` ADD INDEX `i` (`c`);\n\nUPDATE `f` SET `c` = 'x;y';\n"
      )
    ).toEqual(["ALTER TABLE `f` ADD INDEX `i` (`c`)", "UPDATE `f` SET `c` = 'x;y'"]);
  });
});
