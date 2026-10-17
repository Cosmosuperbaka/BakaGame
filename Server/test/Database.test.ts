import { describe, expect, it } from "bun:test";
import { createDatabase } from "../src/infrastructure/db/Database";

// 端口 1 必然被拒，连接失败是瞬时的：既能触发重试，又不会拖慢用例。
const UNREACHABLE_URL = "mysql://user:pass@127.0.0.1:1/bakagame";

describe("Database（启动迁移的失败语义）", () => {
  it("迁移失败时按 attempts 重试，耗尽后才把 ready 钉死为失败", async () => {
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
