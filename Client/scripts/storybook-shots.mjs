// 批量截取 Storybook 中的全部组件范例，产出 PNG 与一页索引，供样式审查与改前改后对照。
//
// 用法：npm run storybook:shots -- [--filter 关键字] [--out 目录] [--url 已运行的 Storybook 地址]
//                                  [--port 自启端口] [--workers 并发数]
//
// 截图规则由故事的 tags 决定（index.json 只暴露 tags，不暴露 parameters）：
//   page     整页故事，亮/暗 × 手机 390 / 平板 900 / 桌面 1440，截取视口
//   overlay  浮层故事（弹窗、抽屉），亮/暗 × 手机 / 桌面，截取整页以包含 Portal
//   mobile   只在手机宽度成立的故事（移动端覆盖面板），与 page / overlay 组合使用
//   no-shot  只供交互调试，不截图
//   其余     组件故事，亮/暗 × 桌面宽度，截取故事根元素
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values: options } = parseArgs({
  options: {
    url: { type: "string" },
    port: { type: "string", default: "6107" },
    filter: { type: "string" },
    out: { type: "string", default: "storybook-shots" },
    workers: { type: "string", default: "4" },
  },
});

const clientDir = process.cwd();
const outDir = path.resolve(clientDir, options.out);
const port = Number(options.port);
/** 组件截图在故事根元素外保留的边距（像素），容纳投影。 */
const FRAME_MARGIN = 12;
const themes = ["light", "dark"];
const viewports = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 900, height: 800 },
  desktop: { width: 1440, height: 900 },
};
const plans = {
  page: [viewports.mobile, viewports.tablet, viewports.desktop],
  overlay: [viewports.mobile, viewports.desktop],
  frame: [viewports.desktop],
};

const shotMode = (tags) => (tags.includes("page") ? "page" : tags.includes("overlay") ? "overlay" : "frame");
const safeName = (value) => value.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
const escapeHtml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Storybook 由分发器再拉起子进程，只杀直接子进程会留下占着端口的服务。 */
function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
}

