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
        if (id === "\0virtual:credits")
          return 'export default { generatedAt: "", dependencies: [] }';
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
      {
        find: "@bakagame/shared",
        replacement: path.resolve(import.meta.dirname, "../Server/src/shared/Index.ts"),
      },
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
      // 覆盖率棘轮：阈值 = 一次实测读数 − 0.5pp，只许跟着实测往上走，不许往下调。
      // 标定口径：vitest 5.0.3 + v8 provider，105 个测试文件 / 873 例全绿时
      // All files 为 statements 80.41、branches 70.66、functions 74.75、lines 82.31；
      // 紧接着复跑一次读数差 ≤0.04pp，0.5pp 余量覆盖的就是这类抖动（jsdom 里的定时器与
      // 动画分支在不同机器上会差得更多）。阈值贴着实测会让门禁变成 flaky，而 flaky 的门禁最终被人关掉。
      // 收紧时机：每补完一个模块的用例集就按同一口径重测一次，把四值重新抬到「实测 − 0.5pp」。
      // 新增模块却压低实测，是要补覆盖的信号，不是要下调阈值的理由。
      thresholds: {
        statements: 79.9,
        branches: 70.1,
        functions: 74.2,
        lines: 81.8,
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
