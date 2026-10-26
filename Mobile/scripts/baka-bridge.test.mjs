import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

/**
 * 桥接脚本的热更新编排：首页空闲时问清单，有更新就交给原生插件。
 * 通道证明部分需要真实 Keystore，不在这个纯 Node 夹具里跑；这里只钉住「什么时候问、
 * 什么时候不下载、下载参数怎么传」，因为它在真机上失败时只会表现为「一直没更新」。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs
  .readFileSync(path.resolve(here, "../bridge/baka-bridge.js"), "utf8")
  .replaceAll("__BAKA_CLIENT_VERSION__", "0.1.2");

const harness = ({ manifest, pathname = "/" } = {}) => {
  const listeners = new Map();
  const timers = [];
  const confirms = [];
  const installs = [];
  const fetches = [];

  const on = (type, handler) => {
    const list = listeners.get(type) ?? [];
    list.push(handler);
    listeners.set(type, list);
  };

  const pluginStub = (name) => {
    if (name !== "BakaHotUpdate") return {};
    return {
      confirm: async (args) => {
        confirms.push(args);
        return { confirmed: true };
      },
      install: async (args) => {
        installs.push(args);
        return { staged: true, build: args.build };
      },
    };
  };

  const sandbox = {
    console,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: async (url) => {
      fetches.push(String(url));
      return {
        ok: true,
        json: async () => manifest,
      };
    },
    location: { pathname },
    document: {
      readyState: "complete",
      visibilityState: "visible",
      addEventListener: on,
      querySelector: (selector) =>
        selector.includes("bakagame-build") ? { content: "abc1234" } : null,
      dispatch: (type) => (listeners.get(type) ?? []).forEach((handler) => handler()),
    },
    window: {
      addEventListener: on,
      localStorage: { getItem: () => null, setItem: () => {} },
      Capacitor: { registerPlugin: pluginStub },
    },
  };
  sandbox.window.document = sandbox.document;
  sandbox.window.location = sandbox.location;
  vm.runInNewContext(source, sandbox, { filename: "baka-bridge.js" });

  return {
    confirms,
    installs,
    fetches,
    timers,
    sandbox,
    fire: (type) => (listeners.get(type) ?? []).forEach((handler) => handler()),
    runTimer: (ms) => {
      const timer = timers.find((entry) => entry.ms === ms);
      assert.ok(timer, `没有找到 ${ms}ms 的定时器`);
      timer.fn();
    },
  };
};

const manifest = {
  available: true,
  build: "def5678",
  version: "1.9.6",
  url: "https://cdn.test/files/BakaGame-web-def5678.zip",
  sha256: "a".repeat(64),
  sizeBytes: 45_000_000,
};

const settle = async () => {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("页面加载后先确认待生效包，再在首页空闲时询问热更新清单", async () => {
  const h = harness({ manifest });
  h.fire("DOMContentLoaded");
  assert.deepEqual(
    h.confirms.map((entry) => ({ ...entry })),
    [{ build: "abc1234" }]
  );

  h.runTimer(8000);
  await settle();

  assert.equal(h.fetches.length, 1);
  assert.match(
    h.fetches[0],
    /\/api\/client\/web-bundle\?clientType=mobile&shellVersion=0\.1\.2&build=abc1234$/
  );
  assert.deepEqual(
    h.installs.map((entry) => ({ ...entry })),
    [
      {
        build: "def5678",
        url: "https://cdn.test/files/BakaGame-web-def5678.zip",
        sha256: "a".repeat(64),
        sizeBytes: 45_000_000,
      },
    ]
  );
});

test("没有可用更新时不调用原生插件；房间页只在退到后台时才检查", async () => {
  const noUpdate = harness({ manifest: { available: false } });
  noUpdate.fire("DOMContentLoaded");
  noUpdate.runTimer(8000);
  await settle();
  assert.equal(noUpdate.fetches.length, 1);
  assert.equal(noUpdate.installs.length, 0);

  const inRoom = harness({ manifest, pathname: "/songuessr/room/1234" });
  inRoom.fire("DOMContentLoaded");
  inRoom.runTimer(8000);
  await settle();
  assert.equal(inRoom.fetches.length, 0);

  inRoom.sandbox.document.visibilityState = "hidden";
  inRoom.fire("visibilitychange");
  await settle();
  assert.equal(inRoom.fetches.length, 1);
  assert.equal(inRoom.installs.length, 1);
});

test("清单字段不可信时不下发给原生：URL 必须 https，sha256 必须是 64 位十六进制", async () => {
  for (const broken of [
    { ...manifest, url: "http://cdn.test/files/x.zip" },
    { ...manifest, sha256: "xyz" },
    { ...manifest, build: "" },
  ]) {
    const h = harness({ manifest: broken });
    h.fire("DOMContentLoaded");
    h.runTimer(8000);
    await settle();
    await settle();
    assert.equal(h.installs.length, 0, `不该安装 ${JSON.stringify(broken)}`);
  }
});
