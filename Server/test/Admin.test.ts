import { describe, expect, test } from "bun:test";

import type { GameRecordRepository, StoredGameRecord } from "../src/infrastructure/db/GameRecordRepository";
import { createAccountTestApp } from "./AccountFixtures";

const ADMIN_QQ = "90001";

/** 管理员 + 两个普通用户，返回各自 Cookie 与用户 ID。 */
const setup = async (options: Parameters<typeof createAccountTestApp>[0] = {}) => {
  const ctx = createAccountTestApp({ adminQqNumbers: [ADMIN_QQ], ...options });
  const admin = await ctx.signIn(ADMIN_QQ, "管理员");
  const alice = await ctx.signIn("10001", "Alice");
  const bob = await ctx.signIn("20002", "Bob");
  const idOf = (qq: string) => (ctx.db.user as Array<{ id: string; email: string }>).find((user) => user.email === `${qq}@qq.com`)!.id;
  return { ...ctx, adminCookie: admin.cookie, alice, bob, adminId: idOf(ADMIN_QQ), aliceId: idOf("10001"), bobId: idOf("20002") };
};

describe("管理后台权限", () => {
  test("游客 401，普通用户 403，管理员可用", async () => {
    const { rpc, adminCookie, alice } = await setup();
    expect((await rpc("admin/users/list", {})).status).toBe(401);
    expect((await rpc("admin/users/list", {}, alice.cookie)).status).toBe(403);
    const listed = await rpc("admin/users/list", {}, adminCookie);
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(3);
  });

  test("降级立即生效，不等会话缓存过期", async () => {
    const { rpc, adminCookie, alice, aliceId, bobId } = await setup();
    expect((await rpc("admin/users/setRole", { userId: aliceId, role: "admin" }, adminCookie)).body).toMatchObject({ role: "admin" });
    expect((await rpc("admin/users/get", { userId: bobId }, alice.cookie)).status).toBe(200);
    expect((await rpc("admin/users/setRole", { userId: aliceId, role: "user" }, adminCookie)).status).toBe(200);
    expect((await rpc("admin/users/get", { userId: bobId }, alice.cookie)).status).toBe(403);
  });
});

describe("用户管理", () => {
  test("纯数字按 QQ 号前缀搜索，其余按昵称包含", async () => {
    const { rpc, adminCookie } = await setup();
    const byQq = await rpc("admin/users/list", { query: "100" }, adminCookie);
    expect((byQq.body.items as Array<{ name: string }>).map((user) => user.name)).toEqual(["Alice"]);
    const byName = await rpc("admin/users/list", { query: "ob" }, adminCookie);
    expect((byName.body.items as Array<{ qqNumber: string }>).map((user) => user.qqNumber)).toEqual(["20002"]);
    const admins = await rpc("admin/users/list", { role: "admin" }, adminCookie);
    expect(admins.body.total).toBe(1);
  });

  test("封禁踢下线、拦截发码与登录，解封后恢复", async () => {
    let clock = Date.now();
    const { rpc, adminCookie, alice, aliceId, mailer, signIn } = await setup({ now: () => clock });
    const sentBefore = mailer.sent.length;
    clock += 61_000; // 越过重发间隔，确保拦下发码的是封禁而非限流

    const banned = await rpc("admin/users/ban", { userId: aliceId, reason: "刷屏", expiresInHours: 24 }, adminCookie);
    expect(banned.status).toBe(200);
    expect(banned.body).toMatchObject({ banned: true, banReason: "刷屏" });
    expect(banned.body.banExpires).toEqual(expect.any(String));

    expect((await rpc("settings/get", undefined, alice.cookie)).status).toBe(401);
    const code = await rpc("account/requestLoginCode", { qqNumber: "10001" });
    expect(code.status).toBe(403);
    expect(code.body.message).toBe("账号已被封禁");
    expect(mailer.sent.length).toBe(sentBefore);

    expect((await rpc("admin/users/list", { banned: true }, adminCookie)).body.total).toBe(1);

    expect((await rpc("admin/users/unban", { userId: aliceId }, adminCookie)).body).toMatchObject({ banned: false, banReason: null });
    clock += 61_000;
    const again = await signIn("10001");
    expect(again.response.status).toBe(200);
    expect((await rpc("account/me", undefined, again.cookie)).body).toMatchObject({ name: "Alice" });
  });

  test("限时封禁到期后可以重新获取验证码", async () => {
    let clock = Date.now();
    const { rpc, adminCookie, aliceId } = await setup({ now: () => clock });
    await rpc("admin/users/ban", { userId: aliceId, reason: "冷静一下", expiresInHours: 1 }, adminCookie);
    clock += 61_000;
    expect((await rpc("account/requestLoginCode", { qqNumber: "10001" })).status).toBe(403);
    clock += 2 * 3_600_000;
    expect((await rpc("account/requestLoginCode", { qqNumber: "10001" })).body).toMatchObject({ registered: true });
  });

  test("不能处置自己或其他管理员，被封用户不能直接提为管理员", async () => {
    const { rpc, adminCookie, adminId, aliceId, bobId } = await setup();
    expect((await rpc("admin/users/ban", { userId: adminId, reason: "x" }, adminCookie)).body.code).toBe("CANNOT_TARGET_SELF");
    expect((await rpc("admin/users/setRole", { userId: adminId, role: "user" }, adminCookie)).body.code).toBe("CANNOT_TARGET_SELF");

    await rpc("admin/users/setRole", { userId: aliceId, role: "admin" }, adminCookie);
    expect((await rpc("admin/users/ban", { userId: aliceId, reason: "x" }, adminCookie)).body.code).toBe("CANNOT_TARGET_ADMIN");

    await rpc("admin/users/ban", { userId: bobId, reason: "x" }, adminCookie);
    expect((await rpc("admin/users/setRole", { userId: bobId, role: "admin" }, adminCookie)).body.code).toBe("USER_BANNED");
    expect((await rpc("admin/users/get", { userId: "missing" }, adminCookie)).status).toBe(404);
  });

  test("改名、强制下线并留下审计", async () => {
    const { rpc, adminCookie, adminId, bob, bobId, audit } = await setup();
    expect((await rpc("admin/users/rename", { userId: bobId, name: "  新名字 " }, adminCookie)).body).toMatchObject({ name: "新名字" });
    expect((await rpc("admin/users/revokeSessions", { userId: bobId }, adminCookie)).body).toEqual({ ok: true });
    expect((await rpc("settings/get", undefined, bob.cookie)).status).toBe(401);

    expect(audit.entries.map((entry) => [entry.actorId, entry.action, entry.targetId])).toEqual([
      [adminId, "user.rename", bobId],
      [adminId, "user.revokeSessions", bobId],
    ]);
    expect(audit.entries[0]!.detail).toEqual({ from: "Bob", to: "新名字" });

    const listed = await rpc("admin/audit/list", { action: "user.rename" }, adminCookie);
    expect(listed.body.total).toBe(1);
    expect((listed.body.items as Array<{ actor: { name: string } }>)[0]!.actor.name).toBe("管理员");
  });

  test("审计写入失败时操作不执行", async () => {
    const { rpc, adminCookie, bob, bobId, audit } = await setup();
    audit.failNext = true;
    expect((await rpc("admin/users/ban", { userId: bobId, reason: "x" }, adminCookie)).status).toBe(500);
    expect((await rpc("settings/get", undefined, bob.cookie)).status).toBe(200);
    expect((await rpc("admin/users/get", { userId: bobId }, adminCookie)).body).toMatchObject({ banned: false });
  });
});

