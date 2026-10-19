import { describe, expect, test } from "bun:test";

import type { InMemoryAntiCheatReviewQueue } from "../src/application/CEEAntiCheatSignals";
import type {
  GameRecordRepository,
  StoredGameRecordDetail,
} from "../src/infrastructure/db/GameRecordRepository";
import { createAccountTestApp } from "./AccountFixtures";
import { createConnection, execute, getLastEventPayload } from "./Helpers";

const ADMIN_QQ = "90001";

/** 管理员 + 两个普通用户，返回各自 Cookie 与用户 ID。 */
const setup = async (options: Parameters<typeof createAccountTestApp>[0] = {}) => {
  const ctx = createAccountTestApp({ adminQqNumbers: [ADMIN_QQ], ...options });
  const admin = await ctx.signIn(ADMIN_QQ, "管理员");
  const alice = await ctx.signIn("10001", "Alice");
  const bob = await ctx.signIn("20002", "Bob");
  const idOf = (qq: string) =>
    (ctx.db.user as Array<{ id: string; email: string }>).find(
      (user) => user.email === `${qq}@qq.com`
    )!.id;
  return {
    ...ctx,
    adminCookie: admin.cookie,
    alice,
    bob,
    adminId: idOf(ADMIN_QQ),
    aliceId: idOf("10001"),
    bobId: idOf("20002"),
  };
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
    expect(
      (await rpc("admin/users/setRole", { userId: aliceId, role: "admin" }, adminCookie)).body
    ).toMatchObject({ role: "admin" });
    expect((await rpc("admin/users/get", { userId: bobId }, alice.cookie)).status).toBe(200);
    expect(
      (await rpc("admin/users/setRole", { userId: aliceId, role: "user" }, adminCookie)).status
    ).toBe(200);
    expect((await rpc("admin/users/get", { userId: bobId }, alice.cookie)).status).toBe(403);
  });
});

