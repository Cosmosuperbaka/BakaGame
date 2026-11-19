import { describe, expect, test } from "bun:test";

import { createAccountTestApp } from "./AccountFixtures";

const OWNER_QQ = "90001";
const SECOND_QQ = "90002";
const THIRD_QQ = "90003";

/** 主理人（名单第一位）、另一位管理员、第三位管理员。 */
const setup = async () => {
  const ctx = createAccountTestApp({ adminQqNumbers: [OWNER_QQ, SECOND_QQ, THIRD_QQ] });
  const owner = await ctx.signIn(OWNER_QQ, "主理人");
  const second = await ctx.signIn(SECOND_QQ, "管理员乙");
  const third = await ctx.signIn(THIRD_QQ, "管理员丙");
  const idOf = (qq: string) =>
    (ctx.db.user as Array<{ id: string; email: string }>).find(
      (user) => user.email === `${qq}@qq.com`
    )!.id;
  return {
    ...ctx,
    owner,
    second,
    third,
    ownerId: idOf(OWNER_QQ),
    secondId: idOf(SECOND_QQ),
    thirdId: idOf(THIRD_QQ),
  };
};

describe("主理人保护", () => {
  test("其他管理员不能降级、封禁或强制下线主理人，且不留审计、状态不变", async () => {
    const { rpc, owner, second, ownerId, audit } = await setup();

    for (const [path, input] of [
      ["admin/users/setRole", { userId: ownerId, role: "user" }],
      ["admin/users/ban", { userId: ownerId, reason: "x" }],
      ["admin/users/revokeSessions", { userId: ownerId }],
    ] as const) {
      const denied = await rpc(path, input, second.cookie);
      expect(denied.status).toBe(400);
      expect(denied.body).toMatchObject({ code: "CANNOT_TARGET_ADMIN" });
    }

    // 被拒的操作没有写审计（审计只记真正执行的操作），主理人仍是管理员且会话还在。
    expect(audit.entries).toEqual([]);
    expect((await rpc("admin/users/get", { userId: ownerId }, owner.cookie)).body).toMatchObject({
      role: "admin",
      banned: false,
    });
    expect((await rpc("settings/get", undefined, owner.cookie)).status).toBe(200);
  });

  test("主理人仍可处置其他管理员，先写审计的约束不变", async () => {
    const { rpc, owner, third, secondId, thirdId, audit } = await setup();

    expect(
      (await rpc("admin/users/revokeSessions", { userId: thirdId }, owner.cookie)).body
    ).toEqual({ ok: true });
    expect((await rpc("settings/get", undefined, third.cookie)).status).toBe(401);
    expect(
      (await rpc("admin/users/setRole", { userId: secondId, role: "user" }, owner.cookie)).status
    ).toBe(200);

    expect(audit.entries.map((entry) => entry.action)).toEqual([
      "user.revokeSessions",
      "user.setRole",
    ]);

    audit.failNext = true;
    expect(
      (await rpc("admin/users/revokeSessions", { userId: thirdId }, owner.cookie)).status
    ).toBe(500);
  });

  test("普通管理员之间的既有规则不变：可互相强制下线，仍不能封禁管理员", async () => {
    const { rpc, second, third, thirdId } = await setup();

    expect(
      (await rpc("admin/users/ban", { userId: thirdId, reason: "x" }, second.cookie)).body
    ).toMatchObject({ code: "CANNOT_TARGET_ADMIN" });
    expect(
      (await rpc("admin/users/revokeSessions", { userId: thirdId }, second.cookie)).body
    ).toEqual({ ok: true });
    expect((await rpc("settings/get", undefined, third.cookie)).status).toBe(401);
  });
});
