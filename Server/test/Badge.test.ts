import { describe, expect, test } from "bun:test";

import { createAccountTestApp } from "./AccountFixtures";

const ADMIN_QQ = "90001";

const setup = async () => {
  const ctx = createAccountTestApp({ adminQqNumbers: [ADMIN_QQ] });
  const admin = await ctx.signIn(ADMIN_QQ, "管理员");
  const alice = await ctx.signIn("10001", "Alice");
  const idOf = (qq: string) =>
    (ctx.db.user as Array<{ id: string; email: string }>).find(
      (user) => user.email === `${qq}@qq.com`
    )!.id;
  return {
    ...ctx,
    adminCookie: admin.cookie,
    adminId: idOf(ADMIN_QQ),
    alice,
    aliceId: idOf("10001"),
  };
};

describe("身份徽章", () => {
  test("管理员授予后本人与公开资料都可见，重复授予保持一枚", async () => {
    const { rpc, adminCookie, alice, aliceId } = await setup();

    const granted = await rpc(
      "admin/users/grantBadge",
      { userId: aliceId, badge: "developer" },
      adminCookie
    );
    expect(granted.status).toBe(200);
    expect(granted.body).toEqual({ ok: true });

    await rpc("admin/users/grantBadge", { userId: aliceId, badge: "developer" }, adminCookie);

    const me = await rpc("account/me", undefined, alice.cookie);
    expect(me.body).toMatchObject({ badges: ["developer"] });
    const publicProfile = await rpc("account/publicProfile", { userId: aliceId });
    expect(publicProfile.body).toMatchObject({ badges: ["developer"] });
  });

  test("徽章按目录顺序展示，撤销后立即消失", async () => {
    const { rpc, adminCookie, alice, aliceId } = await setup();
    await rpc("admin/users/grantBadge", { userId: aliceId, badge: "sponsor" }, adminCookie);
    await rpc("admin/users/grantBadge", { userId: aliceId, badge: "developer" }, adminCookie);

    const me = await rpc("account/me", undefined, alice.cookie);
    expect(me.body).toMatchObject({ badges: ["developer", "sponsor"] });

    expect(
      (await rpc("admin/users/revokeBadge", { userId: aliceId, badge: "developer" }, adminCookie))
        .body
    ).toEqual({ ok: true });
    expect((await rpc("account/me", undefined, alice.cookie)).body).toMatchObject({
      badges: ["sponsor"],
    });

    // 未授予时撤销同样成功：后台的重试不会因为「已经没了」而报错。
    expect(
      (await rpc("admin/users/revokeBadge", { userId: aliceId, badge: "tester" }, adminCookie)).body
    ).toEqual({ ok: true });
  });

  test("授予、撤销都先写审计", async () => {
    const { rpc, adminCookie, adminId, aliceId, audit } = await setup();
    await rpc("admin/users/grantBadge", { userId: aliceId, badge: "tester" }, adminCookie);
    await rpc("admin/users/revokeBadge", { userId: aliceId, badge: "tester" }, adminCookie);

    expect(
      audit.entries.map((entry) => [entry.actorId, entry.action, entry.targetId, entry.detail])
    ).toEqual([
      [adminId, "user.grantBadge", aliceId, { badge: "tester", name: "Alice" }],
      [adminId, "user.revokeBadge", aliceId, { badge: "tester", name: "Alice" }],
    ]);
  });

  test("审计写入失败时授予不执行", async () => {
    const { rpc, adminCookie, aliceId, audit, badges } = await setup();
    audit.failNext = true;
    expect(
      (await rpc("admin/users/grantBadge", { userId: aliceId, badge: "contributor" }, adminCookie))
        .status
    ).toBe(500);
    expect(badges.rows.size).toBe(0);
  });

  test("游客 401、普通用户 403、目标账号不存在 404、未知徽章 400", async () => {
    const { rpc, adminCookie, alice, aliceId } = await setup();
    expect((await rpc("admin/users/grantBadge", { userId: aliceId, badge: "developer" })).status).toBe(
      401
    );
    expect(
      (await rpc("admin/users/grantBadge", { userId: aliceId, badge: "developer" }, alice.cookie))
        .status
    ).toBe(403);
    expect(
      (await rpc("admin/users/grantBadge", { userId: "missing", badge: "developer" }, adminCookie))
        .status
    ).toBe(404);
    expect(
      (await rpc("admin/users/grantBadge", { userId: aliceId, badge: "founder" }, adminCookie))
        .status
    ).toBe(400);
  });

  test("房间握手身份仍只有用户 ID 与头像，徽章不进快照", async () => {
    const { service, adminCookie, rpc, alice, aliceId } = await setup();
    await rpc("admin/users/grantBadge", { userId: aliceId, badge: "sponsor" }, adminCookie);

    const account = await service.socketAccount(new Headers({ cookie: alice.cookie }));
    expect(account).toEqual({
      userId: aliceId,
      image: null,
    });
    expect(Object.keys(account ?? {}).sort()).toEqual(["image", "userId"]);
  });
});