describe("用户管理", () => {
  test("纯数字按 QQ 号前缀搜索，其余按昵称包含", async () => {
    const { rpc, adminCookie } = await setup();
    const byQq = await rpc("admin/users/list", { query: "100" }, adminCookie);
    expect((byQq.body.items as Array<{ name: string }>).map((user) => user.name)).toEqual([
      "Alice",
    ]);
    const byName = await rpc("admin/users/list", { query: "ob" }, adminCookie);
    expect((byName.body.items as Array<{ qqNumber: string }>).map((user) => user.qqNumber)).toEqual(
      ["20002"]
    );
    const admins = await rpc("admin/users/list", { role: "admin" }, adminCookie);
    expect(admins.body.total).toBe(1);
  });

  test("封禁踢下线、拦截发码与登录，解封后恢复", async () => {
    let clock = Date.now();
    const { rpc, adminCookie, alice, aliceId, mailer, signIn } = await setup({ now: () => clock });
    const sentBefore = mailer.sent.length;
    clock += 61_000; // 越过重发间隔，确保拦下发码的是封禁而非限流

    const banned = await rpc(
      "admin/users/ban",
      { userId: aliceId, reason: "刷屏", expiresInHours: 24 },
      adminCookie
    );
    expect(banned.status).toBe(200);
    expect(banned.body).toMatchObject({ banned: true, banReason: "刷屏" });
    expect(banned.body.banExpires).toEqual(expect.any(String));

    expect((await rpc("settings/get", undefined, alice.cookie)).status).toBe(401);
    const code = await rpc("account/requestLoginCode", { qqNumber: "10001" });
    expect(code.status).toBe(403);
    expect(code.body.message).toBe("账号已被封禁");
    expect(mailer.sent.length).toBe(sentBefore);

    expect((await rpc("admin/users/list", { banned: true }, adminCookie)).body.total).toBe(1);

    expect((await rpc("admin/users/unban", { userId: aliceId }, adminCookie)).body).toMatchObject({
      banned: false,
      banReason: null,
    });
    clock += 61_000;
    const again = await signIn("10001");
    expect(again.response.status).toBe(200);
    expect((await rpc("account/me", undefined, again.cookie)).body).toMatchObject({
      name: "Alice",
    });
  });

  test("限时封禁到期后可以重新获取验证码", async () => {
    let clock = Date.now();
    const { rpc, adminCookie, aliceId } = await setup({ now: () => clock });
    await rpc(
      "admin/users/ban",
      { userId: aliceId, reason: "冷静一下", expiresInHours: 1 },
      adminCookie
    );
    clock += 61_000;
    expect((await rpc("account/requestLoginCode", { qqNumber: "10001" })).status).toBe(403);
    clock += 2 * 3_600_000;
    expect((await rpc("account/requestLoginCode", { qqNumber: "10001" })).body).toMatchObject({
      registered: true,
    });
  });

  test("不能处置自己或其他管理员，被封用户不能直接提为管理员", async () => {
    const { rpc, adminCookie, adminId, aliceId, bobId } = await setup();
    expect(
      (await rpc("admin/users/ban", { userId: adminId, reason: "x" }, adminCookie)).body.code
    ).toBe("CANNOT_TARGET_SELF");
    expect(
      (await rpc("admin/users/setRole", { userId: adminId, role: "user" }, adminCookie)).body.code
    ).toBe("CANNOT_TARGET_SELF");

    await rpc("admin/users/setRole", { userId: aliceId, role: "admin" }, adminCookie);
    expect(
      (await rpc("admin/users/ban", { userId: aliceId, reason: "x" }, adminCookie)).body.code
    ).toBe("CANNOT_TARGET_ADMIN");

    await rpc("admin/users/ban", { userId: bobId, reason: "x" }, adminCookie);
    expect(
      (await rpc("admin/users/setRole", { userId: bobId, role: "admin" }, adminCookie)).body.code
    ).toBe("USER_BANNED");
    expect((await rpc("admin/users/get", { userId: "missing" }, adminCookie)).status).toBe(404);
  });

  test("强制下线并留下审计", async () => {
    const { rpc, adminCookie, adminId, bob, bobId, audit } = await setup();
    expect((await rpc("admin/users/revokeSessions", { userId: bobId }, adminCookie)).body).toEqual({
      ok: true,
    });
    expect((await rpc("settings/get", undefined, bob.cookie)).status).toBe(401);

    expect(audit.entries.map((entry) => [entry.actorId, entry.action, entry.targetId])).toEqual([
      [adminId, "user.revokeSessions", bobId],
    ]);

    const listed = await rpc("admin/audit/list", { action: "user.revokeSessions" }, adminCookie);
    expect(listed.body.total).toBe(1);
    expect((listed.body.items as Array<{ actor: { name: string } }>)[0]!.actor.name).toBe("管理员");
  });

  test("审计写入失败时操作不执行", async () => {
    const { rpc, adminCookie, bob, bobId, audit } = await setup();
    audit.failNext = true;
    expect((await rpc("admin/users/ban", { userId: bobId, reason: "x" }, adminCookie)).status).toBe(
      500
    );
    expect((await rpc("settings/get", undefined, bob.cookie)).status).toBe(200);
    expect((await rpc("admin/users/get", { userId: bobId }, adminCookie)).body).toMatchObject({
      banned: false,
    });
  });
});

