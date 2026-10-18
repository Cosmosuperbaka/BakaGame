import { describe, expect, test } from "bun:test";

import { WsHandshakeQuota } from "../src/transport/WsHandshakeQuota";

const quotaOf = (
  overrides: Partial<{
    windowMs: number;
    ipMaxRequests: number;
    globalMaxRequests: number;
    ipMaxConnections: number;
  }> = {}
) =>
  new WsHandshakeQuota({
    windowMs: 60_000,
    ipMaxRequests: 120,
    globalMaxRequests: 3_000,
    ipMaxConnections: 4,
    ...overrides,
  });

describe("WebSocket 握手配额", () => {
  test("在途连接占满即拒绝，归还后重新放行且不会重复扣减", () => {
    const quota = quotaOf();
    const slots = Array.from({ length: 4 }, () => quota.acquire("1.1.1.1", "1.1.1.1"));
    expect(slots.every((slot) => slot === "1.1.1.1")).toBe(true);
    expect(quota.acquire("1.1.1.1", "1.1.1.1")).toBeUndefined();
    expect(quota.liveConnections()).toBe(4);

    quota.release("1.1.1.1");
    expect(quota.acquire("1.1.1.1", "1.1.1.1")).toBe("1.1.1.1");
    // 未占过名额的键与重复归还都不能把计数压成负数。
    quota.release("9.9.9.9");
    quota.release("1.1.1.1");
    quota.release("1.1.1.1");
    quota.release("1.1.1.1");
    quota.release("1.1.1.1");
    expect(quota.liveConnections()).toBe(0);
    expect(quota.acquire("1.1.1.1", "1.1.1.1")).toBe("1.1.1.1");
  });

  test("单客户端新建速率独立于在途数：反复开合同样被封顶", () => {
    const quota = quotaOf({ ipMaxRequests: 2, ipMaxConnections: 100 });
    expect(quota.acquire("2.2.2.2", "2.2.2.2")).toBe("2.2.2.2");
    quota.release("2.2.2.2");
    expect(quota.acquire("2.2.2.2", "2.2.2.2")).toBe("2.2.2.2");
    quota.release("2.2.2.2");
    expect(quota.acquire("2.2.2.2", "2.2.2.2")).toBeUndefined();
  });

  test("伪造真实客户端地址自造新桶时，由回源 peer 的十倍额度封顶", () => {
    const quota = quotaOf({ ipMaxRequests: 2, ipMaxConnections: 100 });
    // peer 桶默认取单客户端十倍：20 次。用十个伪造地址各刷两次正好打满，第十一次起全拒。
    for (let index = 0; index < 20; index += 1) {
      expect(quota.acquire(`10.0.0.${index}`, "198.51.100.7")).toBe(`10.0.0.${index}`);
    }
    expect(quota.acquire("10.0.1.200", "198.51.100.7")).toBeUndefined();
    // 换回源地址即不受这个 peer 桶影响，说明桶键确实是来源身份而非客户端自报值。
    expect(quota.acquire("10.0.1.201", "198.51.100.8")).toBe("10.0.1.201");
  });

  test("全局额度打满后任何来源都拒绝，速率窗口滚过再恢复", () => {
    const quota = quotaOf({ ipMaxRequests: 100, globalMaxRequests: 3, ipMaxConnections: 100 });
    expect(quota.acquire("3.3.3.3", "3.3.3.3")).toBe("3.3.3.3");
    expect(quota.acquire("4.4.4.4", "4.4.4.4")).toBe("4.4.4.4");
    expect(quota.acquire("5.5.5.5", "5.5.5.5")).toBe("5.5.5.5");
    expect(quota.acquire("6.6.6.6", "6.6.6.6")).toBeUndefined();
  });
});
