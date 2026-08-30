import { expect, test } from "bun:test";

import { NeteaseMusicProvider } from "../src/infrastructure/NeteaseMusicProvider";

test("真实网易云 Cookie 可以校验账号并读取会员状态", async () => {
  const cookie = Bun.env.NETEASE_COOKIE?.trim();
  if (!cookie) {
    throw new Error("请先在 Server/.env 中配置 NETEASE_COOKIE");
  }

  const provider = new NeteaseMusicProvider();
  const session = await provider.getLoginStatus(cookie);
  expect(session.account.nickname.length).toBeGreaterThan(0);
  expect(["vip", "nonVip", "unknown"]).toContain(session.account.vipStatus);
});

test("真实网易云二维码登录入口可以生成二维码", async () => {
  const provider = new NeteaseMusicProvider();
  const qr = await provider.createQrLogin();
  expect(qr.key.length).toBeGreaterThan(0);
  expect(qr.qrUrl.length).toBeGreaterThan(0);
  expect(qr.qrImage.startsWith("data:image/")).toBe(true);
});
