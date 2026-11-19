import { describe, expect, test } from "bun:test";

import { WsHandshakeQuota } from "../src/transport/WsHandshakeQuota";

const quotaOf = (
  overrides: Partial<{
    windowMs: number;
    ipMaxRequests: number;
    globalMaxRequests: number;
    ipMaxConnections: number;
    leaseMs: number;
  }> = {}
) =>
  new WsHandshakeQuota({
    windowMs: 60_000,
    ipMaxRequests: 120,
    globalMaxRequests: 3_000,
    ipMaxConnections: 4,
    ...overrides,
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("WebSocket 握手配额", () => {
  test("在途连接占满即拒绝，归还后重新放行且不会重复扣减", () => {
    const quota = quotaOf();
    const leases = Array.from({ length: 4 }, () => quota.reserve("1.1.1.1", "1.1.1.1"));
    expect(leases.every((lease) => lease !== undefined)).toBe(true);
    expect(quota.reserve("1.1.1.1", "1.1.1.1")).toBeUndefined();
    expect(quota.liveConnections()).toBe(4);

    leases[0]!.release();
    const again = quota.reserve("1.1.1.1", "1.1.1.1");
    expect(again).toBeDefined();
    // 重复归还同一份租约不能把计数压成负数，也不能挤掉别人的名额。
    for (let index = 0; index < 4; index += 1) leases[0]!.release();
    expect(quota.liveConnections()).toBe(4);
    for (const lease of [...leases.slice(1), again]) lease!.release();
    expect(quota.liveConnections()).toBe(0);
  });

  test("未确认的租约到期自动归还，确认过的不会过期", async () => {
    const quota = quotaOf({ leaseMs: 20 });
    const abandoned = quota.reserve("1.1.1.1", "1.1.1.1");
    const confirmed = quota.reserve("1.1.1.1", "1.1.1.1");
    confirmed!.confirm();
    expect(quota.liveConnections()).toBe(2);

    await sleep(60);
    expect(quota.liveConnections()).toBe(1);
    // 到期后再归还是空操作，不会多扣。
    abandoned!.release();
    expect(quota.liveConnections()).toBe(1);
    confirmed!.release();
    expect(quota.liveConnections()).toBe(0);
  });

  test("到期之后才打开的连接重新记上名额，关闭时归还", async () => {
    const quota = quotaOf({ leaseMs: 10 });
    const lease = quota.reserve("1.1.1.1", "1.1.1.1");
    await sleep(40);
    expect(quota.liveConnections()).toBe(0);
    lease!.confirm();
    expect(quota.liveConnections()).toBe(1);
    lease!.confirm();
    expect(quota.liveConnections()).toBe(1);
    lease!.release();
    expect(quota.liveConnections()).toBe(0);
  });

  test("单客户端新建速率独立于在途数：反复开合同样被封顶", () => {
    const quota = quotaOf({ ipMaxRequests: 2, ipMaxConnections: 100 });
    quota.reserve("2.2.2.2", "2.2.2.2")!.release();
    quota.reserve("2.2.2.2", "2.2.2.2")!.release();
    expect(quota.reserve("2.2.2.2", "2.2.2.2")).toBeUndefined();
  });

  test("伪造真实客户端地址自造新桶时，由回源 peer 的十倍额度封顶", () => {
    const quota = quotaOf({ ipMaxRequests: 2, ipMaxConnections: 100 });
    // peer 桶默认取单客户端十倍：20 次。用二十个伪造地址各刷一次正好打满，第二十一次起全拒。
    for (let index = 0; index < 20; index += 1) {
      expect(quota.reserve(`10.0.0.${index}`, "198.51.100.7")).toBeDefined();
    }
    expect(quota.reserve("10.0.1.200", "198.51.100.7")).toBeUndefined();
    // 换回源地址即不受这个 peer 桶影响，说明桶键确实是来源身份而非客户端自报值。
    expect(quota.reserve("10.0.1.201", "198.51.100.8")).toBeDefined();
  });

  test("全局额度打满后任何来源都拒绝", () => {
    const quota = quotaOf({ ipMaxRequests: 100, globalMaxRequests: 3, ipMaxConnections: 100 });
    expect(quota.reserve("3.3.3.3", "3.3.3.3")).toBeDefined();
    expect(quota.reserve("4.4.4.4", "4.4.4.4")).toBeDefined();
    expect(quota.reserve("5.5.5.5", "5.5.5.5")).toBeDefined();
    expect(quota.reserve("6.6.6.6", "6.6.6.6")).toBeUndefined();
  });

  test("单个地址打满自己的速率额度后，别的地址仍能握手", () => {
    const quota = quotaOf({ ipMaxRequests: 5, globalMaxRequests: 20, ipMaxConnections: 1_000 });
    for (let index = 0; index < 200; index += 1) quota.reserve("7.7.7.7", "7.7.7.7")?.release();
    expect(quota.reserve("8.8.8.8", "8.8.8.8")).toBeDefined();
  });
});
