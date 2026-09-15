import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium } from "@playwright/test";

// 阶段二：预渲染，把静态路由变成真内容。
//
// 为什么必须做：本站是纯前端 SPA，构建产物里的 <div id="root"> 是空的。
// 执行 JS 的爬虫（Google）还能自己渲染，不执行 JS 的爬虫（百度为主）只能读到
// 一个空壳，收录与排名无从谈起。预渲染在构建期用真实浏览器把页面画完，
// 把最终 DOM 写回 dist，静态 HTML 里就同时有了正文与 head 元信息。
//
// 为什么不用 vite-plugin-prerender / react-snap：两者都已停更多年，peer 依赖与
// Vite 8 不匹配，还要各自捆绑一套浏览器依赖；Playwright 是本仓库既有开发依赖
// （E2E 在用），直接复用，不新增任何依赖。
//
// 不预渲染的页面：房间页（/whoisfaker/room/*、/songuessr/room/*、/songuessr/solo）
// 内容由服务端实时状态驱动，没有可静态化的正文，且已标 noindex。
//
// 产物落点：
//   /            → dist/index.html
//   /whoisfaker  → dist/whoisfaker/index.html（目录索引型主机）+ dist/whoisfaker.html（clean URL 型主机）
//   /songuessr   → dist/songuessr/index.html + dist/songuessr.html
// 两种落点是为了不赌主机的静态解析规则：目录索引与 clean URL 各覆盖一种。
// 别名（.html）与正式路径内容相同、canonical 指向正式路径，重复内容由 canonical 收敛。
// 客户端启动方式不变（createRoot 挂载后接管），快照只是首屏与爬虫看到的版本。

const clientDir = process.cwd();
const distDir = path.join(clientDir, "dist");
const indexPath = path.join(distDir, "index.html");
// 与 asset-smoke.mjs 的 4173 错开，两个脚本同时跑也不会抢端口。
const port = 4174;
const baseUrl = `http://127.0.0.1:${port}`;
const origin = "https://game.baka.website";

// keywords 为「正文里必须出现」的字符串（在 <head> 之外的部分匹配）：
// 缺任意一个都说明页面没画完或内容退化，宁可构建失败，也不要把空壳发上线。
const ROUTES = [
  {
    path: "/",
    outputs: ["index.html"],
    keywords: ["Who is Faker", "Songuessr", "友情链接"],
    canonical: `${origin}/`,
  },
  {
    path: "/whoisfaker",
    outputs: ["whoisfaker/index.html", "whoisfaker.html"],
    keywords: ["Who is", "房间列表", "返回主页"],
    canonical: `${origin}/whoisfaker`,
  },
  {
    path: "/songuessr",
    outputs: ["songuessr/index.html", "songuessr.html"],
    keywords: ["Songuessr", "房间列表", "返回主页"],
    canonical: `${origin}/songuessr`,
  },
];

