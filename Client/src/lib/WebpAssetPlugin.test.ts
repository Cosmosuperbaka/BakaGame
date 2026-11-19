import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { publicWebpPlugin } from "../../scripts/vite-plugins/PublicWebp";
import { preparePublicWebp } from "../../scripts/prepare-public-webp.mjs";

describe("publicWebpPlugin", () => {
  const dummyAssetMap: Record<string, string> = {
    "/assets/Faker.png": "/assets/Faker.webp",
    "/assets/CEE.jpg": "/assets/CEE.webp",
    "/assets/SongGuessr.gif": "/assets/SongGuessr.webp",
    "/assets/favicon.png": "/assets/favicon.webp",
  };

  // 映射行为用固定清单驱动：真实转码由下方 preparePublicWebp 用例覆盖。
  const plugin = publicWebpPlugin(async () => ({
    publicDir: path.resolve("."),
    assetMap: dummyAssetMap,
  }));

  beforeAll(async () => {
    await plugin.config();
  });

  it("has correct plugin name", () => {
    expect(plugin.name).toBe("public-webp");
  });

  it("publishes the generated directory as publicDir", async () => {
    await expect(plugin.config()).resolves.toEqual({ publicDir: path.resolve(".") });
  });

  describe("configureServer middleware", () => {
    it("rewrites matching asset path to webp target", () => {
      let middlewareHandler:
        ((req: { url?: string }, res: unknown, next: () => void) => void) | undefined;
      const mockServer = {
        middlewares: {
          use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => {
            middlewareHandler = fn;
          },
        },
      };

      plugin.configureServer(mockServer);
      expect(middlewareHandler).toBeDefined();

      const req = { url: "/assets/Faker.png" };
      let nextCalled = false;
      middlewareHandler!(req, {}, () => {
        nextCalled = true;
      });

      expect(req.url).toBe("/assets/Faker.webp");
      expect(nextCalled).toBe(true);
    });

    it("preserves query strings when rewriting matching asset path", () => {
      let middlewareHandler:
        ((req: { url?: string }, res: unknown, next: () => void) => void) | undefined;
      const mockServer = {
        middlewares: {
          use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => {
            middlewareHandler = fn;
          },
        },
      };

      plugin.configureServer(mockServer);
      const req = { url: "/assets/CEE.jpg?v=1.0&t=12345" };
      middlewareHandler!(req, {}, () => {});

      expect(req.url).toBe("/assets/CEE.webp?v=1.0&t=12345");
    });

    it("does not modify unmapped URLs", () => {
      let middlewareHandler:
        ((req: { url?: string }, res: unknown, next: () => void) => void) | undefined;
      const mockServer = {
        middlewares: {
          use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => {
            middlewareHandler = fn;
          },
        },
      };

      plugin.configureServer(mockServer);
      const req = { url: "/api/game/status" };
      middlewareHandler!(req, {}, () => {});

      expect(req.url).toBe("/api/game/status");
    });
  });

  describe("transformIndexHtml", () => {
    it("rewrites icon link href and changes mime type to image/webp", () => {
      const html = '<link rel="icon" type="image/png" href="/assets/favicon.png" />';
      const result = plugin.transformIndexHtml(html);
      expect(result).toBe('<link rel="icon" type="image/webp" href="/assets/favicon.webp" />');
    });

    it("rewrites standard asset references in html", () => {
      const html = '<img src="/assets/Faker.png" alt="logo" />';
      const result = plugin.transformIndexHtml(html);
      expect(result).toBe('<img src="/assets/Faker.webp" alt="logo" />');
    });
  });

  describe("transform", () => {
    it("ignores node_modules and virtual modules", () => {
      expect(
        plugin.transform('const icon = "/assets/Faker.png"', "C:/project/node_modules/pkg/index.js")
      ).toBeNull();
      expect(plugin.transform('const icon = "/assets/Faker.png"', "\0virtual:test")).toBeNull();
    });

    it("returns null when no matching asset paths are found in code", () => {
      const code = 'const hello = "world";';
      expect(plugin.transform(code, "C:/project/src/pages/Home.tsx")).toBeNull();
    });

    it("replaces matching asset paths in source code", () => {
      const code = `
        export const game = {
          icon: "/assets/Faker.png",
          bg: "/assets/CEE.jpg",
          logo: "/assets/SongGuessr.gif",
        };
      `;
      const result = plugin.transform(code, "C:/project/src/pages/LandingPage.tsx");
      expect(result).not.toBeNull();
      expect(result?.code).toContain('icon: "/assets/Faker.webp"');
      expect(result?.code).toContain('bg: "/assets/CEE.webp"');
      expect(result?.code).toContain('logo: "/assets/SongGuessr.webp"');
    });
  });
});

