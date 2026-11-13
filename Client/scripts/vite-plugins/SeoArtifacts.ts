/**
 * SEO 构建产物：站点地图与分享图。两个产物、同一个来源：PageMeta。
 *
 * 站点地图曾手写在 public/sitemap.xml：新增可收录页面靠人记得同步，漏改没有任何报错，
 * 而缺页只会让搜索引擎更晚发现新内容——静默漂移。改为构建末尾按 PAGE_META 生成，
 * URL 集合回到单一真相源；lastmod 由各页在文案显著变更时手动维护，不随构建刷新
 * （每次构建都变的 lastmod 会被搜索引擎判定不可信，进而整体忽略）。
 *
 * 分享图：源图是 `scripts/og-cards.mjs` 出的 1200×630 卡片（src/assets/og/<名>.png，提交进仓库，
 * 构建环境不需要浏览器）。全站图片管线只产 webp，而部分分享抓取器（QQ 实测）不认 webp，
 * 所以这里为 PageMeta.image 指向的每张卡片转一份 jpg（/og/<名>.jpg），并逐张校验尺寸：
 * 尺寸不对的卡片在大图卡片里会被裁切或退化成小缩略图，坏了没有任何报错，只能在构建时拦下。
 */
import path from "path";
import fs from "fs";
import sharp from "sharp";
import {
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  PAGE_META,
  SITE_ORIGIN,
} from "../../src/data/PageMeta.ts";

const OG_IMAGE_ROUTE = "/og/";
const OG_SOURCE_DIR = path.resolve(import.meta.dirname, "../../src/assets/og");

/**
 * 收集要转制的卡片名。
 *
 * 多个页面可以共用同一张分享图（首页与 /abouts 都用 og-home.jpg），所以这里按名字去重：
 * 同一个目标路径不能交给两路 sharp 并发写——写完的那路与截断的那路重叠，紧接着的校验会读到坏文件。
 */
function collectOgTargets(): Set<string> {
  const ogPrefix = `${SITE_ORIGIN}${OG_IMAGE_ROUTE}`;
  const targets = new Set<string>();
  for (const page of PAGE_META) {
    const image = page.image;
    if (!image || !image.startsWith(ogPrefix) || !image.endsWith(".jpg")) {
      throw new Error(
        `SEO 产物：${page.path} 的分享图必须是站内 /og/<名>.jpg（${image ?? "未配置"}）`
      );
    }
    const name = image.slice(ogPrefix.length, -".jpg".length);
    if (!fs.existsSync(path.join(OG_SOURCE_DIR, `${name}.png`))) {
      throw new Error(`SEO 产物：${page.path} 的分享图找不到源图（src/assets/og/${name}.png）`);
    }
    targets.add(name);
  }
  return targets;
}

/** 转制一张卡片并回读校验：尺寸必须正好是分享卡片规格。 */
async function produceOgImage(distDir: string, name: string): Promise<string> {
  const target = path.join(distDir, "og", `${name}.jpg`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await sharp(path.join(OG_SOURCE_DIR, `${name}.png`))
    .jpeg({ quality: 88 })
    .toFile(target);
  const { width, height } = await sharp(target).metadata();
  if (width !== OG_IMAGE_WIDTH || height !== OG_IMAGE_HEIGHT) {
    throw new Error(
      `SEO 产物：分享图 ${name}.jpg 是 ${width}×${height}，必须是 ${OG_IMAGE_WIDTH}×${OG_IMAGE_HEIGHT}`
    );
  }
  return `${OG_IMAGE_ROUTE}${name}.jpg`;
}

export function seoArtifactsPlugin() {
  let distDir = path.resolve(import.meta.dirname, "../../dist");
  return {
    name: "seo-artifacts",
    apply: "build" as const,
    // 产物目录取自实际生效的构建配置，而不是写死 ../../dist：别的构建（如 Storybook）
    // 即使误引入本插件，也只写进自己的 outDir。
    configResolved(config: { root: string; build: { outDir: string } }) {
      distDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
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
            // 只写 loc 与 lastmod：changefreq、priority 已被主流搜索引擎忽略，写了只是噪声。
            ...(page.lastmod ? [`    <lastmod>${page.lastmod}</lastmod>`] : []),
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
      const producedImages = await Promise.all(
        [...collectOgTargets()].map((name) => produceOgImage(distDir, name))
      );

      console.log(
        `SEO 产物生成完成：站点地图 ${PAGE_META.length} 条 URL、分享图 ${producedImages.length} 张（${producedImages.join("、")}）`
      );
    },
  };
}
