import { describe, expect, it } from "bun:test";
import { AppError } from "../src/domain/Errors";
import { NeteaseMusicProvider } from "../src/infrastructure/NeteaseMusicProvider";
import { UpstreamRequestQueue } from "../src/infrastructure/UpstreamRequestQueue";

interface CooldownRecord {
  scope?: string;
  strikes: number;
  durationMs: number;
}

/** 限流判定：任务结果或异常是 `{ limited: true }` 即算上游限流。 */
const isLimited = (value: unknown) =>
  typeof value === "object" && value !== null && (value as { limited?: boolean }).limited === true;

const createQueue = (
  overrides: Partial<ConstructorParameters<typeof UpstreamRequestQueue>[0]> = {},
  records: CooldownRecord[] = []
) =>
  new UpstreamRequestQueue({
    now: () => Date.now(),
    random: { nextFloat: () => 0 },
    minRequestIntervalMs: 0,
    rateLimitCooldownMs: 60_000,
    maxRateLimitCooldownMs: 600_000,
    queueFullMessage: "排队过多",
    queueTimeoutMessage: "等待超时",
    requestTimeoutMessage: "请求超时",
    rateLimitFallbackMessage: "操作频繁",
    isRateLimitError: isLimited,
    onRateLimitCooldown: ({ scope, strikes, cooldownDurationMs }) =>
      records.push({ scope, strikes, durationMs: cooldownDurationMs }),
    createBusyError: (message, retryAfterMs) =>
      new AppError("MUSIC_API_BUSY", message, { retryAfterMs }),
    createRateLimitError: (message, retryAfterMs) =>
      new AppError("MUSIC_API_RATE_LIMITED", message, { retryAfterMs }),
    createTimeoutError: (message) => new AppError("MUSIC_API_TIMEOUT", message),
    ...overrides,
  });

const never = () => new Promise<never>(() => {});

describe("上游请求队列：已开始任务的运行时限", () => {
  it("永不落定的任务占满并发槽，时限后以超时错误结算并释放槽位", async () => {
    const queue = createQueue({ maxConcurrentRequests: 3, requestTimeoutMs: 30 });

    const hung = [0, 1, 2].map((index) =>
      queue.scheduleRequest(never, `scope:${index}`).catch((error: unknown) => error)
    );
    const results = await Promise.all(hung);
    for (const result of results) {
      expect(result).toBeInstanceOf(AppError);
      expect(result).toMatchObject({ code: "MUSIC_API_TIMEOUT", message: "请求超时" });
    }

    // 三个槽都已释放：后续请求立即可跑，而不是在排队里等到 queueTimeout。
    await expect(queue.scheduleRequest(async () => "ok", "scope:3")).resolves.toBe("ok");
    expect(queue.queuedCount).toBe(0);
  });

  it("迟到的结果被丢弃：不改结算，也不触发限流退避，更不会二次释放槽位", async () => {
    const records: CooldownRecord[] = [];
    const queue = createQueue({ maxConcurrentRequests: 1, requestTimeoutMs: 20 }, records);

    let releaseLate: (value: unknown) => void = () => {};
    const late = new Promise((resolve) => {
      releaseLate = resolve;
    });
    await expect(queue.scheduleRequest(() => late, "scope:a")).rejects.toMatchObject({
      code: "MUSIC_API_TIMEOUT",
    });

    // 迟到的是一个限流结果：任务早已被判超时，不得再把该作用域推进退避。
    releaseLate({ limited: true });
    await Bun.sleep(5);
    expect(queue.isCoolingDown()).toBe(false);
    expect(records).toEqual([]);

    // 槽位只释放一次：并发 1 时，后续两个任务必须串行执行。
    let running = 0;
    let maxRunning = 0;
    const slow = async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await Bun.sleep(5);
      running -= 1;
      return "done";
    };
    await Promise.all([queue.scheduleRequest(slow), queue.scheduleRequest(slow)]);
    expect(maxRunning).toBe(1);
  });

  it("时限内正常完成的任务不受影响，计时器不残留", async () => {
    const queue = createQueue({ requestTimeoutMs: 20 });
    await expect(queue.scheduleRequest(async () => 42)).resolves.toBe(42);
    await Bun.sleep(40);
    await expect(queue.scheduleRequest(async () => 43)).resolves.toBe(43);
  });
});

describe("网易云 provider：挂起的上游请求不拖垮后续请求", () => {
  it("连续挂起占满并发槽后，普通检索仍能成功", async () => {
    let calls = 0;
    const provider = new NeteaseMusicProvider({
      maxConcurrentRequests: 1,
      minRequestIntervalMs: 0,
      requestTimeoutMs: 30,
      queueTimeoutMs: 5_000,
      loadApi: async () => ({
        cloudsearch: async () => {
          calls += 1;
          if (calls <= 2) return never();
          return { body: { code: 200, result: { songs: [] } } };
        },
      }),
    });

    for (const keyword of ["挂起甲", "挂起乙"]) {
      await expect(provider.search(keyword)).rejects.toMatchObject({ code: "MUSIC_API_TIMEOUT" });
    }
    await expect(provider.search("正常关键词")).resolves.toEqual([]);
  });
});
