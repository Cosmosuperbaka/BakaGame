import { describe, expect, it } from "bun:test";
import { createDatabase } from "../src/infrastructure/db/Database";
import { splitStatements } from "../scripts/RunOneOffSql";
import { until } from "./support/Until";

// 端口 1 必然被拒，连接失败是瞬时的：既能触发重试，又不会拖慢用例。
const UNREACHABLE_URL = "mysql://user:pass@127.0.0.1:1/bakagame";

describe("Database（启动连通性检查的失败语义）", () => {
  it("连不上时按 attempts 重试，耗尽后才把 ready 钉死为失败", async () => {
    const attempts: number[] = [];
    const database = createDatabase(UNREACHABLE_URL, {
      attempts: 2,
      onRetry: ({ attempt }) => attempts.push(attempt),
    });

    await expect(database.ready).rejects.toThrow("Failed query: SELECT 1");
    expect(attempts).toEqual([1]);
    await database.close();
  });

  it("attempts 为 1 时不重试", async () => {
    const attempts: number[] = [];
    const database = createDatabase(UNREACHABLE_URL, {
      attempts: 1,
      onRetry: ({ attempt }) => attempts.push(attempt),
    });

    await expect(database.ready).rejects.toThrow("Failed query: SELECT 1");
    expect(attempts).toEqual([]);
    await database.close();
  });

  it("client() 等就绪后给出客户端：未就绪时拒绝，恢复后可用", async () => {
    let healthy = false;
    const database = createDatabase(UNREACHABLE_URL, {
      attempts: 1,
      retryCooldownMs: 30,
      check: async () => {
        if (!healthy) throw new Error("数据库暂时不可达");
      },
    });
    try {
      await expect(database.client()).rejects.toThrow("暂时不可达");
      healthy = true;
      await Bun.sleep(50);
      expect(await database.client()).toBe(database.db);
    } finally {
      await database.close();
    }
  });

  it("一次性失败后不永久钉死：冷却期内沿用失败结果，冷却后的下一次访问重新检查", async () => {
    let calls = 0;
    let healthy = false;
    const database = createDatabase(UNREACHABLE_URL, {
      attempts: 1,
      retryCooldownMs: 30,
      check: async () => {
        calls += 1;
        if (!healthy) throw new Error("数据库暂时不可达");
      },
    });
    try {
      await expect(database.ready).rejects.toThrow("暂时不可达");
      // 冷却期内每次访问拿到的都是同一个失败结果，不会每个请求都去敲数据库。
      await expect(database.ready).rejects.toThrow("暂时不可达");
      expect(calls).toBe(1);

      healthy = true;
      await Bun.sleep(50);
      await expect(database.ready).resolves.toBeUndefined();
      expect(calls).toBe(2);
      // 成功后缓存，不再重复检查。
      await database.ready;
      expect(calls).toBe(2);
    } finally {
      await database.close();
    }
  });

  it("冷却后并发访问只发起一次重新检查", async () => {
    let calls = 0;
    let healthy = false;
    const database = createDatabase(UNREACHABLE_URL, {
      attempts: 1,
      retryCooldownMs: 20,
      check: async () => {
        calls += 1;
        await Bun.sleep(10);
        if (!healthy) throw new Error("暂时不可达");
      },
    });
    try {
      await expect(database.ready).rejects.toThrow();
      healthy = true;
      await Bun.sleep(40);
      await Promise.all([database.ready, database.ready, database.ready]);
      expect(calls).toBe(2);
    } finally {
      await database.close();
    }
  });

  it("onReady 回调在首次就绪时触发一次，启动失败后也会后台重试直到就绪", async () => {
    let healthy = false;
    const database = createDatabase(UNREACHABLE_URL, {
      attempts: 1,
      retryCooldownMs: 20,
      check: async () => {
        if (!healthy) throw new Error("暂时不可达");
      },
    });
    try {
      let fired = 0;
      database.onReady(() => {
        fired += 1;
      });
      await Bun.sleep(50);
      expect(fired).toBe(0);
      healthy = true;
      // 没有任何请求访问 ready，后台重试也要把启动补齐的回调等到。
      await until("启动补齐回调没有被等到", () => fired > 0, { timeoutMs: 1_000 });
      expect(fired).toBe(1);
      await database.ready;
      await Bun.sleep(40);
      expect(fired).toBe(1);
      // 已就绪之后注册的回调立即（异步）触发。
      let late = 0;
      database.onReady(() => {
        late += 1;
      });
      await Bun.sleep(5);
      expect(late).toBe(1);
    } finally {
      await database.close();
    }
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
