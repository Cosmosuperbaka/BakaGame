import { describe, expect, test } from "bun:test";

import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import type { AppEnv } from "../src/config/Env";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { createAccountTestApp } from "./AccountFixtures";
import { createTestApp } from "./AppFixtures";

const QQ = "123456789";
const EMAIL = `${QQ}@qq.com`;

const clock = (start = Date.UTC(2026, 9, 20)) => {
  let current = start;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
};

describe("账号系统未启用", () => {
  test("登录、RPC 与头像路由统一回 503 ACCOUNT_DISABLED", async () => {
    const env = { clientUrl: "http://localhost:5173", serverUrl: "http://localhost:4850", serverListenHost: "127.0.0.1", serverPort: 0, bangumiApiUrl: "https://api.bgm.tv", bangumiImageUrl: "" } satisfies AppEnv;
    const logger = new EventLogger(() => {});
    const { app } = createTestApp({ env, logger, whoIsFakerService: new WhoIsFakerService({ eventLogger: logger }) });
    for (const url of ["/api/auth/get-session", "/api/rpc/account/me", "/api/account/avatar/someone"]) {
      const response = await app.handle(new Request(`http://localhost${url}`));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "ACCOUNT_DISABLED" } });
    }
  });
});

describe("验证码登录", () => {
  test("首次登录必须带昵称，校验失败不消耗验证码；成功后派生 QQ 号与站内头像", async () => {
    const { app, rpc, mailer, avatarFetcher } = createAccountTestApp();
    const sent = await rpc("account/requestLoginCode", { qqNumber: QQ });
    expect(sent).toEqual({ status: 200, body: { registered: false, resendAfterSeconds: 60 } });
    const code = mailer.lastCodeFor(EMAIL);
    expect(code).toMatch(/^\d{6}$/);

    const signIn = (body: Record<string, unknown>) => app.handle(new Request("http://localhost/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: EMAIL, otp: code, ...body }),
    }));
    const missingName = await signIn({ name: "   " });
    expect(missingName.status).toBe(400);
    expect(await missingName.json()).toMatchObject({ code: "ACCOUNT_NAME_REQUIRED" });

    const ok = await signIn({ name: "  笨蛋​ 玩家  " });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
    expect(cookie).toContain("bakagame.session_token=");

    const me = await rpc("account/me", undefined, cookie);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ name: "笨蛋 玩家", qqNumber: QQ, showQq: false, role: "user" });
    expect(String(me.body.image)).toMatch(/^\/api\/account\/avatar\/[^?]+\?v=[0-9a-f]{16}$/);
    expect(String(me.body.image)).not.toContain(QQ);
    expect(avatarFetcher.calls).toHaveLength(1);
  });

  test("非 QQ 邮箱、客户端自带头像与非白名单端点均被拒绝", async () => {
    const { app } = createAccountTestApp();
    const post = (path: string, body: unknown) => app.handle(new Request(`http://localhost/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify(body),
    }));
    const foreign = await post("/sign-in/email-otp", { email: "someone@example.com", otp: "123456", name: "x" });
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ code: "INVALID_QQ_EMAIL" });
    const withImage = await post("/sign-in/email-otp", { email: EMAIL, otp: "123456", name: "x", image: "https://evil.example/a.png" });
    expect(withImage.status).toBe(400);
    expect(await withImage.json()).toMatchObject({ code: "FIELD_NOT_ALLOWED" });
    for (const path of ["/sign-up/email", "/email-otp/send-verification-otp", "/update-user", "/admin/list-users"]) {
      expect((await post(path, {})).status).toBe(404);
    }
  });

  test("同一 QQ 号 60 秒内只发一次码，已注册账号返回 registered", async () => {
    const time = clock();
    const { rpc, signIn } = createAccountTestApp({ now: time.now });
    await signIn(QQ, "玩家");
    time.advance(61_000);
    expect(await rpc("account/requestLoginCode", { qqNumber: QQ })).toMatchObject({ status: 200, body: { registered: true } });
    const limited = await rpc("account/requestLoginCode", { qqNumber: QQ });
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: "RATE_LIMITED" });
    expect((await rpc("account/requestLoginCode", { qqNumber: "0123" })).status).toBe(400);
  });

  test("邮件投递失败明确返回 503 MAIL_UNAVAILABLE", async () => {
    const { rpc, mailer } = createAccountTestApp();
    mailer.failNext = true;
    const response = await rpc("account/requestLoginCode", { qqNumber: QQ });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "MAIL_UNAVAILABLE" });
  });

  test("ADMIN_QQ 在建号时与启动引导时都提升为管理员", async () => {
    const first = createAccountTestApp({ adminQqNumbers: [QQ] });
    const { cookie } = await first.signIn(QQ, "站长");
    expect((await first.rpc("account/me", undefined, cookie)).body).toMatchObject({ role: "admin" });

    const second = createAccountTestApp();
    const existing = await second.signIn("987654321", "老玩家");
    expect((await second.rpc("account/me", undefined, existing.cookie)).body).toMatchObject({ role: "user" });
    await second.service.promoteAdmins(["987654321"]);
    expect((await second.rpc("account/me", undefined, existing.cookie)).body).toMatchObject({ role: "admin" });
  });
});

describe("资料与头像", () => {
  test("QQ 号默认隐藏，本人公开后资料卡才显示；未登录不能改资料", async () => {
    const { rpc, signIn } = createAccountTestApp();
    const { cookie } = await signIn(QQ, "玩家");
    const me = await rpc("account/me", undefined, cookie);
    const userId = String(me.body.id);
    expect((await rpc("account/publicProfile", { userId })).body).toMatchObject({ name: "玩家", qqNumber: null });

    expect((await rpc("account/updateProfile", { showQq: true })).status).toBe(401);
    const updated = await rpc("account/updateProfile", { showQq: true, name: "新昵称" }, cookie);
    expect(updated.body).toMatchObject({ showQq: true, name: "新昵称" });
    expect((await rpc("account/publicProfile", { userId })).body).toMatchObject({ name: "新昵称", qqNumber: QQ });
    expect((await rpc("account/publicProfile", { userId: "missing" })).status).toBe(404);
  });

  test("头像按访问节流刷新，版本变化后换 URL；当前版本可永久缓存", async () => {
    const time = clock();
    const { app, rpc, signIn, avatarFetcher } = createAccountTestApp({ now: time.now });
    const { cookie } = await signIn(QQ, "玩家");
    const firstImage = String((await rpc("account/me", undefined, cookie)).body.image);
    expect(String((await rpc("account/me", undefined, cookie)).body.image)).toBe(firstImage);
    expect(avatarFetcher.calls).toHaveLength(1);

    const current = await app.handle(new Request(`http://localhost${firstImage}`));
    expect(current.status).toBe(200);
    expect(current.headers.get("content-type")).toBe("image/jpeg");
    expect(current.headers.get("cache-control")).toContain("immutable");
    expect(await current.text()).toBe(`avatar:${QQ}:1:640`);
    const small = await app.handle(new Request(`http://localhost${firstImage}&size=100`));
    expect(await small.text()).toBe(`avatar:${QQ}:1:100`);

    avatarFetcher.bump(QQ);
    time.advance(11 * 60 * 1000);
    const secondImage = String((await rpc("account/me", undefined, cookie)).body.image);
    expect(secondImage).not.toBe(firstImage);
    const stale = await app.handle(new Request(`http://localhost${firstImage}`));
    expect(stale.headers.get("cache-control")).toBe("public, max-age=300");
    expect((await app.handle(new Request("http://localhost/api/account/avatar/missing"))).status).toBe(404);
  });
});