describe("反馈管理", () => {
  test("回复让用户看到未读，待处理自动转处理中", async () => {
    const { rpc, adminCookie, alice } = await setup();
    const created = await rpc(
      "feedback/create",
      { kind: "suggestion", title: "加个夜间模式", content: "晚上太亮" },
      alice.cookie
    );
    const id = created.body.id as string;

    const listed = await rpc("admin/feedback/list", { status: "open" }, adminCookie);
    expect(listed.body.total).toBe(1);
    expect((listed.body.items as Array<{ user: { name: string } }>)[0]!.user.name).toBe("Alice");

    const replied = await rpc("admin/feedback/reply", { id, content: "排期中" }, adminCookie);
    expect(replied.body).toMatchObject({ status: "processing", content: "晚上太亮" });
    expect(
      (replied.body.replies as Array<{ content: string; author: { name: string } }>)[0]
    ).toMatchObject({
      content: "排期中",
      author: { name: "管理员" },
    });

    const mine = await rpc("feedback/listMine", undefined, alice.cookie);
    expect(mine.body.unread).toBe(1);
    const detail = await rpc("feedback/get", { id }, alice.cookie);
    expect(
      (detail.body.replies as Array<{ content: string }>).map((reply) => reply.content)
    ).toEqual(["排期中"]);
    expect((await rpc("feedback/listMine", undefined, alice.cookie)).body.unread).toBe(0);

    expect(
      (await rpc("admin/feedback/setStatus", { id, status: "resolved" }, adminCookie)).body
    ).toMatchObject({ status: "resolved" });
    expect((await rpc("admin/feedback/list", { status: "resolved" }, adminCookie)).body.total).toBe(
      1
    );
    expect((await rpc("admin/feedback/reply", { id, content: "  " }, adminCookie)).status).toBe(
      400
    );
    expect((await rpc("admin/feedback/get", { id: "missing" }, adminCookie)).status).toBe(404);
  });
});

describe("实时房间管理", () => {
  test("跨游戏列出房间，关房与移人先审计再交给游戏服务", async () => {
    const { rpc, adminCookie, adminId, audit, whoIsFakerService } = await setup();
    const host = createConnection(whoIsFakerService, "faker-host");
    const guest = createConnection(whoIsFakerService, "faker-guest");
    await execute(whoIsFakerService, host, {
      id: "c",
      type: "room.create",
      payload: {
        roomId: "5678",
        name: "后台测试房",
        userName: "房主",
        visibility: "public",
        allowSpectators: true,
      },
    });
    await execute(whoIsFakerService, guest, {
      id: "j",
      type: "room.join",
      roomId: "5678",
      payload: { userName: "路人" },
    });

    const listed = await rpc("admin/rooms/list", {}, adminCookie);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject([
      { game: "faker", roomId: "5678", name: "后台测试房", createdAt: expect.any(String) },
    ]);
    expect((await rpc("admin/rooms/list", { game: "song" }, adminCookie)).body as unknown).toEqual(
      []
    );

    const guestId = guest.record.playerId!;
    expect(
      (
        await rpc(
          "admin/rooms/kick",
          { game: "faker", roomId: "5678", playerId: guestId },
          adminCookie
        )
      ).body
    ).toEqual({ ok: true });
    expect(getLastEventPayload<{ reason: string }>(guest, "room.closed")).toMatchObject({
      reason: "kicked",
    });
    expect(
      (
        await rpc(
          "admin/rooms/kick",
          { game: "faker", roomId: "5678", playerId: guestId },
          adminCookie
        )
      ).status
    ).toBe(404);

    audit.failNext = true;
    expect(
      (await rpc("admin/rooms/close", { game: "faker", roomId: "5678" }, adminCookie)).status
    ).toBe(500);
    expect(whoIsFakerService.adminListRooms()).toHaveLength(1);

    expect(
      (await rpc("admin/rooms/close", { game: "faker", roomId: "5678" }, adminCookie)).body
    ).toEqual({ ok: true });
    expect(getLastEventPayload<{ reason: string }>(host, "room.closed")).toMatchObject({
      reason: "admin_closed",
    });
    expect(
      (await rpc("admin/rooms/close", { game: "faker", roomId: "5678" }, adminCookie)).status
    ).toBe(404);
    expect(
      (await rpc("admin/rooms/close", { game: "song", roomId: "5678" }, adminCookie)).status
    ).toBe(404);

    expect(audit.entries.map((entry) => [entry.actorId, entry.action, entry.targetId])).toEqual([
      [adminId, "room.kick", "faker:5678"],
      [adminId, "room.close", "faker:5678"],
    ]);
    expect(audit.entries[1]!.detail).toEqual({
      name: "后台测试房",
      phase: "waiting",
      players: ["房主"],
    });
  });
});

