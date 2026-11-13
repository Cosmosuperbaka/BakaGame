import { expect, test } from "bun:test";

import type { AppEnv } from "../src/config/Env";
import type { ClientChannel } from "../src/infrastructure/ClientChannel";
import type { EventLogger } from "../src/infrastructure/EventLogger";
import type { AccountDependencies } from "../src/transport/routes/Account";
import { WsHandshakeQuota } from "../src/transport/WsHandshakeQuota";
import {
  applyHandshakeGates,
  confirmHandshakeLease,
  isValidHandshakeHeaders,
  releaseHandshakeLease,
  type GameUpgradeContext,
} from "../src/transport/ws/Handshake";
import { createConnectionRecord } from "../src/transport/ws/ConnectionRecord";

const quota = (ipMaxConnections = 2) =>
  new WsHandshakeQuota({
    windowMs: 60_000,
    ipMaxRequests: 100,
    globalMaxRequests: 100,
    ipMaxConnections,
  });

const logger = { warn: () => {}, error: () => {} } as unknown as EventLogger;
const env = (mcpEnabled: boolean) => ({ mcpEnabled }) as unknown as AppEnv;

const upgradeContext = (url: string, headers: Record<string, string> = {}): GameUpgradeContext => ({
  request: new Request(url, { headers }),
  headers: {},
  server: { requestIP: () => ({ address: "203.0.113.7" }) },
});

const accountDeps = (socketAccount: () => Promise<unknown>) =>
  ({ service: { socketAccount } }) as unknown as AccountDependencies;

test("握手头校验：key 须为 16 字节 base64，版本须为 13", () => {
  const ok = new Headers({
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
  });
  expect(isValidHandshakeHeaders(ok)).toBe(true);
  expect(isValidHandshakeHeaders(new Headers({ "sec-websocket-version": "13" }))).toBe(false);
  ok.set("sec-websocket-version", "8");
  expect(isValidHandshakeHeaders(ok)).toBe(false);
  ok.set("sec-websocket-version", "13");
  ok.set("sec-websocket-key", "short");
  expect(isValidHandshakeHeaders(ok)).toBe(false);
});

test("闸门顺序：Agent 被拒时不占名额，名额被拒时不查账号", async () => {
  const q = quota(1);
  let accountCalls = 0;
  const account = accountDeps(async () => {
    accountCalls += 1;
    return undefined;
  });

  const agent = upgradeContext("http://x/ws?agent=1", { cookie: "s=1" });
  await expect(
    applyHandshakeGates(agent, { env: env(false), logger, account, handshakeQuota: q })
  ).rejects.toMatchObject({ code: "AGENTS_DISABLED" });
  expect(q.reserve("203.0.113.7", "203.0.113.7")).toBeDefined();

  const second = upgradeContext("http://x/ws", { cookie: "s=1" });
  await expect(
    applyHandshakeGates(second, { env: env(false), logger, account, handshakeQuota: q })
  ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  expect(accountCalls).toBe(0);
});

test("通过闸门后上下文带租约与来源身份；账号故障只退化为游客", async () => {
  const q = quota();
  const context = upgradeContext("http://x/ws", { cookie: "s=1" });
  await applyHandshakeGates(context, {
    env: env(true),
    logger,
    account: accountDeps(async () => {
      throw new Error("db down");
    }),
    handshakeQuota: q,
  });
  expect(context.handshakeLease).toBeDefined();
  expect(context.clientIp).toBe("203.0.113.7");
  expect(context.account).toBeUndefined();
});

test("占位之后步骤抛错：租约当场归还", async () => {
  const q = quota(1);
  const context = upgradeContext("http://x/ws?ticket=t");
  const channel = {
    consume: () => {
      throw new Error("boom");
    },
  } as unknown as ClientChannel;
  await expect(
    applyHandshakeGates(context, {
      env: env(true),
      logger,
      account: undefined,
      handshakeQuota: q,
      clientChannel: channel,
    })
  ).rejects.toThrow("boom");
  // 名额已归还：同一来源还能再占。
  const retry = upgradeContext("http://x/ws");
  await applyHandshakeGates(retry, {
    env: env(true),
    logger,
    account: undefined,
    handshakeQuota: q,
  });
  expect(retry.handshakeLease).toBeDefined();
});

test("open 确认、close 归还租约；没有租约时两者都是空操作", () => {
  const calls: string[] = [];
  const lease = { confirm: () => calls.push("confirm"), release: () => calls.push("release") };
  const ws = { data: { handshakeLease: lease }, send: () => {}, close: () => {} };
  confirmHandshakeLease(ws);
  releaseHandshakeLease(ws);
  expect(calls).toEqual(["confirm", "release"]);
  const bare = { data: {}, send: () => {}, close: () => {} };
  expect(() => {
    confirmHandshakeLease(bare);
    releaseHandshakeLease(bare);
  }).not.toThrow();
});

test("连接记录：身份字段取自握手上下文，标签页驱动状态按需判定", () => {
  const sent: unknown[] = [];
  const ws = {
    data: { clientIp: "203.0.113.7", isAgent: true, tabKey: "tab-1" },
    send: (data: unknown) => sent.push(data),
    close: () => {},
  };
  const record = createConnectionRecord(ws, "c-1", (tabKey) => tabKey === "tab-1");
  expect(record).toMatchObject({
    id: "c-1",
    clientIp: "203.0.113.7",
    isAgent: true,
    tabKey: "tab-1",
  });
  expect(record.agentDriven?.()).toBe(true);
  expect(record).not.toHaveProperty("account");
  record.sendPacket?.({ type: "event", event: "e", payload: 1 });
  expect(sent).toHaveLength(1);

  const plain = createConnectionRecord({ data: {}, send: () => {}, close: () => {} }, "c-2");
  expect(plain).not.toHaveProperty("tabKey");
  expect(plain).not.toHaveProperty("isAgent");
});
