import { resetClientPackagesForTest, type ClientPackage } from "@/lib/ClientPackages";

// ==================== 下载弹窗的发布信息 ====================
// 只供 Storybook 与截图使用。形状与服务端 `GET /api/client/packages` 一致，地址一律用占位域名。

export const STORY_WINDOWS_PACKAGE: ClientPackage = {
  platform: "windows",
  arch: "x64",
  url: "https://cdn.example.com/files/BakaGame-latest-x64.exe",
  version: "0.1.4",
  available: true,
  sizeBytes: 84_216_320,
  builtAt: "2026-10-19T09:12:33.000Z",
};

export const STORY_MACOS_PACKAGE: ClientPackage = {
  platform: "macos",
  arch: "Intel 与 Apple 芯片",
  url: "https://cdn.example.com/files/BakaGame-latest-universal.dmg",
  version: "0.1.4",
  available: true,
  sizeBytes: 31_457_280,
  builtAt: "2026-10-19T09:40:02.000Z",
};

export const STORY_ANDROID_PACKAGE: ClientPackage = {
  platform: "android",
  arch: "全架构通用",
  url: "https://cdn.example.com/files/BakaGame-latest-release.apk",
  version: "0.1.4",
  available: true,
  sizeBytes: 7_168_400,
  builtAt: "2026-10-18T23:59:59.000Z",
};

/**
 * 桩住发布信息接口：`packages` 为 `"error"` 时回 503（弹窗显示「读不到」）。
 * 清单有模块级缓存，进出故事都清一次，免得上一个故事的列表串到下一个。
 */
export function stubClientPackages(packages: ClientPackage[] | "error"): () => void {
  resetClientPackagesForTest();
  const original = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("/api/client/packages")) return original(input, init);
    if (packages === "error") {
      return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
    }
    return new Response(JSON.stringify({ packages }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    window.fetch = original;
    resetClientPackagesForTest();
  };
}
