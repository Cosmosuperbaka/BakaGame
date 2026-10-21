import { describe, expect, test } from "bun:test";
import {
  aggregateBetterStackMonitors,
  BetterStackStatusProbe,
} from "../src/infrastructure/BetterStackStatusProbe";

const monitor = (status: string, paused = false) => ({ attributes: { status, paused } });
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Better Stack 外部监测探针", () => {
  test("按只读令牌请求 monitors，全部 up 为正常", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = String((init?.headers as Record<string, string>).Authorization);
      return json([monitor("up")]);
    }) as unknown as typeof fetch;
    const probe = new BetterStackStatusProbe({
      apiKey: "test-token",
      fetcher,
      baseUrl: "https://status.example.com/api/v2/",
    });

    expect(await probe.read()).toBe("operational");
    expect(seenUrl).toBe("https://status.example.com/api/v2/monitors");
    expect(seenAuth).toBe("Bearer test-token");
  });

  test("任一 monitor down 即异常，暂停或未知不替它下结论", () => {
    expect(aggregateBetterStackMonitors([monitor("up"), monitor("up")])).toBe("operational");
    expect(aggregateBetterStackMonitors([monitor("up"), monitor("down")])).toBe("degraded");
    expect(aggregateBetterStackMonitors([monitor("down"), monitor("up", true)])).toBe("degraded");
    expect(aggregateBetterStackMonitors([monitor("up"), monitor("up", true)])).toBe("unknown");
    expect(aggregateBetterStackMonitors([monitor("up"), monitor("pending")])).toBe("unknown");
    expect(aggregateBetterStackMonitors([])).toBeNull();
    expect(aggregateBetterStackMonitors(null)).toBeNull();
    expect(aggregateBetterStackMonitors([{}, "bad"])).toBe("unknown");
  });

  test("上游异常时回未知，且失败结果不缓存", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      if (calls === 1) return new Response("{}", { status: 503 });
      return json([monitor("up")]);
    }) as unknown as typeof fetch;
    const probe = new BetterStackStatusProbe({ apiKey: "test-token", fetcher });

    expect(await probe.read()).toBeNull();
    expect(await probe.read()).toBe("operational");
    expect(calls).toBe(2);
  });

  test("网络异常时回未知", async () => {
    const probe = new BetterStackStatusProbe({
      apiKey: "test-token",
      fetcher: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(await probe.read()).toBeNull();
  });

  test("成功结果短时缓存，过期后重新请求", async () => {
    let calls = 0;
    let clock = 1_000;
    const probe = new BetterStackStatusProbe({
      apiKey: "test-token",
      now: () => clock,
      cacheTtlMs: 30_000,
      fetcher: (async () => {
        calls += 1;
        return json([monitor("up")]);
      }) as unknown as typeof fetch,
    });

    expect(await probe.read()).toBe("operational");
    clock += 10_000;
    expect(await probe.read()).toBe("operational");
    expect(calls).toBe(1);

    clock += 30_000;
    expect(await probe.read()).toBe("operational");
    expect(calls).toBe(2);
  });
});