// 该用例驱动的是真实转码流水线：整目录重编码叠加 4 个表情包共 80 张贴图，
// 单机实测已接近 vitest 默认的 5s 上限，必须显式放宽以吸收机器抖动与 CI 冷启动开销。
const TRANSCODE_TIMEOUT_MS = 60_000;

describe("preparePublicWebp", () => {
  it(
    "generates valid publicDir and accurate assetMap from public assets and emojis",
    async () => {
      const { publicDir, assetMap } = await preparePublicWebp();
      expect(publicDir).toContain(".generated-public");
      expect(assetMap["/assets/Faker.png"]).toBe("/assets/Faker.webp");
      expect(assetMap["/assets/CEE.jpg"]).toBe("/assets/CEE.webp");
      expect(assetMap["/assets/SongGuessr.gif"]).toBe("/assets/SongGuessr.webp");
      expect(assetMap["/assets/favicon.png"]).toBe("/assets/favicon.webp");
      expect(assetMap["/assets/logo.gif"]).toBe("/assets/logo.webp");

      // 验证表情包旧格式向新 .webp 格式的兼容映射已被收录进 assetMap
      const stickerMappings = Object.entries(assetMap).filter(([k]) => k.startsWith("/stickers/"));
      expect(stickerMappings.length).toBeGreaterThan(0);
      for (const [legacyUrl, webpUrl] of stickerMappings) {
        expect(legacyUrl).toMatch(/^\/stickers\/[0-9a-f]{24}\.(?:apng|gif|jpe?g|png)$/);
        expect(webpUrl).toMatch(/^\/stickers\/[0-9a-f]{24}\.webp$/);
      }

      // 验证动图 PNG（如 QQ 音乐 10 级徽章 APNG）转码后完整保留多帧动画，未被降级为单帧静态图
      const vip10Path = path.join(publicDir, "assets/qqmusic-vip/VIP-10.webp");
      const vip10Meta = await sharp(vip10Path, { animated: true }).metadata();
      expect(vip10Meta.pages).toBeGreaterThan(1);

      // 按显示尺寸出档：源图是设计原始尺寸，产物却要当 48px 高的动画标与 32px 的标签图标用。
      const logo = await sharp(path.join(publicDir, "assets/logo.webp"), {
        animated: true,
      }).metadata();
      // 动图按帧竖向堆叠报告总高，帧高取 pageHeight，帧宽就是 width。
      // 144 = 最高档 md:h-16（64px）×DSF 2，同时覆盖移动端 h-12（48px）×DSF 3。
      expect(logo.pageHeight).toBe(144);
      expect(logo.width).toBe(256);
      // 出档只许改尺寸：帧数与循环保持原样，否则动画标被压成静图也一片绿。
      expect(logo.pages).toBeGreaterThan(1);
      expect(logo.loop).toBe(0);
      const favicon = await sharp(path.join(publicDir, "assets/favicon.webp")).metadata();
      expect(favicon.height).toBe(64);
      // 宽高同比缩放，不被裁切也不被拉伸（原始 1114×1080）。
      expect(favicon.width).toBe(66);
    },
    TRANSCODE_TIMEOUT_MS
  );
});
