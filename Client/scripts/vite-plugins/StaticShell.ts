/** 为爬虫与分享卡生成静态 HTML 外壳。 */
import path from "path";
import fs from "fs";
import {
  PAGE_META,
  SITE_NAME,
  SITE_ORIGIN,
  SITE_TAGLINE,
  buildFaqStructuredData,
  type PageMeta,
} from "../../src/data/PageMeta.ts";

const STATIC_SEO_ATTRIBUTE = "data-static-seo";
const STRUCTURED_DATA_ID = "bakagame-structured-data";
const FAQ_STRUCTURED_DATA_ID = "bakagame-faq-structured-data";
// 清空外壳的内联脚本（构建后必须存在，缺失即断言失败）
const SHELL_CLEAR_CODE = 'document.getElementById("root").replaceChildren()';

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// FAQ 是每页的必备内容：缺问答、空条目或重复问题，直接让构建失败——
// 这块内容用户不可见，坏了不会有任何观感反馈，只能靠断言拦在部署前。
function assertShellFaq(): void {
  for (const meta of PAGE_META) {
    if (meta.faq.length === 0) {
      throw new Error(`静态外壳：${meta.path} 缺少 FAQ 问答文案`);
    }
    const questions = new Set<string>();
    for (const item of meta.faq) {
      if (!item.q.trim() || !item.a.trim()) {
        throw new Error(`静态外壳：${meta.path} 的 FAQ 存在空问题或空答案`);
      }
      if (questions.has(item.q)) {
        throw new Error(`静态外壳：${meta.path} 的 FAQ 问题重复（${item.q}）`);
      }
      questions.add(item.q);
    }
  }
}

// 分享标语是所有登记页 description 的第一句：社媒卡片只展示前两行，
// 标语一旦被后文挤掉，分享出去的效果就直接退化——用断言把它钉死在构建前。
function assertShareDescription(): void {
  for (const meta of PAGE_META) {
    if (!meta.description.startsWith(SITE_TAGLINE)) {
      throw new Error(`静态外壳：${meta.path} 的描述未以分享标语「${SITE_TAGLINE}」开头`);
    }
  }
}

/** 单页静态外壳：在 index.html 原文上补齐 head 元信息与正文，并给出双形态落盘路径。 */
function buildShellPage(
  original: string,
  meta: PageMeta
): { path: string; html: string; outputs: string[] } {
  const canonical = `${SITE_ORIGIN}${meta.path}`;
  const description = escapeHtml(meta.description);
  const image = escapeHtml(meta.image ?? `${SITE_ORIGIN}/og/logo.jpg`);
  const faqStructuredData = buildFaqStructuredData(meta.faq);
  const head = [
    `<meta name="description" content="${description}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    ...(meta.keywords && meta.keywords.length > 0
      ? [
          `<meta name="keywords" content="${escapeHtml(meta.keywords.join(", "))}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
        ]
      : []),
    `<link rel="canonical" href="${canonical}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta name="robots" content="index,follow" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta property="og:type" content="website" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta property="og:title" content="${SITE_NAME}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta property="og:description" content="${description}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta property="og:image" content="${image}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta property="og:url" content="${canonical}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta name="twitter:card" content="summary_large_image" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta name="twitter:title" content="${SITE_NAME}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta name="twitter:description" content="${description}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<meta name="twitter:image" content="${image}" ${STATIC_SEO_ATTRIBUTE}="1" />`,
    `<script id="${STRUCTURED_DATA_ID}" type="application/ld+json">${JSON.stringify(meta.structuredData)}</script>`,
    ...(faqStructuredData
      ? [
          `<script id="${FAQ_STRUCTURED_DATA_ID}" type="application/ld+json">${JSON.stringify(faqStructuredData)}</script>`,
        ]
      : []),
  ].join("\n    ");

  const body = [
    `<h1>${escapeHtml(meta.shell.h1)}</h1>`,
    ...meta.shell.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    `<ul>${meta.shell.links
      .map((link) => `<li><a href="${link.href}">${escapeHtml(link.label)}</a></li>`)
      .join("")}</ul>`,
    `<section><h2>常见问题</h2>${meta.faq
      .map((item) => `<h3>${escapeHtml(item.q)}</h3><p>${escapeHtml(item.a)}</p>`)
      .join("")}</section>`,
  ].join("");

  const html = original
    .replace("</head>", `  ${head}\n  </head>`)
    .replace(
      '<div id="root"></div>',
      `<div id="root"><main>${body}</main></div>\n    <script>${SHELL_CLEAR_CODE}</script>`
    );

  const segment = meta.path.replace(/^\//, "").replace(/\/$/, "");
  return {
    path: meta.path,
    html,
    // 双形态落盘：目录索引型主机与 clean URL 型主机各覆盖一种，别名 canonical 指向正式路径。
    outputs: segment === "" ? ["index.html"] : [`${segment}/index.html`, `${segment}.html`],
  };
}

export function staticShellPlugin() {
  return {
    name: "static-shell",
    apply: "build" as const,
    async closeBundle() {
      const distDir = path.resolve(import.meta.dirname, "../../dist");
      const indexPath = path.join(distDir, "index.html");
      const original = fs.readFileSync(indexPath, "utf8");

      // 注入点缺失时宁可让构建失败，也不要静默产出一个空壳站点。
      if (!original.includes('<div id="root"></div>')) {
        throw new Error("静态外壳：dist/index.html 里找不到空的 #root 容器");
      }
      if (!original.includes("</head>")) {
        throw new Error("静态外壳：dist/index.html 里找不到 </head>");
      }

      assertShellFaq();
      assertShareDescription();

      const pages = PAGE_META.map((meta) => buildShellPage(original, meta));

      // 先全部生成再落盘：index.html 同时是模板来源，边读边写会污染后续路由。
      for (const page of pages) {
        for (const output of page.outputs) {
          const target = path.join(distDir, output);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, page.html);
        }
        const primary = path.join(distDir, page.outputs[0]);
        const written = fs.readFileSync(primary, "utf8");
        for (const marker of [
          '<div id="root"><main>',
          SHELL_CLEAR_CODE,
          `${STATIC_SEO_ATTRIBUTE}="1"`,
          STRUCTURED_DATA_ID,
          FAQ_STRUCTURED_DATA_ID,
          "常见问题",
          SITE_TAGLINE,
        ]) {
          if (!written.includes(marker)) {
            throw new Error(`静态外壳：${page.outputs[0]} 缺少 ${marker}`);
          }
        }
      }

      console.log(`静态外壳注入完成：${pages.map((page) => page.path).join("、")}`);
    },
  };
}

// ==================== Vite 插件：SEO 产物生成（站点地图与分享图） ====================
// 两个产物、同一个来源：PageMeta。
//
// 站点地图曾手写在 public/sitemap.xml：新增可收录页面靠人记得同步，漏改没有任何报错，
// 而缺页只会让搜索引擎更晚发现新内容——静默漂移。改为构建末尾按 PAGE_META 生成，
// URL 集合回到单一真相源；lastmod 由各页在文案显著变更时手动维护，不随构建刷新
// （每次构建都变的 lastmod 会被搜索引擎判定不可信，进而整体忽略）。
//
// 分享图：全站图片管线只产 webp，而部分分享抓取器（QQ 实测）不认 webp，卡片显示不出图。
// 这里为 PageMeta.image 指向的每张站内分享图转制一份 jpg（/og/<名>.jpg，源图为
// public/assets 下的同名文件，png / jpg / gif / webp 均可；gif 取第一帧）。
// 外链分享图原样放行，不转制。
