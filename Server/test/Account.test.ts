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
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
};

describe("账号系统未启用", () => {
  test("登录、RPC 与头像路由统一回 503 ACCOUNT_DISABLED", async () => {
    const env = {
      clientUrl: "http://localhost:5173",
      serverUrl: "http://localhost:4850",
      serverListenHost: "127.0.0.1",
      serverPort: 0,
      bangumiApiUrl: "https://api.bgm.tv",
      bangumiImageUrl: "",
    } satisfies AppEnv;
    const logger = new EventLogger(() => {});
    const { app } = createTestApp({
      env,
      logger,
      whoIsFakerService: new WhoIsFakerService({ eventLogger: logger }),
    });
    for (const url of ["/api/auth/get-session", "/api/account/avatar/someone"]) {
      const response = await app.handle(new Request(`http://localhost${url}`));
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error?: { code?: string; traceId?: string } };
      expect(body.error?.code).toBe("ACCOUNT_DISABLED");
      // 停用体是手写 `Response` 产出的，全局 mapResponse 必须把追踪号补到响应头上，
      // 并让体里的 `traceId` 与响应头一致，否则运维拿着 503 查不到同一次请求的日志。
      const traceId = response.headers.get("x-trace-id") ?? "";
      expect(traceId).not.toBe("");
      expect(body.error?.traceId).toBe(traceId);
    }
    // RPC 按 oRPC 错误编码，客户端解出的 ORPCError.code 即 ACCOUNT_DISABLED。
    const rpc = await app.handle(
      new Request("http://localhost/api/rpc/account/me", { method: "POST" })
    );
    expect(rpc.status).toBe(503);
    expect(await rpc.json()).toEqual({
      json: { defined: false, code: "ACCOUNT_DISABLED", status: 503, message: "账号系统未启用" },
    });
    expect(rpc.headers.get("x-trace-id")).not.toBe("");
  });
});

describe("账号路由限流", () => {
  const disabledApp = () => {
    const env = {
      clientUrl: "http://localhost:5173",
      serverUrl: "http://localhost:4850",
      serverListenHost: "127.0.0.1",
      serverPort: 0,
      bangumiApiUrl: "https://api.bgm.tv",
      bangumiImageUrl: "",
    } satisfies AppEnv;
    const logger = new EventLogger(() => {});
    return createTestApp({
      env,
      logger,
      whoIsFakerService: new WhoIsFakerService({ eventLogger: logger }),
    }).app;
  };

  test("RPC 与 Better Auth 共用同一份客户端额度，超限回 429 并带 Retry-After", async () => {
    const app = disabledApp();
    const callRpc = () =>
      app.handle(new Request("http://localhost/api/rpc/account/me", { method: "POST" }));
    // 额度内不因限流改变语义：账号停用仍是 503。
    for (let i = 0; i < 200; i += 1) expect((await callRpc()).status).toBe(503);

    let status = 503;
    for (let i = 200; i < 302 && status === 503; i += 1) {
      const response = await callRpc();
      status = response.status;
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("60");
        // 被拒时还要说清是哪个桶、还剩多少、什么时候恢复：只有 Retry-After 的调用方无法判断该缩并发还是该退避。
        expect(response.headers.get("x-ratelimit-limit")).toBe("300");
        expect(response.headers.get("x-ratelimit-remaining")).toBe("0");
        expect(response.headers.get("x-trace-id")).not.toBe("");
        expect(await response.json()).toEqual({
          json: {
            defined: false,
            code: "RATE_LIMITED",
            status: 429,
            message: "请求过于频繁，请稍后重试",
          },
        });
      }
    }
    expect(status).toBe(429);
    // 同一桶覆盖两族路由：登录侧不能绕过 RPC 侧已经用完的额度。
    const auth = await app.handle(new Request("http://localhost/api/auth/get-session"));
    expect(auth.status).toBe(429);
    expect(await auth.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });
});

