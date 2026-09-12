import { describe, expect, it } from "vitest";
import { webpAssetPlugin } from "../../vite.config";
import { preparePublicWebp } from "../../scripts/prepare-public-webp.mjs";

describe("webpAssetPlugin", () => {
  const dummyAssetMap: Record<string, string> = {
    "/assets/Faker.png": "/assets/Faker.webp",
    "/assets/CCB.jpg": "/assets/CCB.webp",
    "/assets/SongGuessr.gif": "/assets/SongGuessr.webp",
    "/assets/favicon.png": "/assets/favicon.webp",
  };

  const plugin = webpAssetPlugin(dummyAssetMap);

  it("has correct plugin name", () => {
    expect(plugin.name).toBe("webp-asset-mapping");
  });

  describe("configureServer middleware", () => {
    it("rewrites matching asset path to webp target", () => {
      let middlewareHandler: ((req: { url?: string }, res: unknown, next: () => void) => void) | undefined;
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
      let middlewareHandler: ((req: { url?: string }, res: unknown, next: () => void) => void) | undefined;
      const mockServer = {
        middlewares: {
          use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => {
            middlewareHandler = fn;
          },
        },
      };

      plugin.configureServer(mockServer);
      const req = { url: "/assets/CCB.jpg?v=1.0&t=12345" };
      middlewareHandler!(req, {}, () => {});

      expect(req.url).toBe("/assets/CCB.webp?v=1.0&t=12345");
    });

    it("does not modify unmapped URLs", () => {
      let middlewareHandler: ((req: { url?: string }, res: unknown, next: () => void) => void) | undefined;
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
      expect(plugin.transform('const icon = "/assets/Faker.png"', "C:/project/node_modules/pkg/index.js")).toBeNull();
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
          bg: "/assets/CCB.jpg",
          logo: "/assets/SongGuessr.gif",
        };
      `;
      const result = plugin.transform(code, "C:/project/src/pages/LandingPage.tsx");
      expect(result).not.toBeNull();
      expect(result?.code).toContain('icon: "/assets/Faker.webp"');
      expect(result?.code).toContain('bg: "/assets/CCB.webp"');
      expect(result?.code).toContain('logo: "/assets/SongGuessr.webp"');
    });
  });
});

// 该用例驱动的是真实转码流水线：整目录重编码叠加 4 个表情包共 80 张贴图，
// 单机实测已接近 vitest 默认的 5s 上限，必须显式放宽以吸收机器抖动与 CI 冷启动开销。
const TRANSCODE_TIMEOUT_MS = 60_000;

describe("preparePublicWebp", () => {
  it("generates valid publicDir and accurate assetMap from public assets and emojis", async () => {
    const { publicDir, assetMap } = await preparePublicWebp();
    expect(publicDir).toContain(".generated-public");
    expect(assetMap["/assets/Faker.png"]).toBe("/assets/Faker.webp");
    expect(assetMap["/assets/CCB.jpg"]).toBe("/assets/CCB.webp");
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
  }, TRANSCODE_TIMEOUT_MS);
});

