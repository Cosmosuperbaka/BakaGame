import { describe, expect, test } from "bun:test";

import { PIONEER_BADGE_LIMIT } from "../src/shared/Badges";
import { createAccountTestApp } from "./AccountFixtures";

const ADMIN_QQ = "90001";

const setup = async (adminQqNumbers: string[] = [ADMIN_QQ]) => {
  const ctx = createAccountTestApp({ adminQqNumbers });
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
    idOf,
  };
};

describe("身份徽章", () => {
  test("建号自动获得先行者，最高管理员独占主理人并默认佩戴", async () => {
    const { rpc, adminCookie, adminId, alice, aliceId } = await setup();

    const adminMe = await rpc("account/me", undefined, adminCookie);
    expect(adminMe.body).toMatchObject({
      badges: [
        { kind: "owner", serial: null },
        { kind: "pioneer", serial: 1 },
      ],
      equippedBadge: "owner",
    });

    const aliceMe = await rpc("account/me", undefined, alice.cookie);
    expect(aliceMe.body).toMatchObject({
      badges: [{ kind: "pioneer", serial: 2 }],
      equippedBadge: "pioneer",
    });

    const publicProfile = await rpc("account/publicProfile", { userId: aliceId });
    expect(publicProfile.body).toMatchObject({
      badges: [{ kind: "pioneer", serial: 2 }],
      equippedBadge: "pioneer",
    });

    // 主理人只属于最高管理员；第二位管理员不会自动获得。
    expect((adminMe.body as { badges: unknown[] }).badges).toHaveLength(2);
    expect((await rpc("account/me", undefined, adminCookie)).body).toMatchObject({
      equippedBadge: "owner",
    });
    expect(adminId).not.toBe(aliceId);
  });

  test("第 1000 位仍自动获得先行者，第 1001 位不再获得", async () => {
    const { rpc, adminCookie, registrations, signIn, idOf } = await setup();

    registrations.nextSerial = PIONEER_BADGE_LIMIT;
    const boundary = await signIn("10002", "第一千位");
    expect((await rpc("account/me", undefined, boundary.cookie)).body).toMatchObject({
      badges: [{ kind: "pioneer", serial: PIONEER_BADGE_LIMIT }],
    });

    const late = await signIn("10003", "后来者");
    expect((await rpc("account/me", undefined, late.cookie)).body).toMatchObject({
      badges: [],
      equippedBadge: null,
    });

    // 没有徽章时手动授予贡献者，会顺带成为佩戴中的那一枚。
    await rpc(
      "admin/users/grantBadge",
      { userId: idOf("10003"), badge: "contributor" },
      adminCookie
    );
    expect((await rpc("account/me", undefined, late.cookie)).body).toMatchObject({
      badges: [{ kind: "contributor", serial: null }],
      equippedBadge: "contributor",
    });
  });

  test("贡献者手动授予、撤销与佩戴切换；未获得的徽章不能佩戴", async () => {
    const { rpc, adminCookie, alice, aliceId } = await setup();

    const granted = await rpc(
      "admin/users/grantBadge",
      { userId: aliceId, badge: "contributor" },
      adminCookie
    );
    expect(granted.status).toBe(200);
    expect(granted.body).toEqual({ ok: true });

    // 已有佩戴中的先行者，不会被后来授予的贡献者覆盖。
    expect((await rpc("account/me", undefined, alice.cookie)).body).toMatchObject({
      badges: [
        { kind: "contributor", serial: null },
        { kind: "pioneer", serial: 2 },
      ],
      equippedBadge: "pioneer",
    });

    const equipped = await rpc("account/equipBadge", { badge: "contributor" }, alice.cookie);
    expect(equipped.status).toBe(200);
    expect(equipped.body).toMatchObject({ equippedBadge: "contributor" });
    expect((await rpc("account/publicProfile", { userId: aliceId })).body).toMatchObject({
      equippedBadge: "contributor",
    });

    expect((await rpc("account/equipBadge", { badge: null }, alice.cookie)).body).toMatchObject({
      equippedBadge: null,
    });

    const notOwned = await rpc("account/equipBadge", { badge: "owner" }, alice.cookie);
    expect(notOwned.status).toBe(403);
    expect((await rpc("account/equipBadge", { badge: "contributor" })).status).toBe(401);

    await rpc("account/equipBadge", { badge: "contributor" }, alice.cookie);
    expect(
      (await rpc("admin/users/revokeBadge", { userId: aliceId, badge: "contributor" }, adminCookie))
        .body
    ).toEqual({ ok: true });
    expect((await rpc("account/me", undefined, alice.cookie)).body).toMatchObject({
      badges: [{ kind: "pioneer", serial: 2 }],
      equippedBadge: null,
    });

    // 未授予时撤销同样成功：后台的重试不会因为「已经没了」而报错。
    expect(
      (await rpc("admin/users/revokeBadge", { userId: aliceId, badge: "contributor" }, adminCookie))
        .body
    ).toEqual({ ok: true });
  });

  test("管理端列表与详情带出徽章与佩戴状态", async () => {
    const { rpc, adminCookie, aliceId } = await setup();

    const list = await rpc<{ items: Array<Record<string, unknown>> }>(
      "admin/users/list",
      { limit: 10, offset: 0 },
      adminCookie
    );
    const aliceRow = list.body.items.find((item) => item.id === aliceId);
    expect(aliceRow).toMatchObject({
      badges: [{ kind: "pioneer", serial: 2 }],
      equippedBadge: "pioneer",
    });

    const detail = await rpc("admin/users/get", { userId: aliceId }, adminCookie);
    expect(detail.body).toMatchObject({
      badges: [{ kind: "pioneer", serial: 2 }],
      equippedBadge: "pioneer",
    });
  });

  test("授予、撤销贡献者都先写审计", async () => {
    const { rpc, adminCookie, adminId, aliceId, audit } = await setup();
    await rpc("admin/users/grantBadge", { userId: aliceId, badge: "contributor" }, adminCookie);
    await rpc("admin/users/revokeBadge", { userId: aliceId, badge: "contributor" }, adminCookie);

    expect(
      audit.entries.map((entry) => [entry.actorId, entry.action, entry.targetId, entry.detail])
    ).toEqual([
      [adminId, "user.grantBadge", aliceId, { badge: "contributor", name: "Alice" }],
      [adminId, "user.revokeBadge", aliceId, { badge: "contributor", name: "Alice" }],
    ]);
  });

  test("审计写入失败时授予不执行", async () => {
    const { rpc, adminCookie, aliceId, audit, badges } = await setup();
    audit.failNext = true;
    expect(
      (await rpc("admin/users/grantBadge", { userId: aliceId, badge: "contributor" }, adminCookie))
        .status
    ).toBe(500);
    expect(badges.rows.has(`${aliceId}:contributor`)).toBe(false);
  });

  test("游客 401、普通用户 403、目标账号不存在 404、未知徽章 400", async () => {
    const { rpc, adminCookie, alice, aliceId } = await setup();
    expect(
      (await rpc("admin/users/grantBadge", { userId: aliceId, badge: "contributor" })).status
    ).toBe(401);
    expect(
      (await rpc("admin/users/grantBadge", { userId: aliceId, badge: "contributor" }, alice.cookie))
        .status
    ).toBe(403);
    expect(
      (
        await rpc(
          "admin/users/grantBadge",
          { userId: "missing", badge: "contributor" },
          adminCookie
        )
      ).status
    ).toBe(404);
    expect(
      (await rpc("admin/users/grantBadge", { userId: aliceId, badge: "founder" }, adminCookie))
        .status
    ).toBe(400);
  });

  test("主理人与先行者不能手动授予或撤销", async () => {
    const { rpc, adminCookie, aliceId } = await setup();
    for (const badge of ["owner", "pioneer"] as const) {
      expect(
        (await rpc("admin/users/grantBadge", { userId: aliceId, badge }, adminCookie)).status
      ).toBe(403);
      expect(
        (await rpc("admin/users/revokeBadge", { userId: aliceId, badge }, adminCookie)).status
      ).toBe(403);
    }
  });

  test("启动时清理非最高管理员的主理人", async () => {
    const { rpc, service, badges, idOf, signIn } = await setup([ADMIN_QQ, "90002"]);
    const secondAdmin = await signIn("90002", "第二管理员");
    const secondId = idOf("90002");
    await badges.grant(secondId, "owner", null, new Date());

    await service.ensureAutomaticBadges();

    expect((await rpc("account/me", undefined, secondAdmin.cookie)).body).toMatchObject({
      badges: [{ kind: "pioneer", serial: 3 }],
    });
  });

  test("房间握手身份仍只有用户 ID 与头像，徽章不进快照", async () => {
    const { service, alice, aliceId } = await setup();

    const account = await service.socketAccount(new Headers({ cookie: alice.cookie }));
    expect(account).toEqual({
      userId: aliceId,
      image: null,
    });
    expect(Object.keys(account ?? {}).sort()).toEqual(["image", "userId"]);
  });
});
