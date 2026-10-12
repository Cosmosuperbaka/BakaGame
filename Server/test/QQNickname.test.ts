import { describe, expect, test } from "bun:test";

import { QQ_NAME_REFRESH_INTERVAL_MS } from "../src/application/QQNicknameService";
import { QQWebLoginClient, gtkOf, parsePtuiCallback, ptqrToken } from "../src/infrastructure/auth/QQWebLogin";
import { createAccountTestApp, createQQWebFetcher } from "./AccountFixtures";

const ADMIN_QQ = "90001";

type UserRow = { id: string; email: string; qqName?: string | null; qqNameCheckedAt?: Date | null };

const setup = async (options: Parameters<typeof createAccountTestApp>[0] = {}) => {
  const ctx = createAccountTestApp({ adminQqNumbers: [ADMIN_QQ], ...options });
  const admin = await ctx.signIn(ADMIN_QQ, "管理员");
  const userOf = (qq: string) => (ctx.db.user as UserRow[]).find((user) => user.email === `${qq}@qq.com`);
  /** 后台扫码登录查询号：二维码 → 等待 → 已扫 → 确认。 */
  const loginLookup = async () => {
    const started = await ctx.rpc("admin/qq/startLogin", undefined, admin.cookie);
    const loginId = String(started.body.loginId);
    const poll = () => ctx.rpc("admin/qq/pollLogin", { loginId }, admin.cookie);
    ctx.qqWeb.state.login = "66";
    expect((await poll()).body).toEqual({ state: "waiting" });
    ctx.qqWeb.state.login = "67";
    expect((await poll()).body).toEqual({ state: "scanned" });
    ctx.qqWeb.state.login = "0";
    return { started, result: await poll(), poll };
  };
  return { ...ctx, adminCookie: admin.cookie, userOf, loginLookup };
};

/** `me()` 的昵称刷新不阻塞响应，轮询等它落库。 */
const waitFor = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 50 && !check(); attempt += 1) await Bun.sleep(5);
  expect(check()).toBe(true);
};

describe("QQ 网页登录协议", () => {
  test("ptqrtoken 与 g_tk 的哈希", () => {
    expect(ptqrToken("")).toBe(0);
    expect(ptqrToken("a")).toBe(97);
    expect(gtkOf("")).toBe(5381);
    expect(gtkOf("a")).toBe(5381 * 33 + 97);
  });

  test("解析 ptuiCB 回调参数", () => {
    expect(parsePtuiCallback("ptuiCB('0','0','https://x/check_sig?a=1','0','登录成功！', '昵称')"))
      .toEqual(["0", "0", "https://x/check_sig?a=1", "0", "登录成功！", "昵称"]);
    expect(parsePtuiCallback("<html>")).toBeNull();
  });

  test("确认登录后跟随 check_sig 收集 Cookie", async () => {
    const { fetcher, state } = createQQWebFetcher();
    const client = new QQWebLoginClient(fetcher);
    const { image, qrsig } = await client.createQrCode();
    expect(image.startsWith("data:image/png;base64,")).toBe(true);
    expect(await client.poll(qrsig)).toEqual({ state: "waiting" });
    state.login = "10006";
    expect(await client.poll(qrsig)).toMatchObject({ state: "failed" });
    state.login = "0";
    const result = await client.poll(qrsig);
    expect(result).toMatchObject({ state: "success", uin: "12345", nickname: "查询号" });
    if (result.state !== "success") throw new Error("unreachable");
    expect(result.cookies).toMatchObject({ p_skey: "PSKEY", skey: "@SKEY", uin: "o0012345" });
  });

  test("昵称按 GBK 解码并还原 HTML 实体；未登录报失效", async () => {
    const { fetcher, state } = createQQWebFetcher();
    const client = new QQWebLoginClient(fetcher);
    const cookies = { p_skey: "PSKEY" };
    expect([...await client.nicknames(["10001", "20002", "30003"], cookies)]).toEqual([["10001", "阿狸"], ["20002", "请先"]]);
    state.expired = true;
    await expect(client.nicknames(["10001"], cookies)).rejects.toMatchObject({ code: "QQ_SESSION_EXPIRED" });
  });
});

describe("后台查询号", () => {
  test("仅管理员可用；扫码登录先审计再保存，登录态加密落库", async () => {
    const { rpc, adminCookie, signIn, loginLookup, audit, siteConfig } = await setup();
    const user = await signIn("10001", "Alice");
    expect((await rpc("admin/qq/status", undefined, user.cookie)).status).toBe(403);
    expect((await rpc("admin/qq/status", undefined, adminCookie)).body).toMatchObject({ state: "signedOut", uin: null });

    const { started, result } = await loginLookup();
    expect(String(started.body.image).startsWith("data:image/png;base64,")).toBe(true);
    expect(result.body).toMatchObject({ state: "success", status: { state: "active", uin: "12345", nickname: "查询号" } });
    expect(audit.entries.at(-1)).toMatchObject({ action: "qq.login", targetType: "site", targetId: "qq.lookup", detail: { uin: "12345" } });

    const stored = String(siteConfig.rows.get("qq.lookupSession"));
    expect(stored).not.toContain("PSKEY");
    expect((await rpc("admin/qq/status", undefined, adminCookie)).body).toMatchObject({ state: "active" });
  });

  test("审计失败不保存登录态；登录 ID 用过即失效", async () => {
    const { rpc, adminCookie, audit, siteConfig, qqWeb } = await setup();
    const loginId = String((await rpc("admin/qq/startLogin", undefined, adminCookie)).body.loginId);
    qqWeb.state.login = "0";
    audit.failNext = true;
    expect((await rpc("admin/qq/pollLogin", { loginId }, adminCookie)).status).toBe(500);
    expect(siteConfig.rows.size).toBe(0);
    expect((await rpc("admin/qq/pollLogin", { loginId }, adminCookie)).body).toEqual({ state: "expired" });
    expect((await rpc("admin/qq/pollLogin", { loginId: crypto.randomUUID() }, adminCookie)).body).toEqual({ state: "expired" });
  });

  test("退出登录记审计并清除登录态", async () => {
    const { rpc, adminCookie, loginLookup, audit, siteConfig } = await setup();
    await loginLookup();
    expect((await rpc("admin/qq/logout", undefined, adminCookie)).status).toBe(200);
    expect(audit.entries.at(-1)).toMatchObject({ action: "qq.logout", detail: { uin: "12345" } });
    expect(siteConfig.rows.has("qq.lookupSession")).toBe(false);
    expect((await rpc("admin/qq/status", undefined, adminCookie)).body).toMatchObject({ state: "signedOut" });
  });
});

