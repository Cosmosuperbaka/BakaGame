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
        return null;
      },
      load(id) {
        if (id === "\0virtual:commit-history") {
          return 'export default { generatedAt: "", currentCommit: "dev", commits: [] }';
        }
        if (id === "\0virtual:sticker-manifest") {
          return 'export default { generatedAt: "", packs: [] }';
        }
        return null;
      },
    },
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@bakagame/shared": path.resolve(__dirname, "../Server/src/shared/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
    },
  },
});