describe("反作弊人工复核队列", () => {
  const recordedAt = Date.parse("2026-10-18T10:05:00Z");
  const seed = (
    reviews: InMemoryAntiCheatReviewQueue,
    playerName: string,
    userId: string | null,
    at = recordedAt
  ) =>
    reviews.add({
      roomId: "ABCD",
      roomCreatedAt: recordedAt - 60_000,
      roundNumber: 3,
      playerId: "p1",
      playerName,
      userId,
      clientType: "mobile",
      recordedAt: at,
      score: 4,
      reasons: ["interval_too_uniform", "no_search_guess"],
      features: {
        intervals: [800, 790, 810],
        cv: 0.012,
        noSearchGuesses: 3,
        unmatchedSearches: 0,
        guesses: 4,
        firstGuessCorrect: true,
      },
    });

  test("列表补出账号信息，处置状态只有人能改并先留审计", async () => {
    const { rpc, adminCookie, adminId, alice, aliceId, audit, antiCheatReviews } = await setup();
    seed(antiCheatReviews, "Alice", aliceId);
    seed(antiCheatReviews, "游客", null);

    expect((await rpc("admin/antiCheat/list", {})).status).toBe(401);
    expect((await rpc("admin/antiCheat/list", {}, alice.cookie)).status).toBe(403);

    const listed = await rpc("admin/antiCheat/list", { status: "open" }, adminCookie);
    expect(listed.body.total).toBe(2);
    const items = listed.body.items as Array<Record<string, unknown>>;
    expect(items[1]).toMatchObject({
      playerName: "Alice",
      player: { id: aliceId, name: "Alice" },
      clientType: "mobile",
      score: 4,
      reasons: ["interval_too_uniform", "no_search_guess"],
      features: { guesses: 4, firstGuessCorrect: true },
      status: "open",
      createdAt: "2026-10-18T10:05:00.000Z",
    });
    expect(items[0]!.player).toBeNull();

    expect(
      (await rpc("admin/antiCheat/list", { since: recordedAt + 1 }, adminCookie)).body.total
    ).toBe(0);

    const id = items[0]!.id as string;
    expect(
      (await rpc("admin/antiCheat/setStatus", { id, status: "cleared" }, alice.cookie)).status
    ).toBe(403);
    expect(
      (await rpc("admin/antiCheat/setStatus", { id, status: "cleared" }, adminCookie)).body
    ).toEqual({ ok: true });
    expect(antiCheatReviews.reviews.find((item) => item.id === id)?.status).toBe("cleared");
    expect((await rpc("admin/antiCheat/list", { status: "cleared" }, adminCookie)).body.total).toBe(
      1
    );
    expect((await rpc("admin/antiCheat/list", { status: "open" }, adminCookie)).body.total).toBe(1);

    expect(
      (await rpc("admin/antiCheat/setStatus", { id: "missing", status: "actioned" }, adminCookie))
        .status
    ).toBe(404);
    expect(
      (await rpc("admin/antiCheat/setStatus", { id, status: "fixed" }, adminCookie)).status
    ).toBe(400);

    expect(
      audit.entries.map((entry) => [
        entry.actorId,
        entry.action,
        entry.targetType,
        entry.targetId,
        entry.detail,
      ])
    ).toEqual([[adminId, "antiCheat.setStatus", "antiCheatReview", id, { to: "cleared" }]]);
  });

  test("审计写入失败时处置不落库", async () => {
    const { rpc, adminCookie, audit, antiCheatReviews } = await setup();
    seed(antiCheatReviews, "Alice", null);
    const id = antiCheatReviews.reviews[0]!.id;
    audit.failNext = true;
    expect(
      (await rpc("admin/antiCheat/setStatus", { id, status: "actioned" }, adminCookie)).status
    ).toBe(500);
    expect(antiCheatReviews.reviews[0]!.status).toBe("open");
  });

  test("跨局展开只回同身份近窗均值：读一次不产生任何处置", async () => {
    const { rpc, adminCookie, aliceId, alice, audit, antiCheatReviews } = await setup();
    const now = Date.now();
    seed(antiCheatReviews, "Alice", aliceId, now - 60_000);
    seed(antiCheatReviews, "Alice", aliceId, now - 3_600_000);
    // 窗口外的旧条目：一个月的行为不该替今天说话。
    seed(antiCheatReviews, "Alice", aliceId, now - 40 * 86_400_000);
    // 同昵称但没登录，与上面的登录账号不是同一个人。
    seed(antiCheatReviews, "Alice", null, now - 60_000);
    seed(antiCheatReviews, "游客", null, now - 60_000);

    const items = antiCheatReviews.reviews;
    const aliceItem = items.find(
      (item) => item.userId === aliceId && item.recordedAt === now - 60_000
    )!;
    const guestAliceItem = items.find(
      (item) => item.userId === null && item.playerName === "Alice"
    )!;
    const touristItem = items.find((item) => item.playerName === "游客")!;

    expect((await rpc("admin/antiCheat/history", { id: aliceItem.id })).status).toBe(401);
    expect((await rpc("admin/antiCheat/history", { id: aliceItem.id }, alice.cookie)).status).toBe(
      403
    );
    expect((await rpc("admin/antiCheat/history", {}, adminCookie)).status).toBe(400);

    const history = await rpc("admin/antiCheat/history", { id: aliceItem.id }, adminCookie);
    expect(history.status).toBe(200);
    expect(history.body).toEqual({
      windowDays: 30,
      rounds: 2,
      avgGuesses: 4,
      firstGuessHits: 2,
      avgCv: 0.012,
      maxScore: 4,
    });
    // 游客条目只与自己并列，不并进同昵称的登录账号。
    expect(
      (await rpc("admin/antiCheat/history", { id: guestAliceItem.id }, adminCookie)).body
    ).toMatchObject({ rounds: 1 });
    expect(
      (await rpc("admin/antiCheat/history", { id: touristItem.id }, adminCookie)).body
    ).toMatchObject({ rounds: 1 });
    // 未知 id 不是错误：队列里查不到身份，就是「窗口内没有可比条目」。
    expect(
      (await rpc("admin/antiCheat/history", { id: "missing" }, adminCookie)).body
    ).toMatchObject({ rounds: 0 });

    expect(audit.entries).toEqual([]);
  });
});

