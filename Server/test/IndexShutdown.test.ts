import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { HTTP_MAX_REQUEST_BODY_BYTES } from "../src/config/Constants";
import {
  createIndexShutdownHarness,
  finalStages,
  type Stage,
} from "./fixtures/IndexShutdownHarness";

const completed = (calls: string[]) =>
  calls.filter((call) => call.endsWith(":end")).map((call) => call.slice(0, -4));
const assertTimers = (harness: Awaited<ReturnType<typeof createIndexShutdownHarness>>) => {
  expect(harness.intervals).toHaveLength(3);
  expect(harness.intervals.map((timer) => timer.cleared)).toEqual([1, 1, 1]);
  expect(harness.timeouts).toHaveLength(1);
  // 看门狗必须与预算常量同源，且不得 unref（unref 后事件循环转空时它不会触发 → 假成功）。
  expect(harness.timeouts[0]).toMatchObject({
    ms: harness.budgetMs,
    unrefed: false,
    cleared: 1,
  });
};

/** 编排侧的停止宽限：从部署工作流的内嵌脚本里读，避免进程预算与容器宽限各写一处数字。 */
const deploymentStopGraceSeconds = async (): Promise<number> => {
  const workflow = await Bun.file(
    resolve(import.meta.dir, "../../.github/workflows/deploy.yml")
  ).text();
  const raw = /^\s*SHUTDOWN_STOP_GRACE_S=(\d+)(?:\s|$)/m.exec(workflow)?.[1];
  if (raw === undefined) throw new Error("部署脚本缺少 SHUTDOWN_STOP_GRACE_S");
  return Number(raw);
};

test("真实 Index：停机总预算严格小于容器停止宽限，重启显式带上该宽限", async () => {
  const harness = await createIndexShutdownHarness();
  const graceSeconds = await deploymentStopGraceSeconds();
  expect(harness.budgetMs).toBeLessThan(graceSeconds * 1000);
  const workflow = await Bun.file(
    resolve(import.meta.dir, "../../.github/workflows/deploy.yml")
  ).text();
  expect(workflow).toContain('sudo docker restart -t "$SHUTDOWN_STOP_GRACE_S" "$SHARD"');
});

test("真实 Index：启动监听带上请求体上限", async () => {
  const harness = await createIndexShutdownHarness();
  expect(harness.listenOptions).toEqual([
    { hostname: "127.0.0.1", port: 1, maxRequestBodySize: HTTP_MAX_REQUEST_BODY_BYTES },
  ]);
});

test("真实 Index：预通知只摘流，之后 SIGTERM 完整停机一次且等待所有资源", async () => {
  const harness = await createIndexShutdownHarness({
    hold: [
      "buffer",
      "drain.faker",
      "drain.records",
      "stop",
      "dispose",
      "otlp",
      "sentry.flush",
      "sentry.close",
    ],
  });
  expect(harness.isShuttingDown()).toBe(false);
  await harness.preNotify();
  await harness.preNotify();
  expect(harness.isShuttingDown()).toBe(true);
  expect(harness.task).toBeUndefined();
  expect(harness.calls).toEqual([]);
  expect(harness.exits).toEqual([]);
  expect(harness.intervals.every((timer) => timer.cleared === 0)).toBe(true);

  harness.signal("SIGTERM");
  const task = harness.task!;
  expect(task).toBeDefined();
  expect(harness.shutdown("SIGINT")).toBe(task);
  harness.signal("SIGTERM");
  harness.signal("SIGINT");

  const awaitedStages: Stage[] = [
    "buffer",
    "drain.faker",
    "drain.records",
    "stop",
    "dispose",
    "otlp",
    "sentry.flush",
    "sentry.close",
  ];
  for (const stage of awaitedStages) {
    await harness.started(stage);
    const position = finalStages.indexOf(stage);
    expect(completed(harness.calls)).toEqual(finalStages.slice(0, position));
    expect(harness.exits).toEqual([]);
    expect(harness.timeouts[0]).toMatchObject({ ms: harness.budgetMs, unrefed: false, cleared: 0 });
    harness.signal("SIGTERM");
    expect(harness.task).toBe(task);
    harness.release(stage);
  }
  await task;
  expect(completed(harness.calls)).toEqual([...finalStages]);
  expect(harness.calls).toContain("buffer:start:3000");
  // 排空集合覆盖到每一步：词对队列与共享的对局记录队列都被等到清零，不是只排一款游戏。
  expect(harness.calls).toContain("drain.faker:start");
  expect(harness.calls).toContain("drain.faker:end");
  expect(harness.calls).toContain("drain.records:start");
  expect(harness.calls).toContain("drain.records:end");
  expect(harness.calls).toContain("stop:start:true");
  expect(harness.calls).toContain("sentry.flush:start:2000");
  expect(harness.calls).toContain("sentry.close:start:2000");
  expect(harness.exits).toEqual([0]);
  assertTimers(harness);
  harness.signal("SIGINT");
  await harness.task;
  expect(harness.exits).toEqual([0]);
});

