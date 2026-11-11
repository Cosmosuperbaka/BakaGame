import { describe, expect, test } from "bun:test";
import {
  DirectUpstreamStatusProbe,
  defaultUpstreamTargets,
  type DirectUpstreamTarget,
} from "../src/infrastructure/DirectUpstreamStatusProbe";
import {
  MockExternalStatusProbe,
  combineStatusProbes,
  type ExternalStatusProbe,
  type ExternalStatusReading,
} from "../src/infrastructure/ExternalStatusProbe";
import { BANGUMI_USER_AGENT } from "../src/infrastructure/BangumiUserAgent";
import {
  UPSTREAM_STATUS_COMPONENT_IDS,
  type UpstreamStatusComponentId,
} from "../src/shared/Status";

interface Call {
  url: string;
  init?: RequestInit;
}

const makeFetcher = (respond: (call: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const call: Call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, fetcher };
};

const probeTargets = Object.fromEntries(
  UPSTREAM_STATUS_COMPONENT_IDS.map((id) => [id, { url: `https://${id}.example.com/probe` }])
) as Record<UpstreamStatusComponentId, DirectUpstreamTarget>;

/** 按组件名从 URL 反查该回的状态码；未指明的回 200。 */
const respondWith =
  (statuses: Partial<Record<UpstreamStatusComponentId, number>>) => (call: Call) => {
    const id = UPSTREAM_STATUS_COMPONENT_IDS.find((item) =>
      call.url.includes(`${item}.example.com`)
    );
    return new Response(null, { status: (id ? statuses[id] : undefined) ?? 200 });
  };

