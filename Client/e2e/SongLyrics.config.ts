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
    // HTML 可先于真实生产 CSS 编译完成；就绪探针等待这个必要资源，而非让首例承担冷编译。
    url: "http://127.0.0.1:5177/src/index.css",
    // 就绪探针等的是整份样式表的冷编译：机器被别的任务占着时一分钟不够，等不到会让整组用例直接不跑。
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
