/**
 * 出分享卡片：用无头浏览器把一份 HTML 模板截成 1200×630 的 PNG，写到 src/assets/og/。
 *
 * 用法：node --experimental-strip-types scripts/og-cards.mjs
 * 前提：本机跑过一次构建或开发服务器（字体子集生成器会把霞鹜文楷下载到 .cache/fonts）。
 *
 * 卡片是提交进仓库的源图，构建期由 seo-artifacts 插件转成 jpg 并校验尺寸；
 * 这个脚本只在改卡片设计或游戏名时手动跑，构建环境不需要浏览器（见 Deployment §4）。
 * 颜色取 index.css 的亮色令牌，字体只用项目自己的字体文件，图标只用 public/assets 下的自有素材。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, findPageMeta } from "../src/data/PageMeta.ts";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const outputDir = path.join(clientDir, "src/assets/og");
const fileUrl = (file) => pathToFileURL(file).href;

const FONT_CACHE = path.join(clientDir, ".cache/fonts/lxgw-wenkai-v1.530");
const KAI_FONT = path.join(FONT_CACHE, "LXGWWenKai-Regular.ttf");
const MONO_FONT = path.join(FONT_CACHE, "LXGWWenKaiMono-Regular.ttf");

/** 亮色令牌原样搬进模板：卡片是「纸与墨」的那张纸，不另调一套颜色。 */
function lightTokens() {
  const css = readFileSync(path.join(clientDir, "src/index.css"), "utf8");
  const root = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  const pick = (name) => {
    const value = root.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1];
    if (!value) throw new Error(`分享卡片：index.css 的 :root 里找不到 ${name}`);
    return `${name}: ${value.trim()};`;
  };
  return [
    "--background",
    "--foreground",
    "--muted-foreground",
    "--border",
    "--card",
    "--paper-grain",
  ]
    .map(pick)
    .join("\n");
}

/** 源图一律先转成首帧 PNG：动图在浏览器里截到哪一帧不确定。 */
async function iconDataUrl(name) {
  const png = await sharp(path.join(clientDir, "public/assets", name))
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

const CARDS = [
  {
    file: "og-faker.png",
    path: "/whoisfaker",
    icon: "Faker.png",
    title: "Who is Faker",
    zh: "谁是卧底",
  },
  {
    file: "og-song.png",
    path: "/songuessr",
    icon: "SongGuessr.gif",
    title: "Songuessr",
    zh: "听歌猜歌",
  },
  { file: "og-cee.png", path: "/cee", icon: "CEE.jpg", title: "CEE", zh: "猜动漫角色" },
];

const pageStyle = () => `
  @font-face { font-family: "LXGW WenKai"; src: url("${fileUrl(KAI_FONT)}"); }
  @font-face { font-family: "LXGW WenKai Mono"; src: url("${fileUrl(MONO_FONT)}"); }
  :root { ${lightTokens()} }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${OG_IMAGE_WIDTH}px; height: ${OG_IMAGE_HEIGHT}px; }
  body {
    position: relative;
    overflow: hidden;
    background-color: var(--background);
    background-image: var(--paper-grain);
    background-size: 160px 160px;
    color: var(--foreground);
    font-family: "LXGW WenKai", serif;
  }
  /* 一张摆在桌上的牌：细边框画出牌面，不加阴影与色块。 */
  .frame {
    position: absolute;
    inset: 32px;
    border: 2px solid var(--border);
    border-radius: 10px;
  }
  .serif { font-family: "Libre Baskerville", "Noto Serif SC Variable", serif; }
  .zh { font-family: "Noto Serif SC Variable", serif; }
  .muted { color: var(--muted-foreground); }
  .footer {
    position: absolute;
    left: 96px;
    right: 96px;
    bottom: 72px;
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 26px;
  }
  .mono { font-family: "LXGW WenKai Mono", monospace; }
`;

const shell = (body) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<link rel="stylesheet" href="${fileUrl(require.resolve("@fontsource/libre-baskerville/700.css"))}" />
<link rel="stylesheet" href="${fileUrl(require.resolve("@fontsource-variable/noto-serif-sc/index.css"))}" />
<style>${pageStyle()}</style></head>
<body><div class="frame"></div>${body}</body></html>`;

function gameCard({ title, zh, line, icon, path: route }) {
  return shell(`
  <div style="position:absolute;left:96px;right:96px;top:96px;bottom:150px;display:flex;align-items:center;gap:64px;">
    <img src="${icon}" alt="" style="width:264px;height:264px;object-fit:cover;border-radius:10px;border:2px solid var(--border);flex:none;" />
    <div style="min-width:0;">
      <div class="serif" style="font-size:84px;font-weight:700;line-height:1.1;">${title}</div>
      <div class="zh" style="font-size:46px;font-weight:600;margin-top:22px;">${zh}</div>
      <div class="muted" style="font-size:32px;margin-top:26px;">${line}</div>
    </div>
  </div>
  <div class="footer"><span class="serif muted" style="font-weight:700;">BakaGame</span><span class="mono muted">${route}</span></div>`);
}

function homeCard({ logo, line }) {
  return shell(`
  <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:40px;padding-bottom:20px;">
    <div class="serif" style="display:flex;align-items:center;gap:28px;font-size:120px;font-weight:700;line-height:1;">
      Baka<img src="${logo}" alt="" style="height:132px;border-radius:10px;" />Game
    </div>
    <div class="muted" style="font-size:38px;">${line}</div>
  </div>`);
}

mkdirSync(outputDir, { recursive: true });
const workDir = mkdtempSync(path.join(tmpdir(), "og-cards-"));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT },
    deviceScaleFactor: 1,
  });
  const jobs = [
    {
      file: "og-home.png",
      html: homeCard({ logo: await iconDataUrl("logo.gif"), line: findPageMeta("/").oneLiner }),
    },
    ...(await Promise.all(
      CARDS.map(async (card) => ({
        file: card.file,
        html: gameCard({
          ...card,
          line: findPageMeta(card.path).oneLiner,
          icon: await iconDataUrl(card.icon),
        }),
      }))
    )),
  ];
  for (const { file, html } of jobs) {
    // 模板落成本地文件再打开：从 about:blank 起的页面不许加载 file:// 下的字体与样式表。
    const htmlPath = path.join(workDir, file.replace(/\.png$/, ".html"));
    writeFileSync(htmlPath, html);
    await page.goto(fileUrl(htmlPath), { waitUntil: "load" });
    await page.evaluate("document.fonts.ready");
    await page.screenshot({ path: path.join(outputDir, file) });
    console.log(`分享卡片：${file}`);
  }
} finally {
  await browser.close();
  rmSync(workDir, { recursive: true, force: true });
}
