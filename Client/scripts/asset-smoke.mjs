import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { preview as createPreview } from "vite";
import process from "node:process";
import sharp from "sharp";

const clientDir = process.cwd();
const distDir = path.join(clientDir, "dist");
async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(absolute));
    else result.push(absolute);
  }
  return result;
}

// 只服务已有 dist：不加载会重建 .generated-public 的项目配置，也不读取 .env 或代理到后端。
const preview = await createPreview({
  root: clientDir,
  configFile: false,
  envDir: false,
  build: { outDir: distDir },
  preview: { host: "127.0.0.1", port: 0, strictPort: true },
});
const address = preview.httpServer.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

async function assertAsset(urlPath, expectedType = "image/webp") {
  const response = await fetch(`${baseUrl}${urlPath}`);
  if (!response.ok) throw new Error(`${urlPath} 返回 HTTP ${response.status}`);
  const type = response.headers.get("content-type")?.split(";", 1)[0];
  if (type !== expectedType) throw new Error(`${urlPath} MIME 为 ${type ?? "空"}，预期 ${expectedType}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0) throw new Error(`${urlPath} 返回空文件`);
  if (expectedType === "image/webp" || expectedType === "image/jpeg") {
    const metadata = await sharp(body).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`${urlPath} 无有效图片尺寸`);
  }
}

try {
  const files = await walk(distDir);
  const relativeFiles = files.map((file) => `/${path.relative(distDir, file).split(path.sep).join("/")}`);
  const required = ["/assets/favicon.webp", "/assets/Faker.webp", "/assets/SongGuessr.webp", "/assets/CEE.webp", "/assets/logo.webp"];

  for (const asset of required) {
    if (!relativeFiles.includes(asset)) throw new Error(`构建产物缺少 ${asset}`);
    await assertAsset(asset);
  }

  // 自备品牌 SVG：页面用 CSS mask 引用这些固定路径，构建时既不能被 webp 管线改写，
  // 也不能因为漏拷 public/ 而在线上变成空白图标。AI 厂商/模型字形来自
  // @lobehub/icons-static-svg 的 ?url 导入，SVG 体积小会被 Vite 内联进页面分块，
  // 因此这里只守护仍需从 public/ 提供的三个资产。
  const brandAssets = [
    "/assets/brands/elysia.svg",
    "/assets/brands/playwright.svg",
    "/assets/brands/zustand.svg",
  ];
  for (const asset of brandAssets) {
    if (!relativeFiles.includes(asset)) throw new Error(`构建产物缺少 ${asset}`);
    await assertAsset(asset, "image/svg+xml");
  }

  const stickerFiles = relativeFiles.filter((file) => /^\/stickers\/[0-9a-f]{24}\.webp$/.test(file));
  if (stickerFiles.length === 0) throw new Error("构建产物没有哈希贴纸资源");
  for (const sticker of stickerFiles) await assertAsset(sticker);

  const spaRoutes = ["/", "/whoisfaker", "/songuessr", "/cee", "/credits", "/unknown-route"];
  for (const route of spaRoutes) {
    const response = await fetch(`${baseUrl}${route}`);
    if (!response.ok) throw new Error(`${route} 返回 HTTP ${response.status}`);
    const html = await response.text();
    if (!html.includes("<div id=\"root\">") || !html.includes("bakagame-build")) {
      throw new Error(`${route} 不是可启动的 SPA 入口`);
    }
  }

  // 静态外壳：不执行 JS 的爬虫必须能读到正文与 head 元信息（构建期由 static-shell 插件注入）。
  // 这里只做「有没有」的断言；「会不会产生重复标签」由 E2E 用真实浏览器断言（strict 定位器）。
  const shellChecks = [
    { route: "/", text: "二刺猿派对小游戏合集站", canonical: "https://game.baka.website/" },
    { route: "/whoisfaker", text: "谁是卧底", canonical: "https://game.baka.website/whoisfaker" },
    { route: "/songuessr", text: "音乐与动漫番剧竞猜", canonical: "https://game.baka.website/songuessr" },
    { route: "/cee", text: "在线猜动漫角色", canonical: "https://game.baka.website/cee" },
    { route: "/credits", text: "开源致谢", canonical: "https://game.baka.website/credits" },
  ];
  for (const { route, text, canonical } of shellChecks) {
    const html = await (await fetch(`${baseUrl}${route}`)).text();
    const markers = [
      '<div id="root"><main>',
      // 外壳清除脚本：执行 JS 的客户端必须在首帧前清空外壳，否则用户进站会先看到一段裸文本
      'document.getElementById("root").replaceChildren()',
      `<link rel="canonical" href="${canonical}" data-static-seo="1" />`,
      `<meta name="description"`,
      'type="application/ld+json"',
      '<title>BakaGame</title>',
      // FAQ：每页问答正文 + FAQPage 结构化数据（构建期由 static-shell 插件注入，用户不可见）
      'id="bakagame-faq-structured-data"',
      '"@type":"FAQPage"',
      "常见问题",
      text,
    ];
    for (const marker of markers) {
      if (!html.includes(marker)) throw new Error(`${route} 的静态外壳缺少：${marker}`);
    }
  }

  // 站点地图与分享图由构建期的 seo-artifacts 插件从 PageMeta 生成：
  // 站点地图手工维护时漏改不会报错，缺页只会让搜索引擎更晚发现内容；
  // 分享图必须是 jpg——部分分享抓取器（QQ 实测）不认 webp，卡片显示不出图。
  const sitemapLocs = [
    "https://game.baka.website/",
    "https://game.baka.website/whoisfaker",
    "https://game.baka.website/songuessr",
    "https://game.baka.website/cee",
    "https://game.baka.website/credits",
  ];
  const sitemapXml = await (await fetch(`${baseUrl}/sitemap.xml`)).text();
  for (const loc of sitemapLocs) {
    if (!sitemapXml.includes(`<loc>${loc}</loc>`)) throw new Error(`sitemap.xml 缺少 ${loc}`);
  }

  const ogImages = ["/og/logo.jpg", "/og/Faker.jpg", "/og/SongGuessr.jpg", "/og/CEE.jpg"];
  for (const og of ogImages) await assertAsset(og, "image/jpeg");

  const htmlFiles = files.filter((file) => file.endsWith(".html"));
  const html = (await Promise.all(htmlFiles.map((file) => readFile(file, "utf8")))).join("\n");
  if (/\/assets\/(?:[^\"']+\.(?:png|jpe?g|gif))/.test(html)) {
    throw new Error("HTML 仍引用未转换的图片资源");
  }

  const jsFiles = files.filter((file) => file.endsWith(".js"));
  const js = (await Promise.all(jsFiles.map((file) => readFile(file, "utf8")))).join("\n");
  if (/\/assets\/(?:[^\"']+\.(?:png|jpe?g|gif))/.test(js)) {
    throw new Error("JavaScript bundle 仍引用未转换的图片资源");
  }

  console.log(
    `资源冒烟通过：${required.length} 个固定资源、${brandAssets.length} 个品牌 SVG、${stickerFiles.length} 个贴纸、${spaRoutes.length} 个 SPA 路由、` +
      `${shellChecks.length} 个静态外壳（含 FAQ 问答）、${sitemapLocs.length} 条站点地图、${ogImages.length} 张分享图`,
  );
} finally {
  await preview.close();
}
