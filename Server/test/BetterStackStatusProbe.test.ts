import { describe, expect, test } from "bun:test";
import {
  BetterStackStatusProbe,
  monitorReadings,
} from "../src/infrastructure/BetterStackStatusProbe";

/** 夹具假令牌：仅供本文件构造探针，不是任何环境的真实凭据。 */
const fixtureToken = ["test", "token"].join("-");
const monitor = (
  status: string,
  paused = false,
  averageResponseTime?: number | string,
  id = "1"
) => ({
  id,
  attributes: {
    status,
    paused,
    ...(averageResponseTime === undefined ? {} : { average_response_time: averageResponseTime }),
  },
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });

const monitors = { bangumi: "111", qqmusic: "222", netease: "333", qq: "444" };

describe("Better Stack 外部监测探针", () => {
  test("按只读令牌请求 monitors，映射到的组件各自读出等级与延迟", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = String((init?.headers as Record<string, string>).Authorization);
      return json([
        monitor("up", false, 132.4, "111"),
        monitor("down", false, 900, "222"),
        monitor("up", false, undefined, "333"),
        monitor("up", false, "210", "444"),
        monitor("up", false, 50, "999"),
      ]);
    }) as unknown as typeof fetch;
    const probe = new BetterStackStatusProbe({
      apiKey: fixtureToken,
      monitors,
      fetcher,
      baseUrl: "https://status.example.com/api/v2/",
    });

    const reading = await probe.read();
    expect(seenUrl).toBe("https://status.example.com/api/v2/monitors?page[size]=100");
    expect(seenAuth).toBe(`Bearer ${fixtureToken}`);
    expect(reading).toEqual({
      bangumi: { level: "operational", latencyMs: 132 },
      qqmusic: { level: "degraded", latencyMs: null },
      netease: { level: "operational", latencyMs: null },
      qq: { level: "operational", latencyMs: 210 },
    });
  });

  test("未映射的组件不出现，暂停与未知不替它下结论", () => {
    expect(monitorReadings([monitor("up")], { bangumi: "1" })).toEqual({
      bangumi: { level: "operational", latencyMs: null },
    });
    expect(monitorReadings([monitor("up", true)], { bangumi: "1" })).toEqual({
      bangumi: { level: "unknown", latencyMs: null },
    });
    expect(monitorReadings([monitor("pending")], { bangumi: "1" })).toEqual({
      bangumi: { level: "unknown", latencyMs: null },
    });
    expect(monitorReadings([monitor("up")], {})).toEqual({});
    expect(monitorReadings(null, monitors)).toEqual({});
    expect(monitorReadings([{}, "bad"], monitors)).toEqual({});
    // 非法的延迟读数不编造：字符串数字可解析，解析不了的读作没有延迟。
    expect(monitorReadings([monitor("up", false, "fast")], { bangumi: "1" })).toEqual({
      bangumi: { level: "operational", latencyMs: null },
    });
  });

  test("上游异常时回未知，且失败结果不缓存", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      if (calls === 1) return new Response("{}", { status: 503 });
      return json([monitor("up", false, 100, "111")]);
    }) as unknown as typeof fetch;
    const probe = new BetterStackStatusProbe({ apiKey: fixtureToken, monitors, fetcher });

    expect(await probe.read()).toBeNull();
    expect(await probe.read()).toEqual({ bangumi: { level: "operational", latencyMs: 100 } });
    expect(calls).toBe(2);
  });

  test("网络异常时回未知", async () => {
    const probe = new BetterStackStatusProbe({
      apiKey: fixtureToken,
      monitors,
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
      apiKey: fixtureToken,
      monitors: { bangumi: "1" },
      now: () => clock,
      cacheTtlMs: 30_000,
      fetcher: (async () => {
        calls += 1;
        return json([monitor("up", false, 100, "1")]);
      }) as unknown as typeof fetch,
    });

    expect(await probe.read()).toEqual({ bangumi: { level: "operational", latencyMs: 100 } });
    clock += 10_000;
    expect(await probe.read()).toEqual({ bangumi: { level: "operational", latencyMs: 100 } });
    expect(calls).toBe(1);

    clock += 30_000;
    expect(await probe.read()).toEqual({ bangumi: { level: "operational", latencyMs: 100 } });
    expect(calls).toBe(2);
  });
});
