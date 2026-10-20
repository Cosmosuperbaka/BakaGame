import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";
import { preview as createPreview } from "vite";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(clientDir, "dist");

/**
 * 首屏测量条件必须每次一致，否则「改前 / 改后」两组数字不可比：
 * 视口、DPR、网络档与 CPU 倍率都写在这里，改任何一项都要重跑基线。
 * 取弱网档（Fast 3G 口径）而不是本机无节流：无节流时 100KB 的渲染阻塞 CSS
 * 在 loopback 上几毫秒就下完，结构问题量不出来。
 */
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2 };
const NETWORK = {
  latencyMs: 150,
  downloadBps: (1.6 * 1024 * 1024) / 8,
  uploadBps: (750 * 1024) / 8,
};
const CPU_THROTTLE = 4;
// 与 playwright.config.ts 同一口径：Windows 走系统 Edge，不依赖 ms-playwright 里下载的浏览器。
const CHANNEL = process.platform === "win32" ? "msedge" : undefined;

// addInitScript 只序列化这一个函数体：里面用到的名字必须自带，不能引用模块作用域。
const collect = () => {
  const toPath = (value) => {
    try {
      return new URL(value, location.href).pathname;
    } catch {
      return value;
    }
  };
  window.__fs = { fcp: null, lcp: null, lcpLabel: null, lcpTrace: [] };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      if (entry.name === "first-contentful-paint") window.__fs.fcp = entry.startTime;
  }).observe({ type: "paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const el = entry.element;
      const label = el
        ? `${el.tagName.toLowerCase()}${el.getAttribute("src") ? ` ${toPath(el.getAttribute("src"))}` : ""}`
        : "(无元素)";
      window.__fs.lcpTrace.push({
        time: entry.startTime,
        label,
        size: entry.size,
        url: entry.url ? toPath(entry.url) : null,
      });
      if (entry.startTime >= (window.__fs.lcp ?? 0)) {
        window.__fs.lcp = entry.startTime;
        window.__fs.lcpLabel = `${label} ${Math.round(entry.size)}px²${entry.url ? ` ${toPath(entry.url)}` : ""}`;
      }
    }
  }).observe({ type: "largest-contentful-paint", buffered: true });
};

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: quantile(sorted, 0.5), q1: quantile(sorted, 0.25), q3: quantile(sorted, 0.75) };
};

const round = (n) => Math.round(n);

async function measureOnce(baseUrl, route, { holdAfterLoadMs }) {
  const browser = await chromium.launch({ channel: CHANNEL });
  const context = await browser.newContext({
    viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
    deviceScaleFactor: VIEWPORT.deviceScaleFactor,
    // 全新 context：Playwright 保证 context 之间状态（含 HTTP 缓存）完全隔离，即冷缓存。
  });
  await context.addInitScript(collect);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: NETWORK.latencyMs,
    downloadThroughput: round(NETWORK.downloadBps),
    uploadThroughput: round(NETWORK.uploadBps),
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });

  const failed = [];
  page.on("response", (response) => {
    if (response.status() >= 400)
      failed.push({ url: new URL(response.url()).pathname, status: response.status() });
  });

  await page.goto(`${baseUrl}${route}`, { waitUntil: "load" });
  // LCP 候选在载入后仍可能被后到的资源改写，留一段静默期取最终值。
  await page.waitForTimeout(holdAfterLoadMs);

  const metrics = await page.evaluate(() => {
    const toPath = (value) => {
      try {
        return new URL(value, location.href).pathname;
      } catch {
        return value;
      }
    };
    const nav = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource").map((r) => ({
      url: toPath(r.name),
      type: r.initiatorType,
      transfer: r.transferSize,
      encoded: r.encodedBodySize,
      start: r.startTime,
      end: r.responseEnd,
    }));
    const stylesheets = [...document.querySelectorAll('link[rel="stylesheet"]')].map((el) => ({
      href: toPath(el.href),
      media: el.media || "all",
    }));
    // 「阻塞」按浏览器实际行为算：无 media 或 media 命中的样式表才挡首屏渲染。
    const transferOf = (url) => resources.find((r) => r.url === url)?.transfer ?? 0;
    return {
      fcp: window.__fs.fcp,
      lcp: window.__fs.lcp,
      lcpLabel: window.__fs.lcpLabel,
      lcpTrace: window.__fs.lcpTrace,
      domContentLoaded: nav ? nav.domContentLoadedEventEnd : null,
      loadEnd: nav ? nav.loadEventEnd : null,
      blockingStyleBytes: stylesheets
        .filter((sheet) => !sheet.media || sheet.media === "all" || matchMedia(sheet.media).matches)
        .reduce((total, sheet) => total + transferOf(sheet.href), 0),
      resources,
      stylesheets,
    };
  });

  await browser.close();
  return { ...metrics, failed };
}

