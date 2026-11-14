// 逐个执行 Storybook 静态构建里的故事，只判健康、不出图：没有未捕获页面异常、没有 console.error、
// Storybook 没有显示出错界面、故事根节点不是空的。任一故事不健康就列出编号与原因并以非零退出。
//
// 用法：npm run storybook:health -- [--dir 静态目录] [--workers 并发数] [--timeout 毫秒] [--filter 正则]
// 前置：先 build-storybook。这里只服务已经构建好的产物，不起开发服务器。
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { EXEMPTIONS } from "./storybook-health-exemptions.mjs";

const { values: options } = parseArgs({
  options: {
    dir: { type: "string", default: "storybook-static" },
    workers: { type: "string", default: "4" },
    timeout: { type: "string", default: "45000" },
    filter: { type: "string" },
  },
});

const clientDir = process.cwd();
const staticDir = path.resolve(clientDir, options.dir);
const workers = Math.max(1, Number(options.workers) || 1);
const storyTimeout = Math.max(1_000, Number(options.timeout) || 45_000);
const filter = options.filter ? new RegExp(options.filter, "i") : null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

/** 只服务静态目录内的文件：请求路径里的 `..` 不能把工作区其它文件读出去。 */
async function resolveRequest(pathname) {
  const target = path.resolve(staticDir, `.${pathname}`);
  if (target !== staticDir && !target.startsWith(staticDir + path.sep)) return null;
  const info = await stat(target).catch(() => null);
  if (info?.isDirectory()) return resolveRequest(path.posix.join(pathname, "index.html"));
  return info?.isFile() ? target : null;
}

