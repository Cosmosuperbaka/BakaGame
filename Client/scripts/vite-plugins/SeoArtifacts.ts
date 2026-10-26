/** 输出 OG 分享图等 SEO 构建产物。 */
import path from "path";
import fs from "fs";
import sharp from "sharp";
import { PAGE_META, SITE_ORIGIN } from "../../src/data/PageMeta.ts";

const OG_IMAGE_ROUTE = "/og/";
const OG_SOURCE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

/**
 * 收集「目标名 → 源文件」。
 *
 * 多个页面可以共用同一张分享图（首页与 /ceo 都用 logo.jpg），所以这里按名字去重：
 * 同一个目标路径不能交给两路 sharp 并发写 —— 写完的那路与截断的那路重叠，
 * 紧接着的 size 检查会读到 0 字节，报「分享图是空文件」，而源图与产物本身都没问题。
 * 校验仍然对每个页面各做一次，只有落盘按唯一目标执行。
 */
function collectOgTargets(sourceDir: string): Map<string, string> {
  const sourceFiles = fs.readdirSync(sourceDir);
  const ogPrefix = `${SITE_ORIGIN}${OG_IMAGE_ROUTE}`;
  const targets = new Map<string, string>();

  for (const page of PAGE_META) {
    const image = page.image;
    if (!image || !image.startsWith(SITE_ORIGIN)) continue; // 未配置或外链分享图原样使用

    if (!image.startsWith(ogPrefix) || !image.endsWith(".jpg")) {
      console.warn(
        `SEO 产物：${page.path} 的分享图不在 /og/*.jpg 约定下（${image}），未转制——` +
          "部分分享抓取器（如 QQ）可能因格式不受支持而显示不出图。"
      );
      continue;
    }

    const name = image.slice(ogPrefix.length, -".jpg".length);
    if (targets.has(name)) continue;
    const sourceFile = sourceFiles.find(
      (file) =>
        path.parse(file).name === name &&
        OG_SOURCE_EXTENSIONS.includes(path.extname(file).toLowerCase())
    );
    if (!sourceFile) {
      throw new Error(`SEO 产物：${page.path} 的分享图找不到同名源图（public/assets/${name}.*）`);
    }
    targets.set(name, sourceFile);
  }

  return targets;
}

export function seoArtifactsPlugin() {
  return {
    name: "seo-artifacts",
    apply: "build" as const,
    async closeBundle() {
      const distDir = path.resolve(import.meta.dirname, "../../dist");

      // ---- 站点地图 ----
      const seenPaths = new Set<string>();
      for (const page of PAGE_META) {
        if (!page.path.startsWith("/")) {
          throw new Error(`SEO 产物：页面路径必须以 / 开头（${page.path}）`);
        }
        if (seenPaths.has(page.path)) {
          throw new Error(`SEO 产物：页面路径重复（${page.path}）`);
        }
        seenPaths.add(page.path);
        if (page.lastmod && !/^\d{4}-\d{2}-\d{2}$/.test(page.lastmod)) {
          throw new Error(`SEO 产物：${page.path} 的 lastmod 必须是 YYYY-MM-DD（${page.lastmod}）`);
        }
      }

      const sitemap = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ...PAGE_META.map((page) =>
          [
            "  <url>",
            `    <loc>${SITE_ORIGIN}${page.path}</loc>`,
            ...(page.lastmod ? [`    <lastmod>${page.lastmod}</lastmod>`] : []),
            "    <changefreq>weekly</changefreq>",
            // priority 已被主流搜索引擎忽略，保留只是与既有的手写站点地图保持同构。
            `    <priority>${page.path === "/" ? "1.0" : "0.9"}</priority>`,
            "  </url>",
          ].join("\n")
        ),
        "</urlset>",
        "",
      ].join("\n");

      const sitemapPath = path.join(distDir, "sitemap.xml");
      fs.writeFileSync(sitemapPath, sitemap);

      // 回读逐条确认：登记过的页面一个都不许从站点地图里漏掉。
      const writtenSitemap = fs.readFileSync(sitemapPath, "utf8");
      for (const page of PAGE_META) {
        const loc = `<loc>${SITE_ORIGIN}${page.path}</loc>`;
        if (!writtenSitemap.includes(loc)) {
          throw new Error(`SEO 产物：站点地图缺少 ${loc}`);
        }
      }

      // ---- 分享图 ----
      const sourceDir = path.resolve(import.meta.dirname, "../../public/assets");
      const targets = collectOgTargets(sourceDir);

      const producedImages = await Promise.all(
        [...targets].map(async ([name, sourceFile]) => {
          const target = path.join(distDir, "og", `${name}.jpg`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          // 分享卡片本来就是静态图：gif 源只取第一帧（sharp 默认行为）。
          await sharp(path.join(sourceDir, sourceFile)).jpeg({ quality: 88 }).toFile(target);

          if (fs.statSync(target).size === 0) {
            throw new Error(`SEO 产物：分享图 ${name}.jpg 是空文件`);
          }
          return `${OG_IMAGE_ROUTE}${name}.jpg`;
        })
      );

      console.log(
        `SEO 产物生成完成：站点地图 ${PAGE_META.length} 条 URL、分享图 ${producedImages.length} 张（${producedImages.join("、")}）`
      );
    },
  };
}

// ==================== Vite 插件：霞鹜文楷字体子集 ====================
// 源 TTF 从固定版本的上游仓库或 Release 拉取并核对 SHA-256，woff2、CSS 与清单都在
// dev / build / Storybook 启动时生成到 Git 忽略的目录。index.css 只留一个占位注释，
// 这里在载入时替换成真实 @font-face，避免源码 import 一个尚未生成的文件。
// 生成器按输入哈希缓存；源字体、项目用字或生成脚本变化时才重新下载与分包。
