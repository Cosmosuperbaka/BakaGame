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