describe("反馈管理", () => {
  test("回复让用户看到未读，待处理自动转处理中", async () => {
    const { rpc, adminCookie, alice } = await setup();
    const created = await rpc("feedback/create", { kind: "suggestion", title: "加个夜间模式", content: "晚上太亮" }, alice.cookie);
    const id = created.body.id as string;

    const listed = await rpc("admin/feedback/list", { status: "open" }, adminCookie);
    expect(listed.body.total).toBe(1);
    expect((listed.body.items as Array<{ user: { name: string } }>)[0]!.user.name).toBe("Alice");

    const replied = await rpc("admin/feedback/reply", { id, content: "排期中" }, adminCookie);
    expect(replied.body).toMatchObject({ status: "processing", content: "晚上太亮" });
    expect((replied.body.replies as Array<{ content: string; author: { name: string } }>)[0]).toMatchObject({
      content: "排期中", author: { name: "管理员" },
    });

    const mine = await rpc("feedback/listMine", undefined, alice.cookie);
    expect(mine.body.unread).toBe(1);
    const detail = await rpc("feedback/get", { id }, alice.cookie);
    expect((detail.body.replies as Array<{ content: string }>).map((reply) => reply.content)).toEqual(["排期中"]);
    expect((await rpc("feedback/listMine", undefined, alice.cookie)).body.unread).toBe(0);

    expect((await rpc("admin/feedback/setStatus", { id, status: "resolved" }, adminCookie)).body).toMatchObject({ status: "resolved" });
    expect((await rpc("admin/feedback/list", { status: "resolved" }, adminCookie)).body.total).toBe(1);
    expect((await rpc("admin/feedback/reply", { id, content: "  " }, adminCookie)).status).toBe(400);
    expect((await rpc("admin/feedback/get", { id: "missing" }, adminCookie)).status).toBe(404);
  });
});

describe("对局记录查询", () => {
  test("列表与详情透传仓储，过期记录返回 404", async () => {
    const record: StoredGameRecord = {
      id: "rec-1",
      game: "song",
      roomId: "ABCD",
      roundNumber: 3,
      startedAt: new Date("2026-10-01T00:00:00Z"),
      endedAt: new Date("2026-10-01T00:01:00Z"),
      players: [{ playerId: "p1", userId: null, name: "游客", score: 2 }],
      summary: { correct: true },
      timeline: [{ at: 1, type: "guess" }],
    };
    const filters: unknown[] = [];
    const gameRecords: GameRecordRepository = {
      insert: async () => {},
      purge: async () => 0,
      list: async (filter) => {
        filters.push(filter);
        return { items: [record], total: 1 };
      },
      get: async (id) => (id === record.id ? record : null),
      dailyCounts: async () => [],
    };
    const { rpc, adminCookie } = await setup({ gameRecords });

    const listed = await rpc("admin/games/list", { game: "song", roomId: "ABCD" }, adminCookie);
    expect(listed.body).toMatchObject({ total: 1, items: [{ id: "rec-1", startedAt: "2026-10-01T00:00:00.000Z" }] });
    expect(filters[0]).toMatchObject({ game: "song", roomId: "ABCD", limit: 20, offset: 0 });
    expect((await rpc("admin/games/get", { id: "rec-1" }, adminCookie)).body).toMatchObject({ summary: { correct: true } });
    expect((await rpc("admin/games/get", { id: "gone" }, adminCookie)).status).toBe(404);
    expect((await rpc("admin/games/list", { game: "chess" }, adminCookie)).status).toBe(400);
  });
});
