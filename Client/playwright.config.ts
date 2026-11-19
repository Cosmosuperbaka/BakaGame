import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const clientDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "SongLyrics.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: process.platform === "win32" ? "msedge" : undefined,
      },
    },
  ],
  webServer: [
    {
      command: "bun --no-env-file run scripts/IsolatedServer.ts",
      cwd: path.resolve(clientDir, "../Server"),
      url: "http://127.0.0.1:4850/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    // E2E 必须跑在生产构建（vite preview）而非 dev server：
    // 新版本提醒等行为仅存在于生产包（import.meta.env.DEV === false），
    // dev 模式下被整体禁用，在 dev server 上这类用例永远无法通过。
    // 构建由 `npm run test:e2e` 先行完成，这里只负责启动静态产物服务。
    //
    // host/url 显式钉死 127.0.0.1：vite 对 `localhost` 在部分环境只绑 IPv6（::1），
    // 与 Playwright 的就绪探测可能落到不同协议栈（实测 Windows 上出现 404/超时）；
    // 页面 baseURL 也钉死 IPv4，不碰用户已有的 localhost/::1 实例。
    // 专用入口 configFile:false/envDir:false，仅静态服务 dist，不加载 dev proxy/生成插件。
    {
      command: "node scripts/e2e-preview.mjs",
      cwd: clientDir,
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
