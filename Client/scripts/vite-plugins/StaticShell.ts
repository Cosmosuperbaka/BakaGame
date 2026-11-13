/**
 * 为爬虫与分享卡生成静态 HTML 外壳。
 *
 * 本站是纯前端 SPA，构建产物的 <div id="root"> 是空的：执行 JS 的爬虫能自己渲染，
 * 不执行 JS 的爬虫（百度为主）只能读到空壳。此插件在构建末尾把 PageMeta 里的正文与
 * head 元信息写进各路由的 HTML，爬虫无需执行 JS 即可读到内容。
 *
 * 为什么是「构建期字符串注入」而不是无头浏览器预渲染：平台构建容器不提供 Chromium
 * （实测报错 Executable doesn't exist ... chromium_headless_shell），而带着一个 150MB
 * 的浏览器依赖去构建既慢又脆。本站可收录页面的正文本来就是数据（PageMeta），
 * 直接由数据生成 HTML 更简单也更可靠。
 *
 * 注入的 head 标签全部带 data-static-seo="1"：这些标签只服务不执行 JS 的爬虫，
 * 应用启动时会由 stripStaticSeo() 整体移除，再交给 react-helmet-async 写入当前路由的真值。
 * 为什么不是「让 Helmet 接管」：react-helmet-async v3 在 React 19 下不走 DOM 复用路径
 * （client.ts 里按 isEqualNode 复用旧标签的逻辑只在旧路径生效），它会直接渲染新标签，
 * 静态标签留在原地就会变成重复 canonical —— 搜索引擎遇到重复 canonical 会判定整组失效。
 * JSON-LD 例外：结构化数据与 FAQPage 各用一个固定 id，Seo 的 useEffect 按同一 id 覆盖内容，不产生重复。
 *
 * 正文外壳必须在**首次绘制之前**从执行 JS 的客户端里消失，否则用户进站会先看到一段裸文本。
 * 入口是 defer 的 module 脚本（懒加载路由 chunk 还要再等一次网络），执行时机在首帧之后，
 * 只靠它替换 #root 就会漏出这段文字。因此在外壳之后紧邻插入一段 parser-blocking 内联脚本，
 * 随解析同步清空外壳：它被 <head> 里的渲染阻塞样式表挡住，必然早于首次绘制执行。
 * 不执行 JS 的爬虫读的是原始 HTML，外壳照旧可见——两边的正文本来就是同一份。
 *
 * 为什么不用 `#root{display:none}` 之类的 CSS 兜底：那等于把正文标成隐藏文本，
 * 在审核视角下与 hidden text 无异。此处不隐藏任何东西，只是让 JS 客户端先移除、再交给应用渲染。
 * 也不用 <noscript>：目标恰恰是不执行 JS 的爬虫，而 noscript 里的内容在多数引擎眼中信号更弱。
 */
import path from "path";
import fs from "fs";
import {
  PAGE_META,
  SITE_NAME,
  SITE_TAGLINE,
  buildBreadcrumbStructuredData,
  buildFaqStructuredData,
  buildHeadTags,
  type HeadTag,
  type PageMeta,
} from "../../src/data/PageMeta.ts";

const STATIC_SEO_ATTRIBUTE = "data-static-seo";
const STRUCTURED_DATA_ID = "bakagame-structured-data";
const FAQ_STRUCTURED_DATA_ID = "bakagame-faq-structured-data";
const BREADCRUMB_STRUCTURED_DATA_ID = "bakagame-breadcrumb-structured-data";
// 清空外壳的内联脚本（构建后必须存在，缺失即断言失败）
const SHELL_CLEAR_CODE = 'document.getElementById("root").replaceChildren()';

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 静态标签统一带 data-static-seo，应用启动时据此整体摘掉，再由 Helmet 写当前路由的真值。 */
function serializeHeadTag(tag: HeadTag): string {
  const attrs = Object.entries(tag.attrs)
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
    .join(" ");
  return `<${tag.kind} ${attrs} ${STATIC_SEO_ATTRIBUTE}="1" />`;
}

