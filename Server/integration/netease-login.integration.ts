import { expect, test } from "bun:test";

import { NeteaseMusicProvider } from "../src/infrastructure/netease-music-provider";

const account = Bun.env.NETEASE_ACCOUNT?.trim();
const password = Bun.env.NETEASE_PASSWORD ?? "";

test("真实网易云账号登录并可校验登录状态", async () => {
  if (!account || !password) {
    throw new Error("请先在 Server/.env 中配置 NETEASE_ACCOUNT 和 NETEASE_PASSWORD");
  }

  // Enhanced API 在风控失败时会把完整响应（包括 Set-Cookie）打印到 stdout；真实测试禁止泄露这些字段。
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    if (args[0] === "[ERR]") return;
    originalLog(...args);
  };

  try {
    const provider = new NeteaseMusicProvider();
    try {
      const session = account.includes("@")
        ? await provider.loginWithEmail(account, password)
        : await provider.loginWithPhone({ phone: account, password });

      expect(session.cookie).toContain("MUSIC_U=");
      expect(session.account.nickname.length).toBeGreaterThan(0);

      const status = await provider.getLoginStatus(session.cookie);
      expect(status.account.nickname.length).toBeGreaterThan(0);
      originalLog(JSON.stringify({
        login: true,
        mode: account.includes("@") ? "email" : "phone",
        accountReady: Boolean(status.account.nickname),
      }));
    } catch (error) {
      const loginError = error as {
        code?: string;
        details?: { redirectUrl?: string };
      };
      if (loginError.code !== "MUSIC_LOGIN_RISK") throw error;
      expect(loginError.details?.redirectUrl).toMatch(/^https:\/\/[A-Za-z0-9.-]+\.163\.com\//);
      originalLog(JSON.stringify({
        login: false,
        blockedByRisk: true,
        fallbackReady: true,
      }));
    }
  } finally {
    console.log = originalLog;
  }
}, 90_000);

test("真实网易云二维码登录入口可以生成二维码", async () => {
  const provider = new NeteaseMusicProvider();
  const qr = await provider.createQrLogin();
  expect(qr.key.length).toBeGreaterThan(0);
  expect(qr.qrUrl).toMatch(/^https:\/\//);
  expect(qr.qrImage.startsWith("data:image/")).toBe(true);
}, 30_000);