async function startPreview() {
  const preview = spawn(
    process.execPath,
    [path.join(clientDir, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: clientDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );

  // 保留 preview 输出：起不来时把它带进错误信息，否则只能看到一句「未就绪」。
  let logs = "";
  preview.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  preview.stderr.on("data", (chunk) => { logs += chunk.toString(); });

  try {
    // 上限 60 秒：本机 vite.config 里的图片预处理会让 preview 冷启动明显慢于 7.5 秒，
    // 等待过短会把「服务还没起来」误判成「服务起不来」。
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/`);
        if (response.ok) return preview;
      } catch {
        // preview 尚未监听，继续等待。
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Vite preview 未能在 60 秒内就绪，输出：\n${logs.slice(-800) || "（无输出）"}`);
  } catch (error) {
    preview.kill();
    throw error;
  }
}

/**
 * 校验单页快照。这里断言的都是「爬虫视角」能拿到的东西：
 * 正文有真实文字、head 有元信息、脚本标签还在（保证真人访问时 SPA 照常启动）。
 */
function assertSnapshot(route, html, bytes) {
  const headEnd = html.indexOf("</head>");
  if (headEnd < 0) throw new Error(`${route.path} 快照缺少 </head>`);
  const head = html.slice(0, headEnd);
  const body = html.slice(headEnd);

  const problems = [];
  if (!body.includes('<div id="root">')) problems.push("缺少 #root 容器");
  if (body.includes("页面加载中")) problems.push("仍是懒加载占位，未等到页面画完");
  for (const keyword of route.keywords) {
    if (!body.includes(keyword)) problems.push(`正文缺少关键词「${keyword}」`);
  }
  if (body.length < 3000) problems.push(`正文过短（${body.length} 字符），疑似只抓到空壳`);

  const title = head.match(/<title>([^<]*)<\/title>/);
  if (title?.[1] !== "BakaGame") problems.push(`<title> 为「${title?.[1] ?? "缺失"}」，应为纯站名 BakaGame`);
  if (!/<meta name="description" content="[^"]+"/.test(head)) problems.push("缺少 meta description");
  if (!head.includes(`<link rel="canonical" href="${route.canonical}"`)) problems.push(`canonical 不是 ${route.canonical}`);
  if (!head.includes('<meta property="og:title" content="BakaGame"')) problems.push("og:title 不是站名");
  if (!head.includes('<meta name="robots" content="index,follow"')) problems.push("缺少可索引 robots 声明");
  if (!head.includes('type="application/ld+json"')) problems.push("缺少 JSON-LD 结构化数据");
  // 入口脚本标签在整篇文档里找：构建期 Vite 与运行期注入都可能把它放进 head。
  if (!/<script[^>]+src="\/assets\/[^"]+\.js"/.test(html)) problems.push("缺少入口脚本标签，SPA 将无法启动");

  if (problems.length > 0) {
    throw new Error(`${route.path} 预渲染快照不合格：\n  - ${problems.join("\n  - ")}`);
  }

  return { bytes, characters: body.length };
}

async function main() {
  const originalHtml = await readFile(indexPath, "utf8").catch(() => {
    throw new Error("找不到 dist/index.html，请先执行 npm run build");
  });
  const doctype = originalHtml.match(/<!doctype[^>]*>/i)?.[0] ?? "<!DOCTYPE html>";

  const preview = await startPreview();
  let browser;
  try {
    browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : undefined,
      timeout: 30_000,
    });

    // reducedMotion：framer-motion 在「减少动态效果」下直接落在终态，
    // 抓到的快照不带 opacity:0 / translateY 这类初始内联样式——正文是给爬虫看的，必须可见。
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      reducedMotion: "reduce",
    });

    const snapshots = [];
    for (const route of ROUTES) {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));

      // 不用 networkidle：页面会持续尝试连接 WebSocket，网络永远不会真正空闲。
      await page.goto(`${baseUrl}${route.path}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector("#root h1", { state: "attached", timeout: 20_000 });
      await page.waitForFunction(() => !document.querySelector('[aria-label="页面加载中"]'), null, { timeout: 20_000 });
      await page.waitForTimeout(200); // 留一帧给动画与字体收尾

      const html = `${doctype}\n${await page.content()}`;
      await page.close();

      if (errors.length > 0) {
        throw new Error(`${route.path} 渲染期间抛出未捕获异常：\n  - ${errors.join("\n  - ")}`);
      }
      snapshots.push({ route, html });
    }

    // 全部抓完再落盘：抓 /whoisfaker 时会经 preview 的 SPA 回退读 dist/index.html，
    // 提前覆盖它会污染后续路由的快照来源。
    for (const { route, html } of snapshots) {
      for (const output of route.outputs) {
        const target = path.join(distDir, output);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, html, "utf8");
      }
    }

    const summary = snapshots.map(({ route, html }) => ({
      route: route.path,
      ...assertSnapshot(route, html, Buffer.byteLength(html, "utf8")),
    }));

    for (const item of summary) {
      console.log(`  ${item.route} → ${(item.bytes / 1024).toFixed(1)} KB（正文 ${item.characters} 字符）`);
    }
    console.log(`预渲染通过：${summary.length} 个路由已写入 dist（首页、两个游戏大厅）`);
  } finally {
    await browser?.close();
    preview.kill();
  }
}

await main();
