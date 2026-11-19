import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 只编译歌词夹具和真实生产 CSS；不执行应用的资源预处理、静态外壳或代理。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  publicDir: false,
  optimizeDeps: { entries: ["e2e/fixtures/SongLyrics.html"] },
  cacheDir: "node_modules/.vite-lyrics",
  resolve: {
    dedupe: ["@sinclair/typebox"],
    alias: [
      // 更具体的前缀必须排在前面：运行时值走 Values.ts，类型仍从 Index.ts 取。
      // 漏掉这条时 "@bakagame/shared" 会把子路径拼成 Index.ts/values，dev 下直接 500。
      {
        find: "@bakagame/shared/values",
        replacement: path.resolve(import.meta.dirname, "../../Server/src/shared/Values.ts"),
      },
      {
        find: "@bakagame/shared",
        replacement: path.resolve(import.meta.dirname, "../../Server/src/shared/Index.ts"),
      },
      { find: "@", replacement: path.resolve(import.meta.dirname, "../src") },
    ],
  },
});
