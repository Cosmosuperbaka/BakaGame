import { describe, expect, it } from "bun:test";
import {
  LEGACY_REAL_CLIENT_IP_HEADER,
  REAL_CLIENT_IP_HEADER,
  resolveClientIp,
} from "../src/transport/ClientIp";

const headersOf = (entries: Record<string, string>) => new Headers(entries);

describe("来源 IP 解析", () => {
  it("优先采用 ESA 托管转换写入的真实客户端 IP", () => {
    const headers = headersOf({ "x-real-ip": "2409:874c:810:1f0:1001::148" });
    expect(resolveClientIp(headers, "10.0.0.9")).toBe("2409:874c:810:1f0:1001::148");
  });

  it("改名前的默认标头仍可识别", () => {
    expect(REAL_CLIENT_IP_HEADER).toBe("x-real-ip");
    expect(LEGACY_REAL_CLIENT_IP_HEADER).toBe("ali-real-client-ip");
    expect(resolveClientIp(headersOf({ "ali-real-client-ip": "203.0.113.9" }), "10.0.0.9")).toBe("203.0.113.9");
  });

  it("X-Forwarded-For 不参与，非 IP 字面量不做桶键", () => {
    const headers = headersOf({ "x-forwarded-for": "198.51.100.1, 127.0.0.1", "x-real-ip": "  " });
    expect(resolveClientIp(headers, "192.0.2.7")).toBe("192.0.2.7");
    expect(resolveClientIp(headersOf({ "x-real-ip": "1.2.3.4, 5.6.7.8" }), "192.0.2.7")).toBe("192.0.2.7");
    expect(resolveClientIp(headersOf({ "x-real-ip": "unknown" }), "192.0.2.7")).toBe("192.0.2.7");
  });

  it("标头缺失且没有 socket peer 时收敛到同一个 unknown 桶", () => {
    expect(resolveClientIp(headersOf({}), undefined)).toBe("unknown");
    expect(resolveClientIp(headersOf({}), null)).toBe("unknown");
  });

  it("IPv4 与 IPv6 之外的形态一律不采信", () => {
    for (const value of ["999.1.1.1", "::gggg", "01.2.3.4", "1.2.3", ""]) {
      expect(resolveClientIp(headersOf({ "x-real-ip": value }), "192.0.2.7")).toBe("192.0.2.7");
    }
  });
});

/**
 * 采信 `x-real-ip` 的前提是「源站只被边缘回源访问」（见 Agents/Deployment.md）。
 * 这个前提由防火墙/安全组保证，代码里没法验证，因此必须有一条不依赖它成立的兜底回归：
 * 假设攻击者直连源站并按需伪造标头自造新桶，单客户端额度形同虚设，
 * 但回源 peer 桶仍把这台机器上所有伪造来源的合计放行量封在十倍额度内。
 */
describe("源站被直连时的额度兜底", () => {
  it("轮换 x-real-ip 自造新桶，合计放行量仍被回源 peer 桶封顶，响应头点明是谁的额度用完", async () => {
    const { systemRoutes, TelemetryRateLimiter } = await import("../src/transport/routes/System");
    const app = systemRoutes({
      rateLimiter: new TelemetryRateLimiter({ windowMs: 60_000, ipMaxRequests: 2, peerMaxRequests: 6 }),
      sampleRate: 0,
    });
    let accepted = 0;
    let denied: Response | undefined;
    for (let index = 0; index < 40; index++) {
      const response = await app.handle(new Request("http://localhost/api/monitoring/telemetry", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": `203.0.113.${index + 1}` },
        body: JSON.stringify({ level: "error", message: `伪造来源${index}` }),
      }));
      if (response.status === 200) accepted += 1;
      else denied = response;
    }
    expect(accepted).toBe(6);
    expect(((await denied!.json()) as { error?: { code?: string } }).error?.code).toBe("RATE_LIMITED");
    expect(denied!.headers.get("x-ratelimit-limit")).toBe("6");
    expect(denied!.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(Number(denied!.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
