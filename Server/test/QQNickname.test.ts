import { describe, expect, test } from "bun:test";

import { QQ_NAME_REFRESH_INTERVAL_MS } from "../src/application/QQNicknameService";
import { QQNapCatClient } from "../src/infrastructure/auth/QQNapCatClient";
import { createAccountTestApp, createNapCatFetcher } from "./AccountFixtures";

const ADMIN_QQ = "90001";

type UserRow = { id: string; email: string; qqName?: string | null; qqNameCheckedAt?: Date | null };

const setup = async (options: Parameters<typeof createAccountTestApp>[0] = {}) => {
  const ctx = createAccountTestApp({ adminQqNumbers: [ADMIN_QQ], ...options });
  const admin = await ctx.signIn(ADMIN_QQ, "管理员");
  const userOf = (qq: string) => (ctx.db.user as UserRow[]).find((user) => user.email === `${qq}@qq.com`);
  return { ...ctx, adminCookie: admin.cookie, userOf };
};

/** `me()` 的昵称刷新不阻塞响应，轮询等它落库。 */
const waitFor = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 50 && !check(); attempt += 1) await Bun.sleep(5);
  expect(check()).toBe(true);
};

const clientOf = () => {
  const { fetcher, state } = createNapCatFetcher();
  const client = new QQNapCatClient({
    apiUrl: "https://napcat.test/onebot-internal",
    accessToken: state.token,
    fetcher,
    minIntervalMs: 0,
  });
  return { client, state };
};

describe("NapCat 昵称客户端", () => {
  test("逐个查昵称，查不到的号不出现", async () => {
    const { client, state } = clientOf();
    const names = await client.nicknames(["10001", "20002", "30003"]);
    expect([...names]).toEqual([["10001", "阿狸"], ["20002", "请先"]]);
    expect(state.calls).toEqual([["10001"], ["20002"], ["30003"]]);
  });

  test("昵称里的方向隔离符等不可见字符被清掉", async () => {
    const { client, state } = clientOf();
    state.names.set("10001", "A\u2067B\u2066\u200bC");
    expect((await client.nicknames(["10001"])).get("10001")).toBe("ABC");
  });

  test("令牌错误抛不可用（kind=unauthorized）", async () => {
    const { fetcher } = createNapCatFetcher();
    const client = new QQNapCatClient({
      apiUrl: "https://napcat.test/onebot-internal",
      accessToken: "wrong-token",
      fetcher,
      minIntervalMs: 0,
    });
    await expect(client.nicknames(["10001"])).rejects.toMatchObject({
      code: "QQ_NICKNAME_UNAVAILABLE",
      details: { kind: "unauthorized" },
    });
  });

  test("全部号都查不到时抛错，与个别号查不到区分", async () => {
    const { client, state } = clientOf();
    state.online = false;
    await expect(client.nicknames(["10001"])).rejects.toMatchObject({ code: "QQ_NICKNAME_UNAVAILABLE" });
  });

  test("get_login_info 返回登录号自身；掉线时返回 null", async () => {
    const { client, state } = clientOf();
    expect(await client.loginInfo()).toEqual({ uin: "90001", nickname: "查询号" });
    state.online = false;
    expect(await client.loginInfo()).toBeNull();
  });
});

describe("后台查询号", () => {
  test("仅管理员可用；状态反映 NapCat 登录的 QQ 号", async () => {
    const { rpc, adminCookie, signIn } = await setup();
    const user = await signIn("10001", "Alice");
    expect((await rpc("admin/qq/status", undefined, user.cookie)).status).toBe(403);
    expect((await rpc("admin/qq/status", undefined, adminCookie)).body).toMatchObject({
      state: "active",
      uin: "90001",
      nickname: "查询号",
      error: null,
    });
  });

  test("NapCat 掉线时状态为不可用并给出原因", async () => {
    const { rpc, adminCookie, napcat } = await setup();
    napcat.state.online = false;
    const status = await rpc("admin/qq/status", undefined, adminCookie);
    expect(status.body).toMatchObject({ state: "unavailable", uin: null, error: expect.any(String) });
  });

  test("批量刷新先写审计；实例不可用时返回 503", async () => {
    const { rpc, adminCookie, audit, napcat } = await setup();
    napcat.state.online = false;
    expect((await rpc("admin/qq/refreshNames", undefined, adminCookie)).status).toBe(503);
    expect(audit.entries.at(-1)).toMatchObject({ action: "qq.refreshNames", targetId: "qq.lookup" });
  });
});

