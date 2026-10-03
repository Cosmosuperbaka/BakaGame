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
      { find: "@bakagame/shared", replacement: path.resolve(import.meta.dirname, "../../Server/src/shared/Index.ts") },
      { find: "@/types", replacement: path.resolve(import.meta.dirname, "../src/types/Index.ts") },
      { find: "@", replacement: path.resolve(import.meta.dirname, "../src") },
    ],
  },
});
