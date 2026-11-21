import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

/**
 * 桥接脚本的壳界面部分（原生 BakaShell 插件）：系统栏跟随页面外观。
 * 真实的插图与配色只有设备上看得到；这里钉住「什么时候回报、回报什么」，
 * 因为它出错时在设备上只表现为系统栏颜色不对，很难察觉是桥接没发。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs
  .readFileSync(path.resolve(here, "../bridge/baka-bridge.js"), "utf8")
  .replaceAll("__BAKA_CLIENT_VERSION__", "0.1.5");

const shellHarness = ({ withShell = true, pathname = "/", historyIdx = 0 } = {}) => {
  const calls = [];
  const backCalls = [];
  const navigation = [];
  const keydowns = [];
  const windowListeners = new Map();
  // 当前打开的浮层数（Radix 对话框、抽屉、菜单等）；Escape 能不能关掉由 escapeCloses 决定
  const overlays = { open: 0, escapeCloses: true };
  const timers = [];
  const observers = [];
  const classes = new Set();
  // 页面底色：canvas 把它换算成的 sRGB 像素
  const page = { background: "oklch(0.9582 0.0152 90.2357)", pixel: [0xf5, 0xf1, 0xe6, 255] };

  const shell = {
    setSystemBars: async (args) => {
      calls.push(["setSystemBars", { ...args }]);
    },
    moveToBack: async () => {
      backCalls.push(["moveToBack"]);
    },
  };
  const location = { pathname };
  const history = {
    state: { idx: historyIdx },
    back: () => navigation.push("back"),
    pushState: (state, _title, url) => {
      history.state = state;
      location.pathname = url;
    },
    replaceState: (state, _title, url) => {
      history.state = state;
      location.pathname = url;
      navigation.push(`replace:${url}`);
    },
  };

  const documentElement = {
    classList: { contains: (name) => classes.has(name) },
  };
  const document = {
    readyState: "complete",
    visibilityState: "visible",
    documentElement,
    body: {
      dispatchEvent: (event) => {
        keydowns.push(event.key);
        if (event.key === "Escape" && overlays.escapeCloses && overlays.open > 0)
          overlays.open -= 1;
        return true;
      },
    },
    activeElement: null,
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => ({ length: overlays.open }),
    createElement: () => ({
      getContext: () => ({
        clearRect: () => {},
        fillRect: () => {},
        set fillStyle(value) {
          this.last = value;
        },
        getImageData: () => ({ data: page.pixel }),
      }),
    }),
  };
  const sandbox = {
    console,
    Promise,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: async () => ({ ok: false }),
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }
      observe(target, options) {
        this.target = target;
        this.options = options;
      }
    },
    CustomEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.cancelable = Boolean(init.cancelable);
        this.defaultPrevented = false;
      }
      preventDefault() {
        if (this.cancelable) this.defaultPrevented = true;
      }
    },
    KeyboardEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.key = init.key;
      }
    },
    PopStateEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    location,
    document,
    window: {
      history,
      addEventListener: (type, handler) => {
        const list = windowListeners.get(type) ?? [];
        list.push(handler);
        windowListeners.set(type, list);
      },
      dispatchEvent: (event) => {
        if (event.type === "popstate") navigation.push("popstate");
        for (const handler of windowListeners.get(event.type) ?? []) handler(event);
        return !event.defaultPrevented;
      },
      getComputedStyle: () => ({ backgroundColor: page.background }),
      localStorage: { getItem: () => null, setItem: () => {} },
      Capacitor: { Plugins: withShell ? { BakaShell: shell } : {} },
    },
  };
  sandbox.window.document = document;
  sandbox.window.location = sandbox.location;
  vm.runInNewContext(source, sandbox, { filename: "baka-bridge.js" });

  const flush = () => {
    while (timers.length) timers.shift().fn();
  };
  return {
    calls,
    backCalls,
    navigation,
    keydowns,
    overlays,
    location,
    history,
    back: () => sandbox.window.__BAKA_SHELL_BACK__(),
    claimBack: (handler) => sandbox.window.addEventListener("bakagame:shell-back", handler),
    classes,
    page,
    sandbox,
    flush,
    mutate: () => {
      for (const observer of observers) observer.callback([]);
    },
    observers,
  };
};

const settle = async () => {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("启动后回报页面明暗与换算成 sRGB 的底色", async () => {
  const h = shellHarness();
  h.flush();
  await settle();
  assert.deepEqual(h.calls, [["setSystemBars", { dark: false, color: "#f5f1e6" }]]);
  // 只盯 <html> 上决定外观的三个属性
  assert.deepEqual([...h.observers[0].options.attributeFilter].sort(), [
    "class",
    "data-theme",
    "style",
  ]);
});

test("切到暗色后补报一次；外观没变时不重复打扰原生", async () => {
  const h = shellHarness();
  h.flush();
  h.classes.add("dark");
  h.page.pixel = [0x2d, 0x26, 0x21, 255];
  h.mutate();
  h.flush();
  h.mutate();
  h.flush();
  await settle();
  assert.deepEqual(h.calls, [
    ["setSystemBars", { dark: false, color: "#f5f1e6" }],
    ["setSystemBars", { dark: true, color: "#2d2621" }],
  ]);
});

test("底色还是透明时只报明暗，不让原生铺一块透明", async () => {
  const h = shellHarness();
  h.page.pixel = [0, 0, 0, 0];
  h.flush();
  await settle();
  assert.deepEqual(h.calls, [["setSystemBars", { dark: false }]]);
});

test("旧壳没有 BakaShell 插件时静默跳过", async () => {
  const h = shellHarness({ withShell: false });
  assert.doesNotThrow(() => h.flush());
  await settle();
  assert.equal(h.calls.length, 0);
});

test("返回键：有浮层先合成 Escape 关掉它，不往下走", async () => {
  const h = shellHarness({ pathname: "/cee/room/1234", historyIdx: 2 });
  h.flush();
  h.overlays.open = 1;
  h.back();
  h.flush();
  await settle();
  assert.deepEqual(h.keydowns, ["Escape"]);
  assert.deepEqual(h.navigation, []);
});

test("返回键：浮层关不掉（如必须先填写的弹窗）时继续交给页面或后退", async () => {
  const h = shellHarness({ pathname: "/cee/room/1234", historyIdx: 2 });
  h.flush();
  h.overlays.open = 1;
  h.overlays.escapeCloses = false;
  h.back();
  assert.deepEqual(h.navigation, [], "Escape 之后要等一会儿再判断");
  h.flush();
  assert.deepEqual(h.navigation, ["back"]);
});

test("返回键：页面接手（房间页弹离开确认）时不后退、不退到后台", async () => {
  const h = shellHarness({ pathname: "/whoisfaker/room/1234", historyIdx: 3 });
  h.flush();
  let claimed = 0;
  h.claimBack((event) => {
    event.preventDefault();
    claimed += 1;
  });
  h.back();
  h.flush();
  await settle();
  assert.equal(claimed, 1);
  assert.deepEqual(h.navigation, []);
  assert.ok(!h.backCalls.some(([name]) => name === "moveToBack"));
});

test("返回键：非首页退回上一页；冷启动落在深链上没有上一页时改写成首页并通知路由", async () => {
  const withHistory = shellHarness({ pathname: "/abouts", historyIdx: 1 });
  withHistory.flush();
  withHistory.back();
  assert.deepEqual(withHistory.navigation, ["back"]);

  const deepLink = shellHarness({ pathname: "/abouts", historyIdx: 0 });
  deepLink.flush();
  deepLink.back();
  assert.deepEqual(deepLink.navigation, ["replace:/", "popstate"]);
  assert.equal(deepLink.location.pathname, "/");
});

test("返回键：首页且没有浮层时请原生退到后台", async () => {
  const h = shellHarness({ pathname: "/" });
  h.flush();
  h.back();
  await settle();
  assert.deepEqual(h.navigation, []);
  assert.deepEqual(h.backCalls.at(-1), ["moveToBack"]);
});

test("返回事件名与客户端钩子同一份契约", () => {
  const hook = fs.readFileSync(
    path.resolve(here, "../../Client/src/hooks/UseShellBack.ts"),
    "utf8"
  );
  const bridge = fs.readFileSync(path.resolve(here, "../bridge/baka-bridge.js"), "utf8");
  const clientName = /SHELL_BACK_EVENT = "([^"]+)"/.exec(hook)?.[1];
  const bridgeName = /var SHELL_BACK_EVENT = "([^"]+)"/.exec(bridge)?.[1];
  assert.ok(clientName);
  assert.equal(bridgeName, clientName);
});