/** 一段 JSON-LD：固定 id 让运行时 Seo 按同一 id 覆盖、不产生重复；数据为空时不写。 */
function jsonLdScript(id: string, data: Record<string, unknown> | null): string[] {
  return data
    ? [`<script id="${id}" type="application/ld+json">${JSON.stringify(data)}</script>`]
    : [];
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

/** index.html 的兜底标题：未登记的路径启动前显示它，登记页面在构建期替换成各自的标题。 */
const FALLBACK_TITLE = `<title>${SITE_NAME}</title>`;

/** 单页静态外壳：在 index.html 原文上补齐 head 元信息与正文，并给出双形态落盘路径。 */
function buildShellPage(
  original: string,
  meta: PageMeta
): { path: string; title: string; html: string; outputs: string[] } {
  const title = escapeHtml(meta.title);
  const head = [
    ...buildHeadTags({ ...meta, indexable: true }).map(serializeHeadTag),
    ...jsonLdScript(STRUCTURED_DATA_ID, meta.structuredData),
    ...jsonLdScript(FAQ_STRUCTURED_DATA_ID, buildFaqStructuredData(meta.faq)),
    ...jsonLdScript(BREADCRUMB_STRUCTURED_DATA_ID, buildBreadcrumbStructuredData(meta)),
  ].join("\n    ");

  const body = [
    `<h1>${escapeHtml(meta.shell.h1)}</h1>`,
    ...meta.shell.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    ...(meta.shell.sections ?? []).map(
      (section) =>
        `<section><h2>${escapeHtml(section.heading)}</h2>${section.paragraphs
          .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
          .join("")}</section>`
    ),
    `<ul>${meta.shell.links
      .map((link) => `<li><a href="${link.href}">${escapeHtml(link.label)}</a></li>`)
      .join("")}</ul>`,
    `<section><h2>常见问题</h2>${meta.faq
      .map((item) => `<h3>${escapeHtml(item.q)}</h3><p>${escapeHtml(item.a)}</p>`)
      .join("")}</section>`,
  ].join("");

  const html = original
    .replace(FALLBACK_TITLE, `<title>${title}</title>`)
    .replace("</head>", `  ${head}\n  </head>`)
    .replace(
      '<div id="root"></div>',
      `<div id="root"><main>${body}</main></div>\n    <script>${SHELL_CLEAR_CODE}</script>`
    );

  const segment = meta.path.replace(/^\//, "").replace(/\/$/, "");
  return {
    path: meta.path,
    title: meta.title,
    html,
    // 双形态落盘：目录索引型主机与 clean URL 型主机各覆盖一种，别名 canonical 指向正式路径。
    outputs: segment === "" ? ["index.html"] : [`${segment}/index.html`, `${segment}.html`],
  };
}

export function staticShellPlugin() {
  let distDir = path.resolve(import.meta.dirname, "../../dist");
  return {
    name: "static-shell",
    apply: "build" as const,
    // 产物目录取自实际生效的构建配置，不写死 ../../dist。
    configResolved(config: { root: string; build: { outDir: string } }) {
      distDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const indexPath = path.join(distDir, "index.html");
      const original = fs.readFileSync(indexPath, "utf8");

      // 注入点缺失时宁可让构建失败，也不要静默产出一个空壳站点。
      if (!original.includes('<div id="root"></div>')) {
        throw new Error("静态外壳：dist/index.html 里找不到空的 #root 容器");
      }
      if (!original.includes("</head>")) {
        throw new Error("静态外壳：dist/index.html 里找不到 </head>");
      }
      if (!original.includes(FALLBACK_TITLE)) {
        throw new Error(`静态外壳：dist/index.html 里找不到 ${FALLBACK_TITLE}`);
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
          `<title>${escapeHtml(page.title)}</title>`,
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