describe("验证码登录", () => {
  test("注册昵称强制取自 QQ 昵称（客户端自报被忽略）；成功后派生 QQ 号与站内头像", async () => {
    const { app, rpc, mailer, avatarFetcher, prepareSignup } = createAccountTestApp();
    await prepareSignup(QQ, "  笨蛋 玩家  ");
    const sent = await rpc("account/requestLoginCode", { qqNumber: QQ });
    expect(sent).toEqual({
      status: 200,
      body: { registered: false, resendAfterSeconds: 60, qqName: "笨蛋 玩家" },
    });
    const code = mailer.lastCodeFor(EMAIL);
    expect(code).toMatch(/^\d{6}$/);

    const signIn = (body: Record<string, unknown>) =>
      app.handle(
        new Request("http://localhost/api/auth/sign-in/email-otp", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:5173" },
          body: JSON.stringify({ email: EMAIL, otp: code, ...body }),
        })
      );
    const ok = await signIn({ name: "客户端自报的昵称" });
    expect(ok.status).toBe(200);
    const cookie = ok.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
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
    const post = (path: string, body: unknown) =>
      app.handle(
        new Request(`http://localhost/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:5173" },
          body: JSON.stringify(body),
        })
      );
    const foreign = await post("/sign-in/email-otp", {
      email: "someone@example.com",
      otp: "123456",
      name: "x",
    });
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ code: "INVALID_QQ_EMAIL" });
    const withImage = await post("/sign-in/email-otp", {
      email: EMAIL,
      otp: "123456",
      name: "x",
      image: "https://evil.example/a.png",
    });
    expect(withImage.status).toBe(400);
    expect(await withImage.json()).toMatchObject({ code: "FIELD_NOT_ALLOWED" });
    for (const path of [
      "/sign-up/email",
      "/email-otp/send-verification-otp",
      "/update-user",
      "/admin/list-users",
    ]) {
      expect((await post(path, {})).status).toBe(404);
    }
  });

  test("同一 QQ 号 60 秒内只发一次码，已注册账号返回 registered", async () => {
    const time = clock();
    const { rpc, signIn } = createAccountTestApp({ now: time.now });
    await signIn(QQ, "玩家");
    time.advance(61_000);
    expect(await rpc("account/requestLoginCode", { qqNumber: QQ })).toMatchObject({
      status: 200,
      body: { registered: true },
    });
    const limited = await rpc("account/requestLoginCode", { qqNumber: QQ });
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: "RATE_LIMITED" });
    expect((await rpc("account/requestLoginCode", { qqNumber: "0123" })).status).toBe(400);
  });

  test("邮件投递失败明确返回 503 MAIL_UNAVAILABLE", async () => {
    const { rpc, mailer, prepareSignup } = createAccountTestApp();
    await prepareSignup(QQ, "玩家");
    mailer.failNext = true;
    const response = await rpc("account/requestLoginCode", { qqNumber: QQ });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "MAIL_UNAVAILABLE" });
  });

  test("ADMIN_QQ 在建号时与启动引导时都提升为管理员", async () => {
    const first = createAccountTestApp({ adminQqNumbers: [QQ] });
    const { cookie } = await first.signIn(QQ, "站长");
    expect((await first.rpc("account/me", undefined, cookie)).body).toMatchObject({
      role: "admin",
    });

    const second = createAccountTestApp();
    const existing = await second.signIn("987654321", "老玩家");
    expect((await second.rpc("account/me", undefined, existing.cookie)).body).toMatchObject({
      role: "user",
    });
    await second.service.promoteAdmins(["987654321"]);
    expect((await second.rpc("account/me", undefined, existing.cookie)).body).toMatchObject({
      role: "admin",
    });
  });
});

describe("登录弹窗的昵称回显", () => {
  test("已注册只回库里最近同步的昵称且不打查询号；未注册现查一次，查不到回 null", async () => {
    const { rpc, signIn, napcat, prepareSignup } = createAccountTestApp();
    const nameOf = (qq: string) => rpc<string | null>("account/qqName", { qqNumber: qq });
    await signIn(QQ, "老玩家");
    const calls = napcat.state.calls.length;
    expect(await nameOf(QQ)).toEqual({ status: 200, body: "老玩家" });
    // 库里已有昵称：一个输入框的回显不该去打查询号
    expect(napcat.state.calls).toHaveLength(calls);

    await prepareSignup("55566677", "新玩家");
    expect(await nameOf("55566677")).toEqual({ status: 200, body: "新玩家" });
    expect(napcat.state.calls[napcat.state.calls.length - 1]).toEqual(["55566677"]);
    // 查不到只回 null，不报错误码：昵称空着不该挡住发码
    expect(await nameOf("77778888")).toEqual({ status: 200, body: null });
  });

  test("按客户端地址限流：同一地址超量后 429，换地址照常", async () => {
    const { rpc, prepareSignup } = createAccountTestApp();
    await prepareSignup(QQ, "玩家");
    const from = (ip: string) =>
      rpc("account/qqName", { qqNumber: QQ }, undefined, { "x-real-ip": ip });
    for (let i = 0; i < 12; i += 1) expect((await from("1.1.1.1")).status).toBe(200);
    const limited = await from("1.1.1.1");
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: "RATE_LIMITED" });
    expect((await from("2.2.2.2")).status).toBe(200);
  });
});

describe("通行密钥端点", () => {
  // 前端与后端不同主机才是生产的真实形状：rpID 误取后端域名时，同主机的用例照样绿。
  const CLIENT = "https://game.example.com";

  const authRequest = (
    app: ReturnType<typeof createAccountTestApp>["app"],
    path: string,
    init: { method?: string; cookie?: string; body?: unknown } = {}
  ) =>
    app.handle(
      new Request(`http://localhost/api/auth${path}`, {
        method: init.method ?? "GET",
        headers: {
          origin: CLIENT,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...(init.cookie ? { cookie: init.cookie } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
    );

  test("认证与注册选项的 rp.id 取前端域名，挑战写进签名 Cookie", async () => {
    const { app, signIn } = createAccountTestApp({ clientUrl: CLIENT });
    const anonymous = await authRequest(app, "/passkey/generate-authenticate-options");
    expect(anonymous.status).toBe(200);
    expect(await anonymous.json()).toMatchObject({ rpId: "game.example.com" });
    // 挑战值只存在 Cookie 与 verification 表里：代理丢 cookie 就会卡在 CHALLENGE_NOT_FOUND。
    expect(anonymous.headers.getSetCookie().join(";")).toContain("passkey");

    const { cookie } = await signIn(QQ, "玩家");
    const register = await authRequest(app, "/passkey/generate-register-options", { cookie });
    expect(register.status).toBe(200);
    const options = (await register.json()) as { rp: { id: string }; user: { id: string } };
    expect(options.rp.id).toBe("game.example.com");
    expect(options.user.id).toBeTruthy();
  });

  test("未登录拿不到密钥列表，改名端点不对外开放", async () => {
    const { app } = createAccountTestApp({ clientUrl: CLIENT });
    expect((await authRequest(app, "/passkey/list-user-passkeys")).status).toBe(401);
    const rename = await authRequest(app, "/passkey/update-passkey", {
      method: "POST",
      body: { id: "x", name: "y" },
    });
    expect(rename.status).toBe(404);
  });
});

describe("资料与头像", () => {
  test("QQ 号默认隐藏，本人公开后资料卡才显示；昵称不可改，未登录不能改资料", async () => {
    const { rpc, signIn } = createAccountTestApp();
    const { cookie } = await signIn(QQ, "玩家");
    const me = await rpc("account/me", undefined, cookie);
    const userId = String(me.body.id);
    expect((await rpc("account/publicProfile", { userId })).body).toMatchObject({
      name: "玩家",
      qqNumber: null,
    });

    expect((await rpc("account/updateProfile", { showQq: true })).status).toBe(401);
    // 账号昵称不可修改：请求里带 name 也会被契约丢弃，改不动。
    const updated = await rpc("account/updateProfile", { showQq: true, name: "新昵称" }, cookie);
    expect(updated.body).toMatchObject({ showQq: true, name: "玩家" });
    expect((await rpc("account/publicProfile", { userId })).body).toMatchObject({
      name: "玩家",
      qqNumber: QQ,
    });
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
    expect(
      (await app.handle(new Request("http://localhost/api/account/avatar/missing"))).status
    ).toBe(404);
  });
});

describe("游戏内账号身份", () => {
  const openRoom = async (port: number, cookie?: string) => {
    // Bun 的 WebSocket 支持自定义握手头，用来模拟浏览器自动携带的会话 Cookie。
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/whoisfaker/ws`, {
      headers: { origin: "http://localhost:5173", ...(cookie ? { cookie } : {}) },
    } as unknown as string[]);
    const messages: Array<{
      event?: string;
      payload?: { mode?: string; state?: { players?: Array<Record<string, unknown>> } };
    }> = [];
    socket.addEventListener("message", (event: MessageEvent<string>) =>
      messages.push(JSON.parse(event.data))
    );
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket 打开失败")), {
        once: true,
      });
    });
    socket.send(
      JSON.stringify({
        id: "create",
        type: "room.create",
        payload: {
          roomId: String(4000 + Math.floor(Math.random() * 5000)),
          name: "账号房",
          visibility: "public",
          allowSpectators: true,
          userName: "游戏昵称",
        },
      })
    );
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const snapshot = messages.find(
        (item) => item.event === "room.snapshot" && item.payload?.mode === "full"
      );
      if (snapshot) {
        socket.close();
        return snapshot.payload!.state!.players![0]!;
      }
      await Bun.sleep(20);
    }
    socket.close();
    throw new Error(`等待房间快照超时: ${JSON.stringify(messages).slice(0, 300)}`);
  };

  test("登录玩家的房间快照只带用户 ID 与站内头像，游客不带账号", async () => {
    const { app, rpc, signIn } = createAccountTestApp();
    const { cookie } = await signIn(QQ, "账号昵称");
    const me = (await rpc("account/me", undefined, cookie)).body;
    const server = app.listen({ hostname: "127.0.0.1", port: 0 });
    try {
      const port = server.server!.port!;
      const player = await openRoom(port, cookie);
      expect(player).toMatchObject({
        name: "游戏昵称",
        account: { userId: me.id, image: me.image },
      });
      expect(JSON.stringify(player)).not.toContain(QQ);
      expect((await openRoom(port)).account).toBeUndefined();
      expect((await openRoom(port, "bakagame.session_token=forged")).account).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });
});
