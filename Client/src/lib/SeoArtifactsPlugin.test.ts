import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seoArtifactsPlugin } from "../../scripts/vite-plugins/SeoArtifacts";
import sharp from "sharp";
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, PAGE_META, SITE_ORIGIN } from "@/data/PageMeta";

// 构建插件在真实源图上跑一遍，产物写进临时目录：断言的是部署出去的文件本身。
let root: string;
const dist = () => path.join(root, "dist");
const readDist = (name: string) => readFileSync(path.join(dist(), name), "utf8");

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "seo-artifacts-"));
  mkdirSync(dist());
  const plugin = seoArtifactsPlugin();
  plugin.configResolved({ root, build: { outDir: "dist" } });
  vi.spyOn(console, "log").mockImplementation(() => {});
  await plugin.closeBundle();
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("站点地图", () => {
  it("每个登记页一条 loc，不带被搜索引擎忽略的 changefreq 与 priority", () => {
    const sitemap = readDist("sitemap.xml");
    for (const page of PAGE_META) {
      expect(sitemap).toContain(`<loc>${SITE_ORIGIN}${page.path}</loc>`);
    }
    expect(sitemap.match(/<url>/g)).toHaveLength(PAGE_META.length);
    expect(sitemap).not.toContain("<changefreq>");
    expect(sitemap).not.toContain("<priority>");
  });
});

describe("分享图", () => {
  // 大图卡片规格是 1.91:1；小图会退化成缩略图，正方形会被裁掉上下。
  it("每个登记页的分享图都是 1200×630 的 jpg", async () => {
    for (const page of PAGE_META) {
      expect(page.image?.startsWith(`${SITE_ORIGIN}/og/`), page.path).toBe(true);
      expect(page.image?.endsWith(".jpg"), page.path).toBe(true);
      const file = path.join(dist(), page.image!.slice(SITE_ORIGIN.length));
      const meta = await sharp(file).metadata();
      expect([meta.format, meta.width, meta.height], page.path).toEqual([
        "jpeg",
        OG_IMAGE_WIDTH,
        OG_IMAGE_HEIGHT,
      ]);
    }
  });

  it("每张分享图都写了替代文字", () => {
    for (const page of PAGE_META) expect(page.imageAlt?.trim(), page.path).toBeTruthy();
  });
});
