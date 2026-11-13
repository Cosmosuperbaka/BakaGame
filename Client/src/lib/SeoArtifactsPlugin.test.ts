import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seoArtifactsPlugin } from "../../scripts/vite-plugins/SeoArtifacts";
import { PAGE_META, SITE_ORIGIN } from "@/data/PageMeta";

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