describe("直连上游探针", () => {
  test("任何 <500 的响应都算在应答，且带延迟；5xx 降级无延迟", async () => {
    const { fetcher } = makeFetcher(
      respondWith({ bangumi: 200, qqmusic: 302, netease: 404, qq: 500 })
    );
    const probe = new DirectUpstreamStatusProbe({ targets: probeTargets, fetcher });
    const reading = await probe.read();
    expect(reading?.bangumi?.level).toBe("operational");
    expect(Number.isInteger(reading?.bangumi?.latencyMs)).toBe(true);
    expect(reading?.qqmusic?.level).toBe("operational");
    expect(reading?.netease?.level).toBe("operational");
    expect(reading?.qq).toEqual({ level: "degraded", latencyMs: null });
  });

  test("网络错误读作降级，延迟为 null", async () => {
    const { fetcher } = makeFetcher(() => {
      throw new Error("connect refused");
    });
    const probe = new DirectUpstreamStatusProbe({ targets: probeTargets, fetcher });
    const reading = await probe.read();
    for (const id of UPSTREAM_STATUS_COMPONENT_IDS) {
      expect(reading?.[id]).toEqual({ level: "degraded", latencyMs: null });
    }
  });

  test("每次请求都显式 redirect: manual，不交给运行时自动跟随", async () => {
    const { calls, fetcher } = makeFetcher(respondWith({}));
    const probe = new DirectUpstreamStatusProbe({ targets: probeTargets, fetcher });
    await probe.read();
    expect(calls).toHaveLength(UPSTREAM_STATUS_COMPONENT_IDS.length);
    for (const call of calls) {
      expect(call.init?.redirect).toBe("manual");
      expect(call.init?.method).toBe("GET");
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test("缺省目标：bangumi 带规范 UA，其余是各自实际请求的公网接口", () => {
    const defaults = defaultUpstreamTargets("https://api.bgm.example.com/");
    expect(defaults.bangumi.url).toBe("https://api.bgm.example.com/v0/subjects/1");
    expect(defaults.bangumi.headers).toEqual({ "User-Agent": BANGUMI_USER_AGENT });
    expect(defaults.qqmusic.url).toBe("https://u.y.qq.com/cgi-bin/musicu.fcg");
    expect(defaults.netease.url).toBe("https://music.163.com/api/");
    expect(defaults.qq.url).toBe("https://q1.qlogo.cn/g?b=qq&nk=10000&s=100");
  });

  test("请求带上目标的请求头；没有目标的组件不出现在读数里", async () => {
    const { calls, fetcher } = makeFetcher(respondWith({}));
    const probe = new DirectUpstreamStatusProbe({
      targets: { bangumi: defaultUpstreamTargets("https://api.bgm.example.com").bangumi },
      fetcher,
    });
    const reading = await probe.read();
    expect(calls[0].init?.headers).toEqual({ "User-Agent": BANGUMI_USER_AGENT });
    expect(Object.keys(reading ?? {})).toEqual(["bangumi"]);
  });

  test("整份读数按 cacheTtlMs 缓存，过期后再跑一轮", async () => {
    const { calls, fetcher } = makeFetcher(respondWith({}));
    let at = 1_000;
    const probe = new DirectUpstreamStatusProbe({
      targets: probeTargets,
      fetcher,
      now: () => at,
      cacheTtlMs: 60_000,
    });
    await probe.read();
    at += 30_000;
    await probe.read();
    expect(calls).toHaveLength(UPSTREAM_STATUS_COMPONENT_IDS.length);
    at += 40_000;
    await probe.read();
    expect(calls).toHaveLength(UPSTREAM_STATUS_COMPONENT_IDS.length * 2);
  });

  test("并发读共享同一轮在途探测", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, fetcher } = makeFetcher(async () => {
      await gate;
      return new Response(null, { status: 200 });
    });
    const probe = new DirectUpstreamStatusProbe({ targets: probeTargets, fetcher });
    const first = probe.read();
    const second = probe.read();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toHaveLength(UPSTREAM_STATUS_COMPONENT_IDS.length);
    expect(a).toEqual(b);
  });

  test("没有任何目标时回 null，不请求外网", async () => {
    const { calls, fetcher } = makeFetcher(respondWith({}));
    const reading = await new DirectUpstreamStatusProbe({ fetcher }).read();
    expect(reading).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

const staticProbe = (reading: ExternalStatusReading | null): ExternalStatusProbe => ({
  read: async () => reading,
});

describe("combineStatusProbes", () => {
  test("primary 有结论时等级以 primary 为准，延迟缺失由 fallback 补", async () => {
    const combined = combineStatusProbes(
      staticProbe({ bangumi: { level: "operational", latencyMs: null } }),
      staticProbe({ bangumi: { level: "degraded", latencyMs: 180 } })
    );
    expect(await combined.read()).toEqual({
      bangumi: { level: "operational", latencyMs: 180 },
    });
  });

  test("primary 为 unknown 时整体回落 fallback 读数，且不带上 primary 的延迟", async () => {
    const combined = combineStatusProbes(
      staticProbe({ qqmusic: { level: "unknown", latencyMs: 999 } }),
      staticProbe({ qqmusic: { level: "operational", latencyMs: 120 } })
    );
    expect(await combined.read()).toEqual({ qqmusic: { level: "operational", latencyMs: 120 } });
  });

  test("非 operational 的读数不带延迟", async () => {
    const combined = combineStatusProbes(
      staticProbe({ netease: { level: "degraded", latencyMs: 40 } }),
      staticProbe({ netease: { level: "operational", latencyMs: 60 } })
    );
    expect(await combined.read()).toEqual({ netease: { level: "degraded", latencyMs: null } });
  });

  test("一边缺席时只用另一边；两边都没有的组件不出键，全空回 null", async () => {
    const combined = combineStatusProbes(
      staticProbe({ bangumi: { level: "operational", latencyMs: 10 } }),
      new MockExternalStatusProbe()
    );
    expect(await combined.read()).toEqual({ bangumi: { level: "operational", latencyMs: 10 } });
    const bothEmpty = combineStatusProbes(
      new MockExternalStatusProbe(),
      new MockExternalStatusProbe()
    );
    expect(await bothEmpty.read()).toBeNull();
  });

  test("primary unknown 且 fallback 没有该组件时不出键", async () => {
    const combined = combineStatusProbes(
      staticProbe({ qq: { level: "unknown", latencyMs: null } }),
      new MockExternalStatusProbe()
    );
    expect(await combined.read()).toEqual({});
  });

  test("任一探针抛错按 null 处理，另一边照常出读数", async () => {
    const broken: ExternalStatusProbe = {
      read: async () => {
        throw new Error("monitor offline");
      },
    };
    const combined = combineStatusProbes(
      broken,
      staticProbe({ qq: { level: "operational", latencyMs: 30 } })
    );
    expect(await combined.read()).toEqual({ qq: { level: "operational", latencyMs: 30 } });
  });
});
