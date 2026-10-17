import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "test-virtual-modules",
      resolveId(id) {
        if (id === "virtual:commit-history") return "\0virtual:commit-history";
        if (id === "virtual:sticker-manifest") return "\0virtual:sticker-manifest";
        if (id === "virtual:credits") return "\0virtual:credits";
        if (id === "virtual:credits-licenses") return "\0virtual:credits-licenses";
        if (id.startsWith("virtual:credits-licenses-")) return "\0" + id;
        return null;
      },
      load(id) {
        if (id === "\0virtual:commit-history") {
          return 'export default { generatedAt: "", currentCommit: "dev", commits: [] }';
        }
        if (id === "\0virtual:sticker-manifest") {
          return 'export default { generatedAt: "", packs: [] }';
        }
        // 依赖清单与桶都只给空桩：单测断言页面行为，不依赖本机安装树。
        if (id === "\0virtual:credits") return 'export default { generatedAt: "", dependencies: [] }';
        if (id === "\0virtual:credits-licenses") return "export default {}";
        if (id.startsWith("\0virtual:credits-licenses-")) return "export default {}";
        return null;
      },
    },
  ],
  resolve: {
      // 共享源码的运行依赖按客户端安装边界解析。
      dedupe: ["@sinclair/typebox"],
    alias: [
      { find: "@bakagame/shared", replacement: path.resolve(import.meta.dirname, "../Server/src/shared/Index.ts") },
      { find: "@/types", replacement: path.resolve(import.meta.dirname, "./src/types/Index.ts") },
      { find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
    ],
  },
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./src/test/Setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      thresholds: {
        statements: 54,
        branches: 43,
        functions: 45,
        lines: 56,
      },
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.stories.tsx",
        "src/stories/**",
        "src/test/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
    },
  },
});
