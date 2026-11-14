import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

/**
 * 通道票据的到期判定：票按「收到后过去了多久」算，不拿本机墙上时钟去比服务端给的绝对时刻。
 * 这里用假时钟与假服务端把整条「领挑战 → 签名 → 换票」跑通，钉住轮询什么时候该重签、什么时候不该。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs
  .readFileSync(path.resolve(here, "../bridge/baka-bridge.js"), "utf8")
  .replaceAll("__BAKA_CLIENT_VERSION__", "0.1.2");

const harness = ({ wallNow, attestReply }) => {
  const clock = { wall: wallNow, mono: 1000 };
  const timers = [];
  const requests = [];
  const sandbox = {
    console,
    Date: { now: () => clock.wall },
    performance: { now: () => clock.mono },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout: () => {},
    setInterval: (fn, ms) => timers.push({ fn, ms }),
    clearInterval: () => {},
    fetch: async (url) => {
      const endpoint = new URL(String(url)).pathname;
      requests.push(endpoint);
      const body =
        endpoint === "/api/client/challenge"
          ? { challenge: "ccd_x.nonce.1", expiresAt: clock.wall + 60000 }
          : endpoint === "/api/client/attest"
            ? attestReply(clock)
            : { available: false };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      };
    },
    location: { pathname: "/room" },
    document: {
      readyState: "complete",
      visibilityState: "visible",
      addEventListener: () => {},
      querySelector: () => null,
    },
    window: {
      localStorage: { getItem: () => "ccd_x", setItem: () => {} },
      Capacitor: {
        registerPlugin: (name) =>
          name === "BakaChannel"
            ? {
                selfCheck: async () => ({
                  hardFail: [],
                  softFail: [],
                  attestationLevel: "trusted",
                }),
                sign: async () => ({ signature: "c2ln" }),
              }
            : {},
      },
    },
  };
  sandbox.window.document = sandbox.document;
  sandbox.window.location = sandbox.location;
  vm.runInNewContext(source, sandbox, { filename: "baka-bridge.js" });
  const settle = async () => {
    for (let index = 0; index < 8; index += 1)
      await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    clock,
    channel: sandbox.window.__BAKA_CHANNEL__,
    attests: () => requests.filter((endpoint) => endpoint === "/api/client/attest").length,
    poll: () => timers.find((timer) => timer.ms === 4000)?.fn(),
    settle,
  };
};

test("本机时钟比服务端快：新票照样可用，轮询不会反复重签", async () => {
  const serverNow = 5_000_000;
  const h = harness({
    wallNow: serverNow + 100_000,
    attestReply: () => ({
      ticket: "T1",
      ttlMs: 30000,
      expiresAt: serverNow + 30000,
      outdated: false,
    }),
  });
  assert.equal(h.channel.channelTicket, ""); // 页面第一次要票：惰性启动签发
  await h.settle();
  assert.equal(h.attests(), 1);
  h.poll();
  await h.settle();
  assert.equal(h.attests(), 1, "票还在有效期内，轮询不该再签");
  assert.equal(h.channel.channelTicket, "T1");
});

test("过了有效期的票会被换掉：正常流逝、改时间与休眠都不会让旧票复活", async () => {
  const h = harness({
    wallNow: 9_000_000,
    attestReply: (clock) => ({
      ticket: "T",
      ttlMs: 30000,
      expiresAt: clock.wall + 30000,
      outdated: false,
    }),
  });
  h.channel.channelTicket;
  await h.settle();
  assert.equal(h.attests(), 1);
  h.clock.mono += 26_000;
  h.clock.wall += 26_000;
  h.poll();
  await h.settle();
  assert.equal(h.attests(), 2, "离过期不足余量就要重签");
  h.clock.mono += 1_000; // 休眠：单调时钟几乎没走
  h.clock.wall += 600_000;
  h.poll();
  await h.settle();
  assert.equal(h.attests(), 3, "休眠十分钟后的票必须作废");
});

test("旧服务端没有 ttlMs：退回绝对时刻算法，行为与改动前一致", async () => {
  const h = harness({
    wallNow: 7_000_000,
    attestReply: (clock) => ({ ticket: "T", expiresAt: clock.wall + 30000, outdated: false }),
  });
  h.channel.channelTicket;
  await h.settle();
  h.poll();
  await h.settle();
  assert.equal(h.attests(), 1, "票仍新鲜，不该重签");
  h.clock.mono += 26_000;
  h.clock.wall += 26_000;
  h.poll();
  await h.settle();
  assert.equal(h.attests(), 2);
});

test("页面可见的桥接面没有签名能力：签名只留在桥内部用于换票", async () => {
  const h = harness({
    wallNow: 1_000_000,
    attestReply: (clock) => ({ ticket: "T", ttlMs: 30000, expiresAt: clock.wall + 30000 }),
  });
  assert.equal("sign" in h.channel, false, "页面脚本不该能让壳对任意内容签名");
  assert.deepEqual(Object.keys(h.channel).sort(), [
    "channelTicket",
    "clientType",
    "clientVersion",
    "platform",
    "selfCheck",
    "setSecureScreen",
  ]);
  // 内部换票仍然要签名：桥接面收窄不能让通道证明断掉。
  h.channel.channelTicket;
  await h.settle();
  assert.equal(h.attests(), 1);
  assert.equal(h.channel.channelTicket, "T");
});
