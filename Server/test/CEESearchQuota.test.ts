import { describe, expect, test } from "bun:test";
import { CEEService } from "../src/application/CEEService";
import {
  CEE_SEARCH_CONNECTION_MAX,
  CEE_SEARCH_IP_MULTIPLIER,
  CEE_SEARCH_WINDOW_MS,
  CEE_SUBJECT_CHARACTERS_CONNECTION_MAX,
  CEESearchQuota,
  isCEESearchCommand,
  type CEESearchCommand,
} from "../src/application/CEESearchQuota";
import { AppError } from "../src/domain/Errors";
import { EventLogger } from "../src/infrastructure/EventLogger";
import type { ConnectionRecord } from "../src/shared/Index";
import { originalData } from "./CEEOriginalFixtures";

/** 配额只用到 `id` 与 `clientIp` 两个字段，其余按最小形状构造。 */
const connection = (id: string, clientIp?: string): ConnectionRecord => ({
  id,
  ...(clientIp ? { clientIp } : {}),
  lobbySubscribed: false,
  send: () => {},
  close: () => {},
});

const harness = (connectionMax = 3) => {
  let clock = 1_000_000;
  const quota = new CEESearchQuota(() => clock, { connectionMax });
  return {
    clock: () => clock,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    quota,
  };
};

const attempt = (quota: CEESearchQuota, type: CEESearchCommand, record: ConnectionRecord) => {
  try {
    quota.require(type, record);
    return "allowed" as const;
  } catch (error) {
    if (error instanceof AppError && error.code === "RATE_LIMITED") return "limited" as const;
    throw error;
  }
};

describe("CEESearchQuota", () => {
  test("单条连接超出额度即拒绝，且拒绝发生在回源之前", () => {
    const { quota } = harness(3);
    const record = connection("c1", "1.1.1.1");
    for (let i = 0; i < 3; i++)
      expect(attempt(quota, "cee.character.search", record)).toBe("allowed");
    expect(attempt(quota, "cee.character.search", record)).toBe("limited");
  });

  test("窗口滑出后额度恢复：被拒不是永久封禁", () => {
    const { quota, advance } = harness(2);
    const record = connection("c1", "1.1.1.1");
    quota.require("cee.subject.search", record);
    quota.require("cee.subject.search", record);
    expect(attempt(quota, "cee.subject.search", record)).toBe("limited");
    // 恰好滑出一个窗口：最早那两次请求不再计数。
    advance(CEE_SEARCH_WINDOW_MS);
    expect(attempt(quota, "cee.subject.search", record)).toBe("allowed");
  });

  test("三条命令分开计数，一种用完不影响另一种", () => {
    const { quota } = harness(1);
    const record = connection("c1", "1.1.1.1");
    expect(attempt(quota, "cee.character.search", record)).toBe("allowed");
    expect(attempt(quota, "cee.character.search", record)).toBe("limited");
    expect(attempt(quota, "cee.subject.search", record)).toBe("allowed");
    expect(attempt(quota, "cee.subject.characters", record)).toBe("allowed");
  });

  test("作品角色列表只给检索的一半额度", () => {
    expect(CEE_SUBJECT_CHARACTERS_CONNECTION_MAX).toBe(CEE_SEARCH_CONNECTION_MAX / 2);
    const { quota } = harness(4);
    const record = connection("c1", "1.1.1.1");
    // connectionMax 为 4 时列表桶为 2，比另两条先耗尽。
    expect(attempt(quota, "cee.subject.characters", record)).toBe("allowed");
    expect(attempt(quota, "cee.subject.characters", record)).toBe("allowed");
    expect(attempt(quota, "cee.subject.characters", record)).toBe("limited");
    expect(attempt(quota, "cee.character.search", record)).toBe("allowed");
  });

  test("多开连接被同一来源地址聚合封顶，而不是按连接线性放大", () => {
    const { quota } = harness(3);
    const records = Array.from({ length: 15 }, (_, index) => connection(`c${index}`, "2.2.2.2"));
    let allowed = 0;
    for (let round = 0; round < 3; round++)
      for (const record of records)
        if (attempt(quota, "cee.character.search", record) === "allowed") allowed++;
    // 15 条连接各有 3 份额度（45 次），但地址桶封顶在 3 × 10 = 30 次。
    expect(allowed).toBe(3 * CEE_SEARCH_IP_MULTIPLIER);
  });

  test("来源地址缺席时只按连接计，不得因无 IP 而整体放行", () => {
    const { quota } = harness(2);
    const record = connection("c1");
    expect(attempt(quota, "cee.character.search", record)).toBe("allowed");
    expect(attempt(quota, "cee.character.search", record)).toBe("allowed");
    expect(attempt(quota, "cee.character.search", record)).toBe("limited");
  });

  test("桶键基数受上限约束：伪造连接号不能按需扩张内存", () => {
    const clock = 1_000_000;
    const quota = new CEESearchQuota(() => clock, { connectionMax: 1000, maxKeys: 16 });
    for (let index = 0; index < 400; index++)
      quota.require("cee.character.search", connection(`spoof-${index}`, `10.0.0.${index % 97}`));
    expect(quota.trackedKeys).toBeLessThanOrEqual(16 * 6);
  });

  test("reset 清空全部桶", () => {
    const { quota } = harness(1);
    const record = connection("c1", "1.1.1.1");
    quota.require("cee.character.search", record);
    expect(attempt(quota, "cee.character.search", record)).toBe("limited");
    quota.reset();
    expect(attempt(quota, "cee.character.search", record)).toBe("allowed");
  });

  test("只有三条枚举命令参与配额", () => {
    expect(isCEESearchCommand("cee.character.search")).toBe(true);
    expect(isCEESearchCommand("cee.subject.search")).toBe(true);
    expect(isCEESearchCommand("cee.subject.characters")).toBe(true);
    expect(isCEESearchCommand("cee.subject.lookup")).toBe(false);
    expect(isCEESearchCommand("cee.game.guess")).toBe(false);
  });
});

describe("CEE 检索限流接入命令入口", () => {
  const searchMessage = (id: string) =>
    ({
      id,
      type: "cee.character.search",
      payload: { keyword: "测试" },
    }) as const;

  test("CEEService 在派发前扣额度，超限回 RATE_LIMITED", async () => {
    const clock = 1_000_000;
    const service = new CEEService({
      data: originalData,
      now: () => clock,
      eventLogger: new EventLogger(() => {}),
    });
    const record = connection("quota-connection", "3.3.3.3");
    service.registerConnection(record);

    const codes: string[] = [];
    for (let index = 0; index <= CEE_SEARCH_CONNECTION_MAX; index++) {
      try {
        await service.execute(record.id, searchMessage(`m${index}`));
        codes.push("ok");
      } catch (error) {
        codes.push(error instanceof AppError ? error.code : "unknown");
      }
    }
    // 扣额度发生在派发之前：未入房的连接每发一次都消耗一份配额，
    // 因此第 61 次拿到的不是业务错误而是限流错误。
    expect(codes.slice(0, CEE_SEARCH_CONNECTION_MAX)).toEqual(
      Array.from({ length: CEE_SEARCH_CONNECTION_MAX }, () => "ROOM_NOT_FOUND")
    );
    expect(codes[CEE_SEARCH_CONNECTION_MAX]).toBe("RATE_LIMITED");
    await service.close();
  });
});