async function startStorybook() {
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [path.join(clientDir, "node_modules/storybook/dist/bin/dispatcher.js"), "dev", "--ci", "--quiet",
      "--no-version-updates", "--disable-telemetry", "--exact-port", "--host", "127.0.0.1", "--port", String(port)],
    { cwd: clientDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  // 冷启动要先生成 WebP 公共资源并预构建依赖，给足 180 秒。
  for (let attempt = 0; attempt < 360; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Storybook 启动失败：\n${log.slice(-4000)}`);
    try {
      const response = await fetch(`${baseUrl}/index.json`);
      if (response.ok) return { baseUrl, child };
    } catch {
      // 服务尚未监听，继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  killTree(child);
  throw new Error(`Storybook 未能在 180 秒内就绪：\n${log.slice(-4000)}`);
}

/** 等故事渲染收尾，再等字体、图片与仍在播放的动画落定，避免截到中间帧。 */
async function waitForStory(page) {
  await page.waitForFunction(() => {
    const renders = window.__STORYBOOK_PREVIEW__?.storyRenders ?? [];
    return renders.some((render) => ["completed", "finished", "errored", "aborted"].includes(render.phase));
  }, undefined, { timeout: 90_000 });
  if (await page.evaluate(() => document.body.classList.contains("sb-show-errordisplay"))) {
    const message = await page.locator("#error-message").innerText().catch(() => "");
    throw new Error(message || "故事渲染失败");
  }
  await page.evaluate(async () => {
    // 每一步都有上限：暂停的动画或卡住的资源不能让整批截图无限挂起。
    const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
    await within(document.fonts.ready, 10_000);
    // 懒加载图片不进视口就永远不会开始下载，截图前一律改为立即加载。
    for (const image of document.images) image.loading = "eager";
    await within(Promise.all([...document.images].map((image) => (image.complete ? null : image.decode().catch(() => null)))), 15_000);
    await within(Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished)), 5_000);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function captureStory(browser, baseUrl, story) {
  const mode = shotMode(story.tags ?? []);
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: viewports.desktop });
  const page = await context.newPage();
  const issues = [];
  // 故事只允许访问本机资源，杜绝截图结果依赖外网。
  await page.route("**/*", (route) => {
    const { hostname } = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(hostname) || route.request().url().startsWith("data:") ? route.continue() : route.abort();
  });
  page.on("pageerror", (error) => issues.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") issues.push(`console: ${message.text()}`); });

  const shots = [];
  const sizes = (story.tags ?? []).includes("mobile") ? [viewports.mobile] : plans[mode];
  try {
    for (const theme of themes) {
      for (const viewport of sizes) {
        await page.setViewportSize(viewport);
        const url = `${baseUrl}/iframe.html?viewMode=story&id=${encodeURIComponent(story.id)}&globals=${encodeURIComponent(`theme:${theme};motion:off`)}`;
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await waitForStory(page);
        const file = path.join(...story.title.split("/").map(safeName), `${safeName(story.name)}--${theme}--${viewport.width}.png`);
        const target = path.join(outDir, file);
        await mkdir(path.dirname(target), { recursive: true });
        const screenshotOptions = { path: target, animations: "disabled", caret: "hide" };
        if (mode === "frame") {
          // 按故事根元素取景并外扩一圈，让偏移投影完整入镜。
          const box = await page.locator("#storybook-root > *").first().evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height };
          });
          const x = Math.max(0, box.x - FRAME_MARGIN);
          const y = Math.max(0, box.y - FRAME_MARGIN);
          await page.screenshot({ ...screenshotOptions, fullPage: true,
            clip: { x, y, width: box.width + (box.x - x) + FRAME_MARGIN, height: box.height + (box.y - y) + FRAME_MARGIN } });
        } else await page.screenshot({ ...screenshotOptions, fullPage: mode === "overlay" });
        shots.push({ file: file.split(path.sep).join("/"), theme, width: viewport.width });
      }
    }
    return { id: story.id, title: story.title, name: story.name, mode, shots, issues };
  } catch (error) {
    return { id: story.id, title: story.title, name: story.name, mode, shots, issues, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await context.close();
  }
}

function renderIndex(entries) {
  const groups = new Map();
  for (const entry of [...entries].sort((left, right) => left.title.localeCompare(right.title, "zh-Hans-CN"))) {
    groups.set(entry.title, [...(groups.get(entry.title) ?? []), entry]);
  }
  const sections = [...groups].map(([title, stories]) => `
    <section><h2>${escapeHtml(title)}</h2>${stories.map((story) => `
      <article>
        <h3>${escapeHtml(story.name)} <small>${story.mode}</small></h3>
        ${story.error ? `<p class="error">${escapeHtml(story.error)}</p>` : ""}
        ${story.issues.length ? `<ul class="issues">${story.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>` : ""}
        <div class="shots">${story.shots.map((shot) => `
          <figure><a href="${encodeURI(shot.file)}"><img loading="lazy" src="${encodeURI(shot.file)}" alt=""></a>
          <figcaption>${shot.theme === "dark" ? "暗色" : "亮色"} · ${shot.width}px</figcaption></figure>`).join("")}
        </div>
      </article>`).join("")}
    </section>`).join("");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>组件截图索引</title>
<style>
  body { margin: 0; padding: 24px; font: 14px/1.5 system-ui, sans-serif; background: #f4f4f4; color: #222; }
  h2 { margin: 32px 0 8px; font-size: 18px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
  h3 { margin: 16px 0 8px; font-size: 14px; } small { color: #888; font-weight: normal; }
  .shots { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
  figure { margin: 0; background: #fff; border: 1px solid #ddd; padding: 6px; }
  img { display: block; max-width: 480px; max-height: 360px; object-fit: contain; object-position: top left; }
  figcaption { color: #666; font-size: 12px; margin-top: 4px; }
  .error { color: #b00020; } .issues { color: #9a6700; font-size: 12px; }
</style></head>
<body><h1>组件截图索引</h1><p>共 ${entries.length} 个故事，${entries.reduce((sum, entry) => sum + entry.shots.length, 0)} 张截图。</p>${sections}</body></html>`;
}

async function main() {
  const filter = options.filter ? new RegExp(options.filter, "i") : null;
  const manifestPath = path.join(outDir, "manifest.json");
  let storybook = null;
  let browser = null;
  try {
    if (!filter) await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    storybook = options.url ? { baseUrl: options.url.replace(/\/+$/, ""), child: null } : await startStorybook();

    const index = await (await fetch(`${storybook.baseUrl}/index.json`)).json();
    const stories = Object.values(index.entries)
      .filter((entry) => entry.type === "story" && !(entry.tags ?? []).includes("no-shot"))
      .filter((entry) => !filter || filter.test(entry.id) || filter.test(`${entry.title}/${entry.name}`));
    if (!stories.length) throw new Error("没有匹配的故事");

    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : undefined });
    const queue = [...stories];
    const results = [];
    const workers = Math.max(1, Number(options.workers) || 1);
    await Promise.all(Array.from({ length: workers }, async () => {
      for (let story = queue.shift(); story; story = queue.shift()) {
        const result = await captureStory(browser, storybook.baseUrl, story);
        results.push(result);
        console.log(`${result.error ? "✗" : result.issues.length ? "!" : "✓"} ${story.title} / ${story.name}（${result.shots.length} 张）`);
      }
    }));

    // 只拍部分故事时保留其它故事的上次结果，索引始终覆盖全集。
    const previous = filter ? JSON.parse(await readFile(manifestPath, "utf8").catch(() => "[]")) : [];
    const refreshed = new Set(results.map((result) => result.id));
    const entries = [...previous.filter((entry) => !refreshed.has(entry.id)), ...results];
    await writeFile(manifestPath, JSON.stringify(entries, null, 2));
    await writeFile(path.join(outDir, "index.html"), renderIndex(entries));

    const failed = results.filter((result) => result.error);
    const warned = results.filter((result) => !result.error && result.issues.length);
    console.log(`\n截图完成：${results.length} 个故事，失败 ${failed.length}，有控制台错误 ${warned.length}。索引：${path.join(outDir, "index.html")}`);
    if (failed.length || warned.length) process.exitCode = 1;
  } finally {
    await browser?.close();
    if (storybook?.child) killTree(storybook.child);
  }
}

await main();
