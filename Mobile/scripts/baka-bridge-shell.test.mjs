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

const shellHarness = ({ withShell = true, pathname = "/" } = {}) => {
  const calls = [];
  const timers = [];
  const observers = [];
  const classes = new Set();
  // 页面底色：canvas 把它换算成的 sRGB 像素
  const page = { background: "oklch(0.9582 0.0152 90.2357)", pixel: [0xf5, 0xf1, 0xe6, 255] };

  const shell = {
    setSystemBars: async (args) => {
      calls.push(["setSystemBars", { ...args }]);
    },
  };

  const documentElement = {
    classList: { contains: (name) => classes.has(name) },
  };
  const document = {
    readyState: "complete",
    visibilityState: "visible",
    documentElement,
    body: {},
    addEventListener: () => {},
    querySelector: () => null,
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
    location: { pathname },
    document,
    window: {
      addEventListener: () => {},
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
