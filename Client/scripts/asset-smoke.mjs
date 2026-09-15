import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import sharp from "sharp";

const clientDir = process.cwd();
const distDir = path.join(clientDir, "dist");
const port = 4173;
const baseUrl = `http://127.0.0.1:${port}`;

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(absolute));
    else result.push(absolute);
  }
  return result;
}

async function waitForPreview() {
  const preview = spawn(
    process.execPath,
    [path.join(clientDir, "node_modules/vite/bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: clientDir, stdio: "ignore", windowsHide: true },
  );

  try {
    // 上限 30 秒：本机 vite.config 的图片预处理会让 preview 冷启动明显超过 7.5 秒，
    // 预算过短会把「服务还没起来」误判成「服务起不来」。
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/`);
        if (response.ok) return preview;
      } catch {
        // preview 尚未监听，继续等待。
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Vite preview 未能在 30 秒内就绪");
  } catch (error) {
    preview.kill();
    throw error;
  }
}

async function assertAsset(urlPath, expectedType = "image/webp") {
  const response = await fetch(`${baseUrl}${urlPath}`);
  if (!response.ok) throw new Error(`${urlPath} 返回 HTTP ${response.status}`);
  const type = response.headers.get("content-type")?.split(";", 1)[0];
  if (type !== expectedType) throw new Error(`${urlPath} MIME 为 ${type ?? "空"}，预期 ${expectedType}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0) throw new Error(`${urlPath} 返回空文件`);
  if (expectedType === "image/webp") {
    const metadata = await sharp(body).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`${urlPath} 无有效图片尺寸`);
  }
}

const preview = await waitForPreview();
try {
  const files = await walk(distDir);
  const relativeFiles = files.map((file) => `/${path.relative(distDir, file).split(path.sep).join("/")}`);
  const required = ["/assets/favicon.webp", "/assets/Faker.webp", "/assets/SongGuessr.webp", "/assets/CCB.webp", "/assets/logo.webp"];

  for (const asset of required) {
    if (!relativeFiles.includes(asset)) throw new Error(`构建产物缺少 ${asset}`);
    await assertAsset(asset);
  }

  const stickerFiles = relativeFiles.filter((file) => /^\/stickers\/[0-9a-f]{24}\.webp$/.test(file));
  if (stickerFiles.length === 0) throw new Error("构建产物没有哈希贴纸资源");
  for (const sticker of stickerFiles) await assertAsset(sticker);

  for (const route of ["/", "/whoisfaker", "/songuessr", "/unknown-route"]) {
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
    { route: "/", text: "免下载的网页版派对游戏站", canonical: "https://game.baka.website/" },
    { route: "/whoisfaker", text: "谁是卧底", canonical: "https://game.baka.website/whoisfaker" },
    { route: "/songuessr", text: "听歌猜歌", canonical: "https://game.baka.website/songuessr" },
  ];
  for (const { route, text, canonical } of shellChecks) {
    const html = await (await fetch(`${baseUrl}${route}`)).text();
    const markers = [
      '<div id="root"><main>',
      `<link rel="canonical" href="${canonical}" data-static-seo="1" />`,
      `<meta name="description"`,
      'type="application/ld+json"',
      '<title>BakaGame</title>',
      text,
    ];
    for (const marker of markers) {
      if (!html.includes(marker)) throw new Error(`${route} 的静态外壳缺少：${marker}`);
    }
  }

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

  console.log(`资源冒烟通过：${required.length} 个固定资源、${stickerFiles.length} 个贴纸、4 个 SPA 路由、${shellChecks.length} 个静态外壳`);
} finally {
  preview.kill();
  await stat(distDir);
}
