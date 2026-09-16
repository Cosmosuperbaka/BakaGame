import { describe, expect, test } from "bun:test";
import { CCBOriginalReporter } from "../src/infrastructure/CCBOriginalReporter";

describe("CCBOriginalReporter", () => {
  test("按原版契约上报出题数与猜测数", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
    };
    const reporter = new CCBOriginalReporter({ serverUrl: "https://ccb.example.com/", fetcher });

    await reporter.report("answer", { id: 12393, name: "牧濑红莉栖" });
    await reporter.report("guess", { id: 1, name: "鲁路修·兰佩路基" });

    expect(calls).toEqual([
      { url: "https://ccb.example.com/api/answer-character-count", body: { characterId: 12393, characterName: "牧濑红莉栖" } },
      { url: "https://ccb.example.com/api/guess-character-count", body: { characterId: 1, characterName: "鲁路修·兰佩路基" } },
    ]);
  });

  test("未配置服务器地址或角色非法时不发请求", async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return new Response("{}", { status: 200 }); };

    const disabled = new CCBOriginalReporter({ serverUrl: "", fetcher });
    await disabled.report("answer", { id: 12393, name: "牧濑红莉栖" });

    const reporter = new CCBOriginalReporter({ serverUrl: "https://ccb.example.com", fetcher });
    await reporter.report("answer", { id: 0, name: "牧濑红莉栖" });
    await reporter.report("answer", { id: 1.5, name: "牧濑红莉栖" });
    await reporter.report("answer", { id: 12393, name: "" });

    expect(calls).toBe(0);
  });

  test("原版服务器不可达只记日志，绝不抛出", async () => {
    const logged: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const reporter = new CCBOriginalReporter({
      serverUrl: "https://ccb.example.com",
      logger: { error: (message, context) => logged.push({ message, context }) },
      fetcher: async () => { throw new Error("connect timeout"); },
    });

    // 统计是旁路，绝不能因为它失败而中断对局
    await reporter.report("guess", { id: 12393, name: "牧濑红莉栖" });
    expect(logged.length).toBe(1);
    expect(logged[0].message).toContain("上报原版角色统计失败");
    expect(logged[0].context).toMatchObject({ kind: "guess", characterId: 12393 });

    // 非 2xx 同样只记日志
    const failing = new CCBOriginalReporter({
      serverUrl: "https://ccb.example.com",
      logger: { error: (message, context) => logged.push({ message, context }) },
      fetcher: async () => new Response("boom", { status: 500 }),
    });
    await failing.report("answer", { id: 1, name: "鲁路修·兰佩路基" });
    expect(logged.length).toBe(2);
  });
});