describe("昵称查询与同步", () => {
  test("NapCat 不可用时新号发码被拒（停用注册），老账号登录不受影响", async () => {
    let clock = Date.now();
    const { rpc, napcat } = await setup({ now: () => clock });
    napcat.state.online = false;
    clock += 61_000; // 越过管理员账号的重发间隔

    const rejected = await rpc("account/requestLoginCode", { qqNumber: "10001" });
    expect(rejected.status).toBe(503);
    expect(rejected.body).toMatchObject({ code: "QQ_NICKNAME_UNAVAILABLE" });
    // 掉线时照样发起一次查询（拿不到结果），不做长期的「失效」标记：
    // NapCat 侧的掉线多为临时状态，持久停用只会让恢复多等一轮。
    expect(napcat.state.calls).toEqual([["90001"], ["10001"]]);
    // 已注册账号不发查询，照常发码
    expect((await rpc("account/requestLoginCode", { qqNumber: ADMIN_QQ })).body).toMatchObject({ registered: true, qqName: null });
  });

  test("新账号发码返回将使用的 QQ 昵称，老账号不查", async () => {
    let clock = Date.now();
    const { rpc, napcat } = await setup({ now: () => clock });
    clock += 61_000; // 越过管理员账号的重发间隔
    expect((await rpc("account/requestLoginCode", { qqNumber: "10001" })).body).toMatchObject({ registered: false, qqName: "阿狸" });
    clock += 61_000;
    expect((await rpc("account/requestLoginCode", { qqNumber: ADMIN_QQ })).body).toMatchObject({ registered: true, qqName: null });
    expect(napcat.state.calls).toEqual([["90001"], ["10001"]]);
  });

  test("账号昵称 = QQ 昵称；QQ 昵称变化后按访问间隔同步", async () => {
    let clock = Date.now();
    const { rpc, signIn, userOf, napcat } = await setup({ now: () => clock });
    // "20002" 的 QQ 昵称是 "请先"，注册名直接取它
    const { cookie } = await signIn("20002");
    expect((await rpc("account/me", undefined, cookie)).body).toMatchObject({ name: "请先" });
    // 发码阶段刚查过：首次访问用缓存落库，不再请求
    await waitFor(() => userOf("20002")?.qqName === "请先");
    expect(napcat.state.calls).toEqual([["90001"], ["20002"]]);

    await rpc("account/me", undefined, cookie);
    await Bun.sleep(20);
    expect(napcat.state.calls.length).toBe(2);

    clock += QQ_NAME_REFRESH_INTERVAL_MS + 11 * 60 * 1000;
    napcat.state.names.set("20002", "新名");
    await rpc("account/me", undefined, cookie);
    await waitFor(() => userOf("20002")?.qqName === "新名");
    expect((await rpc("account/me", undefined, cookie)).body).toMatchObject({ name: "新名" });
    expect(napcat.state.calls).toEqual([["90001"], ["20002"], ["20002"]]);
  });

  test("后台批量刷新：逐个查询、同步账号昵称并记审计，后台用户列表带 QQ 昵称", async () => {
    let clock = Date.now();
    const { rpc, adminCookie, signIn, audit, napcat } = await setup({ now: () => clock });
    for (let index = 0; index < 22; index += 1) await signIn(String(30000 + index), `玩家${index}`);
    await signIn("10001", "Alice");
    const before = napcat.state.calls.length;
    // 改掉 Alice 的 QQ 昵称：刷新应同步账号昵称并计入 updated
    napcat.state.names.set("10001", "Alice2");
    clock += QQ_NAME_REFRESH_INTERVAL_MS + 11 * 60 * 1000;
    const refreshed = await rpc("admin/qq/refreshNames", undefined, adminCookie);
    expect(refreshed.body).toEqual({ checked: 24, updated: 1, remaining: 0 });
    expect(audit.entries.at(-1)).toMatchObject({ action: "qq.refreshNames" });
    // 一个号一次调用，不再是按 20 个一批
    expect(napcat.state.calls.length - before).toBe(24);
    expect(new Set(napcat.state.calls.slice(before).map((call) => call[0])).size).toBe(24);

    const listed = await rpc("admin/users/list", { query: "10001" }, adminCookie);
    expect(listed.body.items).toMatchObject([{ name: "Alice2", qqName: "Alice2" }]);
    expect((await rpc("admin/qq/refreshNames", undefined, adminCookie)).body).toEqual({ checked: 0, updated: 0, remaining: 0 });
  });
});