export async function measureFirstScreen(options = {}) {
  const { route = "/", runs = 5, tag = "", holdAfterLoadMs = 5000, outDir } = options;
  const server = await createPreview({
    root: clientDir,
    configFile: false,
    envDir: false,
    build: { outDir: distDir },
    preview: { host: "127.0.0.1", port: 0, strictPort: true, proxy: {} },
  });
  const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  const samples = [];
  try {
    for (let i = 0; i < runs; i += 1) {
      const sample = await measureOnce(baseUrl, route, { holdAfterLoadMs });
      sample.totalTransferBytes = round(sample.resources.reduce((sum, r) => sum + r.transfer, 0));
      samples.push(sample);
    }
  } finally {
    await server.close();
  }

  const pick = (key) => samples.map((s) => s[key]).filter((v) => typeof v === "number");
  const result = {
    conditions: {
      route,
      runs,
      engine: CHANNEL ?? "chromium",
      viewport: VIEWPORT,
      network: NETWORK,
      cpuThrottle: CPU_THROTTLE,
    },
    fcp: summarize(pick("fcp")),
    lcp: summarize(pick("lcp")),
    domContentLoaded: summarize(pick("domContentLoaded")),
    loadEnd: summarize(pick("loadEnd")),
    blockingCssBytes: summarize(pick("blockingStyleBytes")),
    totalTransferBytes: summarize(pick("totalTransferBytes")),
    lcpLabel: samples.at(-1)?.lcpLabel ?? null,
    lcpTrace: samples.at(-1)?.lcpTrace ?? [],
    resources: samples.at(-1)?.resources ?? [],
    stylesheets: samples.at(-1)?.stylesheets ?? [],
    failed: samples.flatMap((s) => s.failed),
    samples: samples.map((s) => ({
      fcp: s.fcp,
      lcp: s.lcp,
      blockingCssBytes: s.blockingStyleBytes,
      totalTransferBytes: s.totalTransferBytes,
    })),
  };
  if (outDir) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(outDir, { recursive: true });
    const key = `${tag ? `${tag}-` : ""}${route.replace(/[^\w]+/g, "_") || "root"}`;
    await writeFile(path.join(outDir, `first-screen-${key}.json`), JSON.stringify(result, null, 2));
  }
  return result;
}

const format = (label, s, unit = "ms") =>
  `${label.padEnd(18)} 中位数 ${round(s.median)}${unit} · IQR ${round(s.q1)}–${round(s.q3)}${unit}`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  // Git Bash 会把 `--route=/x` 里的 `/x` 换成 Windows 路径，这里允许省略前导斜杠。
  const raw = arg("route", "/");
  const route = raw.startsWith("/") ? raw : `/${raw}`;
  const runs = Number(arg("runs", 5));
  const tag = arg("tag", "run");
  const outDir = arg("out", path.join(clientDir, "test-results", "perf"));
  const result = await measureFirstScreen({ route, runs, tag, outDir });
  console.log(
    [
      `首屏测量 ${route}（${runs} 次冷缓存，${result.conditions.engine}，视口 ${result.conditions.viewport.width}×${result.conditions.viewport.height}@${result.conditions.viewport.deviceScaleFactor}，` +
        `${(result.conditions.network.downloadBps * 8) / 1024}kbps/${result.conditions.network.latencyMs}ms，CPU×${result.conditions.cpuThrottle}）`,
      format("FCP", result.fcp),
      format("LCP", result.lcp),
      format("DOMContentLoaded", result.domContentLoaded),
      format("load", result.loadEnd),
      format("阻塞 CSS 传输", result.blockingCssBytes, "B"),
      format("总传输", result.totalTransferBytes, "B"),
      `LCP 元素         ${result.lcpLabel}`,
      `LCP 候选序列     ${result.lcpTrace.map((t) => `${Math.round(t.time)}ms ${t.label}`).join(" | ")}`,
      "",
      "按类别传输",
      ...Object.entries(
        result.resources.reduce((acc, r) => {
          const kind = /\.woff2?$/.test(r.url)
            ? "字体"
            : /\.(js|mjs)$/.test(r.url)
              ? "JS"
              : /\.css$/.test(r.url)
                ? "CSS"
                : /\.(webp|png|jpe?g|svg|gif)$/.test(r.url)
                  ? "图片"
                  : "其他";
          acc[kind] = acc[kind] || { n: 0, bytes: 0 };
          acc[kind].n += 1;
          acc[kind].bytes += r.transfer;
          return acc;
        }, {})
      )
        .sort((a, b) => b[1].bytes - a[1].bytes)
        .map(([kind, v]) => `  ${kind.padEnd(4)} ${v.n} 个 · ${(v.bytes / 1024).toFixed(1)} KiB`),
      "",
      "资源（按传输字节）",
      ...[...result.resources]
        .sort((a, b) => b.transfer - a.transfer)
        .slice(0, 12)
        .map(
          (r) =>
            `  ${(r.transfer / 1024).toFixed(1).padStart(8)} KiB  ${r.type.padEnd(10)} ${r.url}`
        ),
    ].join("\n")
  );
}