describe("对局记录查询", () => {
  test("列表与详情透传仓储，缺失记录返回 404", async () => {
    const record: StoredGameRecordDetail = {
      id: "rec-1",
      game: "song",
      roomId: "ABCD",
      roundCount: 3,
      startedAt: new Date("2026-10-01T00:00:00Z"),
      endedAt: new Date("2026-10-01T00:01:00Z"),
      players: [{ playerId: "p1", userId: null, name: "游客", score: 2 }],
      rounds: [
        {
          number: 1,
          startedAt: new Date("2026-10-01T00:00:10Z"),
          endedAt: new Date("2026-10-01T00:00:40Z"),
          players: [{ playerId: "p1", userId: null, name: "游客", score: 2 }],
          summary: { correct: true },
          timeline: [{ at: 1, type: "guess" }],
        },
      ],
    };
    const filters: unknown[] = [];
    const gameRecords: GameRecordRepository = {
      save: async () => {},
      list: async (filter) => {
        filters.push(filter);
        return { items: [record], total: 1 };
      },
      get: async (id) => (id === record.id ? record : null),
      dailyCounts: async () => [],
    };
    const { rpc, adminCookie } = await setup({ gameRecords });

    const listed = await rpc("admin/games/list", { game: "song", roomId: "ABCD" }, adminCookie);
    expect(listed.body).toMatchObject({
      total: 1,
      items: [{ id: "rec-1", startedAt: "2026-10-01T00:00:00.000Z" }],
    });
    expect(filters[0]).toMatchObject({ game: "song", roomId: "ABCD", limit: 20, offset: 0 });
    expect((await rpc("admin/games/get", { id: "rec-1" }, adminCookie)).body).toMatchObject({
      roundCount: 3,
      rounds: [{ number: 1, summary: { correct: true } }],
      timeline: [{ at: 1, type: "guess", round: 1 }],
    });
    expect((await rpc("admin/games/get", { id: "gone" }, adminCookie)).status).toBe(404);
    expect((await rpc("admin/games/list", { game: "chess" }, adminCookie)).status).toBe(400);
  });
});
