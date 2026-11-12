import { afterEach, describe, expect, test } from "bun:test";

import { DatabaseWordBankRepository } from "../src/infrastructure/WordBankRepository";
import type { Database } from "../src/infrastructure/db/Database";

const failingDatabase = (error: Error) =>
  ({
    ready: Promise.resolve(),
    db: {
      insert: () => ({
        values: () => ({ onDuplicateKeyUpdate: () => Promise.reject(error) }),
      }),
    },
  }) as unknown as Database;

describe("词库仓储", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    unhandled.length = 0;
  });

  test("写库失败只通过返回的 Promise 上报，不额外产生未处理拒绝", async () => {
    process.on("unhandledRejection", onUnhandled);
    const repository = new DatabaseWordBankRepository(failingDatabase(new Error("写库失败")));

    await expect(repository.savePair(["苹果", "香蕉"])).rejects.toThrow("写库失败");
    // 给内部登记的跟踪 Promise 足够的时间触发（若它也拒绝，事件会落在这几个宏任务内）。
    await Bun.sleep(20);

    expect(unhandled).toEqual([]);
    await repository.drainWrites();
  });
});
