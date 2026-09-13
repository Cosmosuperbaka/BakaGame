import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const clientDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:5173",
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
      command: "npm run start",
      cwd: path.resolve(clientDir, "../Server"),
      url: "http://localhost:4850/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    // E2E 必须跑在生产构建（vite preview）而非 dev server：
    // 新版本提醒等行为仅存在于生产包（import.meta.env.DEV === false），
    // dev 模式下被整体禁用，在 dev server 上这类用例永远无法通过。
    // 构建由 `npm run test:e2e` 先行完成，这里只负责启动静态产物服务。
    //
    // host/url 显式钉死 127.0.0.1：vite 对 `localhost` 在部分环境只绑 IPv6（::1），
    // 与 Playwright 的就绪探测可能落到不同协议栈（实测 Windows 上出现 404/超时）；
    // 页面仍通过 baseURL 的 localhost 访问，浏览器会自动回退到 IPv4，不受影响。
    {
      command: "npm run preview -- --host 127.0.0.1 --port 5173 --strictPort",
      cwd: clientDir,
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