test("真实 Index：无预通知的 signal 同样立即摘流，未配置 OTLP 仍关闭 Sentry", async () => {
  const harness = await createIndexShutdownHarness({ otlpEnabled: false });
  harness.signal();
  expect(harness.isShuttingDown()).toBe(true);
  await harness.task;
  expect(completed(harness.calls)).toEqual(finalStages.filter((stage) => stage !== "otlp"));
  expect(harness.exits).toEqual([0]);
  assertTimers(harness);
});

for (const stage of finalStages) {
  test(`真实 Index：${stage} 拒绝不跳过其他清理，最终非零退出`, async () => {
    const harness = await createIndexShutdownHarness({ failures: { [stage]: "throw" } });
    await harness.preNotify();
    harness.signal();
    await harness.task;
    expect(
      harness.calls.filter((call) => call.includes(":start")).map((call) => call.split(":")[0])
    ).toEqual([...finalStages]);
    expect(completed(harness.calls)).toEqual(finalStages.filter((item) => item !== stage));
    expect(harness.exits).toEqual([1]);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "优雅停机步骤失败",
        details: expect.objectContaining({
          stage,
          message: `injected:${stage}`,
          stack: expect.any(String),
          cause: expect.any(Error),
        }),
      })
    );
    assertTimers(harness);
  });
}

for (const stage of ["sentry.flush", "sentry.close"] as const) {
  test(`真实 Index：${stage} 返回 false 也视为失败并继续 close`, async () => {
    const harness = await createIndexShutdownHarness({ failures: { [stage]: "false" } });
    harness.signal();
    await harness.task;
    expect(completed(harness.calls)).toEqual([...finalStages]);
    expect(harness.exits).toEqual([1]);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        message: "优雅停机清理完成但存在失败",
        details: { failedStages: [stage] },
      })
    );
    assertTimers(harness);
  });
}

test("真实 Index：多个资源同时失败，仍 await Sentry close 且只退出一次", async () => {
  const harness = await createIndexShutdownHarness({
    failures: {
      "drain.faker": "throw",
      "drain.records": "throw",
      stop: "throw",
      dispose: "throw",
      otlp: "throw",
      "sentry.flush": "false",
    },
    hold: ["sentry.close"],
  });
  harness.signal();
  await harness.started("sentry.close");
  harness.signal("SIGINT");
  expect(harness.exits).toEqual([]);
  harness.release("sentry.close");
  await harness.task;
  expect(harness.exits).toEqual([1]);
  expect(harness.logs).toContainEqual(
    expect.objectContaining({
      message: "优雅停机清理完成但存在失败",
      details: {
        failedStages: ["drain.faker", "drain.records", "stop", "dispose", "otlp", "sentry.flush"],
      },
    })
  );
  assertTimers(harness);
});

test("真实 Index：挂起 I/O 由唯一且不 unref 的总预算看门狗兜底，到点强制终止并非零退出", async () => {
  const harness = await createIndexShutdownHarness({ hold: ["drain.faker"] });
  harness.signal();
  await harness.started("drain.faker");
  harness.signal("SIGINT");
  expect(harness.timeouts).toHaveLength(1);
  expect(harness.timeouts[0]).toMatchObject({
    ms: harness.budgetMs,
    unrefed: false,
    cleared: 0,
  });
  expect(harness.exits).toEqual([]);
  harness.timeouts[0].fire();
  expect(harness.exits).toEqual([1]);
  // 强制终止必须留下可读证据：预算数字与已完成/未完成阶段都进同一条日志。
  expect(harness.logs).toContainEqual(
    expect.objectContaining({
      level: "error",
      message: `优雅停机超时 (${harness.budgetMs / 1000}s)，强制终止进程`,
      details: expect.objectContaining({
        budgetMs: harness.budgetMs,
        completedStages: ["notify.faker", "notify.song", "notify.cee", "buffer"],
        failedStages: [],
      }),
    })
  );
  expect(completed(harness.calls)).toEqual(finalStages.slice(0, 4));
  // VM exit 仅记录不会终止测试进程；释放夹具，不把后续模拟完成冒充真实看门狗后的执行。
  harness.release("drain.faker");
  await harness.task;
});

test("真实 Index：未捕获异常与 signal 共享任务和清理，不产生重复退出", async () => {
  const harness = await createIndexShutdownHarness({ hold: ["drain.faker"] });
  harness.fatal(new Error("fixture fatal"));
  const task = harness.task!;
  await harness.started("drain.faker");
  harness.signal();
  expect(harness.task).toBe(task);
  harness.release("drain.faker");
  await task;
  expect(completed(harness.calls)).toEqual([...finalStages]);
  expect(harness.exits).toHaveLength(1);
  assertTimers(harness);
});
