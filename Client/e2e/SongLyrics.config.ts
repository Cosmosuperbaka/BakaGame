import path from "node:path";
import { defineConfig } from "@playwright/test";

// 独立组件浏览器回归：不启动真实音乐服务、不请求上游、不发布测试入口。
export default defineConfig({
  testDir: ".",
  testMatch: "SongLyrics.spec.ts",
  outputDir: "../test-results/lyrics",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5177",
    channel: process.platform === "win32" ? "msedge" : undefined,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    cwd: path.resolve(import.meta.dirname, ".."),
    command: "npx vite --config e2e/SongLyrics.vite.ts --host 127.0.0.1 --port 5177 --strictPort",
    url: "http://127.0.0.1:5177/e2e/fixtures/SongLyrics.html",
    reuseExistingServer: !process.env.CI,
  },
});
