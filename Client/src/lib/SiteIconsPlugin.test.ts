import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { siteIconsPlugin } from "../../scripts/vite-plugins/SiteIcons";

// 根目录图标与站点清单由构建期从同一张源图生成；这里在临时目录真实跑一遍，断言部署出去的文件。
let root: string;
const dist = () => path.join(root, "dist");
const distFile = (name: string) => path.join(dist(), name);

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "site-icons-"));
  mkdirSync(dist());
  vi.spyOn(console, "log").mockImplementation(() => {});
  const plugin = siteIconsPlugin();
  plugin.configResolved({ root, build: { outDir: "dist" } });
  await plugin.closeBundle();
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("站点图标", () => {
  // 百度与部分抓取器只认根目录的 /favicon.ico；谷歌要求图标边长是 48 的倍数。
  it("根目录有 favicon.ico，内含 48 像素的 PNG 图标", () => {
    const ico = readFileSync(distFile("favicon.ico"));
    // ICONDIR：保留位 0、类型 1（图标）、条目数
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, index) => ico.readUInt8(6 + index * 16));
    expect(sizes).toContain(48);
  });

  it.each([
    ["favicon-48.png", 48],
    ["favicon-192.png", 192],
    ["favicon-512.png", 512],
    ["apple-touch-icon.png", 180],
  ])("%s 是 %i 像素的正方形 PNG", async (name, size) => {
    const meta = await sharp(distFile(name)).metadata();
    expect(meta.format).toBe("png");
    expect([meta.width, meta.height]).toEqual([size, size]);
  });

  // iOS 会把透明区域铺成黑底，主屏图标必须自带不透明底色。
  it("触摸图标不透明", async () => {
    const meta = await sharp(distFile("apple-touch-icon.png")).metadata();
    expect(meta.hasAlpha).toBe(false);
  });
});

describe("站点清单", () => {
  const manifest = () => JSON.parse(readFileSync(distFile("site.webmanifest"), "utf8"));

  it("写站名与语言，图标都指向已生成的文件", () => {
    const data = manifest();
    expect(data).toMatchObject({ name: "BakaGame", short_name: "BakaGame", lang: "zh-CN" });
    expect(data.icons.length).toBeGreaterThan(0);
    for (const icon of data.icons) {
      expect(existsSync(distFile(icon.src.replace(/^\//, ""))), icon.src).toBe(true);
    }
  });

  it("颜色取页面底色，不写任何绝对地址", () => {
    const text = readFileSync(distFile("site.webmanifest"), "utf8");
    expect(text).not.toMatch(/https?:\/\//);
    expect(manifest().background_color).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("入口 HTML", () => {
  const html = readFileSync(path.resolve(import.meta.dirname, "../../index.html"), "utf8");

  it("声明根目录图标、触摸图标与站点清单", () => {
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="48x48" />');
    expect(html).toContain(
      '<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png" />'
    );
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest" />');
  });
});