describe("昵称查询与同步", () => {
  test("未登录查询号时注册不预填", async () => {
    const { rpc, qqWeb } = await setup();
    expect((await rpc("account/requestLoginCode", { qqNumber: "10001" })).body).toMatchObject({ registered: false, qqName: null });
    expect(qqWeb.state.portraitCalls).toEqual([]);
  });

  test("新账号发码时预填 QQ 昵称，老账号不查", async () => {
    let clock = Date.now();
    const { rpc, loginLookup, qqWeb } = await setup({ now: () => clock });
    await loginLookup();
    clock += 61_000; // 越过管理员账号的重发间隔
    expect((await rpc("account/requestLoginCode", { qqNumber: "10001" })).body).toMatchObject({ registered: false, qqName: "阿狸" });
    expect((await rpc("account/requestLoginCode", { qqNumber: ADMIN_QQ })).body).toMatchObject({ registered: true, qqName: null });
    expect(qqWeb.state.portraitCalls).toEqual([["10001"]]);
  });

  test("访问时按间隔刷新本人 QQ 昵称，不覆盖账号昵称", async () => {
    let clock = Date.now();
    const { rpc, signIn, loginLookup, userOf, qqWeb } = await setup({ now: () => clock });
    await loginLookup();
    const { cookie } = await signIn("20002", "Bob");
    // 发码预填刚查过，首次访问直接用缓存
    expect((await rpc("account/me", undefined, cookie)).body).toMatchObject({ name: "Bob" });
    await waitFor(() => userOf("20002")?.qqName === "请先");
    expect(qqWeb.state.portraitCalls).toEqual([["20002"]]);

    await rpc("account/me", undefined, cookie);
    await Bun.sleep(20);
    expect(qqWeb.state.portraitCalls.length).toBe(1);

    clock += QQ_NAME_REFRESH_INTERVAL_MS + 11 * 60 * 1000;
    qqWeb.state.names.set("20002", "&#26032;&#21517;");
    await rpc("account/me", undefined, cookie);
    await waitFor(() => userOf("20002")?.qqName === "新名");
    expect((await rpc("account/me", undefined, cookie)).body).toMatchObject({ name: "Bob" });
  });

  test("接口报登录失效后标记为失效，不再请求", async () => {
    const { rpc, adminCookie, loginLookup, qqWeb } = await setup();
    await loginLookup();
    qqWeb.state.expired = true;
    expect((await rpc("account/requestLoginCode", { qqNumber: "10001" })).body).toMatchObject({ qqName: null });
    expect((await rpc("admin/qq/status", undefined, adminCookie)).body).toMatchObject({ state: "expired", expiredAt: expect.any(String) });
    expect((await rpc("account/requestLoginCode", { qqNumber: "20002" })).body).toMatchObject({ qqName: null });
    expect(qqWeb.state.portraitCalls.length).toBe(1);
    expect((await rpc("admin/qq/refreshNames", undefined, adminCookie)).status).toBe(400);
  });

  test("后台批量刷新：分批查询、记审计，后台用户列表带 QQ 昵称", async () => {
    const { rpc, adminCookie, signIn, loginLookup, audit, qqWeb } = await setup();
    for (let index = 0; index < 22; index += 1) await signIn(String(30000 + index), `玩家${index}`);
    await signIn("10001", "Alice");
    expect((await rpc("admin/qq/refreshNames", undefined, adminCookie)).status).toBe(400);
    await loginLookup();
    const refreshed = await rpc("admin/qq/refreshNames", undefined, adminCookie);
    expect(refreshed.body).toEqual({ checked: 24, updated: 1, remaining: 0 });
    expect(audit.entries.at(-1)).toMatchObject({ action: "qq.refreshNames" });
    expect(qqWeb.state.portraitCalls.map((batch) => batch.length)).toEqual([20, 4]);

    const listed = await rpc("admin/users/list", { query: "10001" }, adminCookie);
    expect(listed.body.items).toMatchObject([{ name: "Alice", qqName: "阿狸" }]);
    expect((await rpc("admin/qq/refreshNames", undefined, adminCookie)).body).toEqual({ checked: 0, updated: 0, remaining: 0 });
  });
});
