import path from "node:path";
import { readFileSync } from "node:fs";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { latestVersionOf } from "./src/lib/Changelog.ts";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "test-virtual-modules",
      resolveId(id) {
        if (id === "virtual:commit-history") return "\0virtual:commit-history";
        if (id === "virtual:app-version") return "\0virtual:app-version";
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
        // 版本号按构建期同一份推导取，单测里断言的版本才不会与真实日志脱节。
        if (id === "\0virtual:app-version") {
          const text = readFileSync(
            path.resolve(import.meta.dirname, "src/data/changelog.json"),
            "utf8"
          );
          return `export default ${JSON.stringify(latestVersionOf(text) ?? "")}`;
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
      // 标定口径：vitest 5.0.3 + v8 provider，138 个测试文件全绿时
      // All files 为 statements 80.41、branches 70.28、functions 75.73、lines 82.51；
      // 0.5pp 余量覆盖的是复跑抖动（jsdom 里的定时器与动画分支在不同机器上会差得更多）。
      // 阈值贴着实测会让门禁变成 flaky，而 flaky 的门禁最终被人关掉。
      // 收紧时机：每补完一个模块的用例集就按同一口径重测一次，把四值重新抬到「实测 − 0.5pp」。
      // 新增模块却压低实测，是要补覆盖的信号，不是要下调阈值的理由——branches 这次实测
      // 比上次标定低了 0.38pp，阈值保持不动，余量只剩 0.18pp，下次动分支多的模块先补测试。
      thresholds: {
        statements: 79.9,
        branches: 70.1,
        functions: 75.2,
        lines: 82,
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