function serveStatic(request, response) {
  const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
  resolveRequest(pathname)
    .then((file) => {
      if (!file) {
        response.writeHead(404).end("Not Found");
        return;
      }
      response.writeHead(200, {
        "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      createReadStream(file).pipe(response);
    })
    .catch(() => response.writeHead(500).end("Internal Error"));
}

/** 只绑回环地址，端口交给系统分配，避免与用户已在跑的服务抢端口。 */
async function startStaticServer() {
  const server = createServer(serveStatic);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function stopStaticServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/** 单故事硬上限：Playwright 各步自己的超时之外再兜一层，卡住的页面不能拖住整批。 */
async function withinDeadline(work, message) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), storyTimeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 等故事渲染收尾：有 play 函数的故事要等它跑完，终态之后才判健康。 */
async function waitForSettled(page) {
  await page.waitForFunction(
    () =>
      (globalThis.__STORYBOOK_PREVIEW__?.storyRenders ?? []).some((render) =>
        ["finished", "errored", "aborted"].includes(render.phase)
      ),
    undefined,
    { timeout: storyTimeout }
  );
}

async function collectIssues(page) {
  const issues = [];
  if (await page.locator("body.sb-show-errordisplay").count()) {
    const message = await page
      .locator("#error-message")
      .innerText()
      .catch(() => "");
    issues.push(`出错界面：${message.trim() || "Storybook 未给出消息"}`);
  }
  // 弹窗、抽屉、浮层由 Portal 挂在 body 上而不是故事根节点里，只查根节点会把它们全判成空。
  // Storybook 自己的骨架块（sb- 前缀类名、storybook- 前缀 id）与脚本样式不算故事的产出。
  const empty = await page.locator("body").evaluate((body) => {
    const fromStory = (node) =>
      node.id === "storybook-root" ||
      (!["SCRIPT", "STYLE", "TEMPLATE"].includes(node.tagName) &&
        !node.id.startsWith("storybook-") &&
        !(node.getAttribute("class") ?? "").startsWith("sb-"));
    const hasContent = (node) => node.childElementCount > 0 || Boolean(node.textContent?.trim());
    return ![...body.children].some((node) => fromStory(node) && hasContent(node));
  });
  if (empty) issues.push("故事没有渲染出内容");
  return issues;
}

async function inspectStory(browser, baseUrl, story) {
  // 只在手机宽度成立的故事（移动端覆盖面板）在桌面宽度下根本没有那些控件，play 会无从点起。
  const viewport = (story.tags ?? []).includes("mobile")
    ? { width: 390, height: 844 }
    : { width: 1440, height: 900 };
  const context = await browser.newContext({ reducedMotion: "reduce", viewport });
  context.setDefaultTimeout(storyTimeout);
  const issues = [];
  try {
    const page = await context.newPage();
    // 故事只允许访问本机资源：外网请求既让结果不可复现，也不该在门禁里真发出去。
    await page.route("**/*", (route) => {
      const { hostname } = new URL(route.request().url());
      return ["127.0.0.1", "localhost"].includes(hostname) ||
        route.request().url().startsWith("data:")
        ? route.continue()
        : route.abort();
    });
    page.on("pageerror", (error) => issues.push(`页面异常：${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") issues.push(`控制台报错：${message.text()}`);
    });
    const globals = encodeURIComponent("theme:light;motion:off");
    const url = `${baseUrl}/iframe.html?viewMode=story&id=${encodeURIComponent(story.id)}&globals=${globals}`;
    await withinDeadline(
      (async () => {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await waitForSettled(page);
        issues.push(...(await collectIssues(page)));
      })(),
      `超时：${storyTimeout} 毫秒内没有渲染收尾`
    );
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  } finally {
    await context.close();
  }
  return { story, issues };
}

/** 豁免按「故事编号 + 报错文本片段」双条件命中，只放过登记过的那一条报错。 */
function partition(issues, storyId) {
  const exempted = [];
  const blocking = [];
  for (const issue of issues) {
    const hit = EXEMPTIONS.find((entry) => entry.id === storyId && issue.includes(entry.fragment));
    if (hit) exempted.push({ issue, reason: hit.reason });
    else blocking.push(issue);
  }
  return { exempted, blocking };
}

function assertExemptionsUsable() {
  for (const entry of EXEMPTIONS) {
    if (!entry.id || !entry.fragment || !entry.reason)
      throw new Error("豁免清单每条都要有故事编号、报错文本片段与理由，不许整类静音");
  }
}

async function readStories() {
  const indexPath = path.join(staticDir, "index.json");
  const raw = await readFile(indexPath, "utf8").catch(() => null);
  if (raw === null) throw new Error(`读不到 ${indexPath}，先运行 build-storybook`);
  const index = JSON.parse(raw);
  return Object.values(index.entries)
    .filter((entry) => entry.type === "story")
    .filter((entry) => !filter || filter.test(entry.id) || filter.test(entry.title));
}

async function main() {
  assertExemptionsUsable();
  const stories = await readStories();
  if (!stories.length) throw new Error("没有匹配的故事");
  const startedAt = Date.now();
  const { server, baseUrl } = await startStaticServer();
  let browser = null;
  const failures = [];
  let exemptedCount = 0;
  try {
    browser = await chromium.launch();
    const queue = [...stories];
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (let story = queue.shift(); story; story = queue.shift()) {
          const { issues } = await inspectStory(browser, baseUrl, story);
          const { exempted, blocking } = partition(issues, story.id);
          exemptedCount += exempted.length;
          if (blocking.length) {
            failures.push({ story, blocking });
            console.log(`✗ ${story.id}`);
            for (const issue of blocking) console.log(`    ${issue}`);
          }
        }
      })
    );
  } finally {
    await browser?.close();
    await stopStaticServer(server);
  }
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\n故事 ${stories.length} 个，健康 ${stories.length - failures.length} 个，不健康 ${failures.length} 个，` +
      `豁免报错 ${exemptedCount} 条，用时 ${seconds} 秒（并发 ${workers}）。`
  );
  if (failures.length) {
    console.log("不健康的故事：");
    for (const { story } of failures)
      console.log(`  ${story.id}（${story.title} / ${story.name}）`);
    process.exitCode = 1;
  }
}

await main();
