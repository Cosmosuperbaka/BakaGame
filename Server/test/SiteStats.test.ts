import { describe, expect, test } from "bun:test";

import {
  beijingDay,
  normalizeVisitPath,
  SiteStatsService,
} from "../src/application/SiteStatsService";
import { EventLogger } from "../src/infrastructure/EventLogger";
import { deriveSentryApiConfig, SentryApiClient } from "../src/infrastructure/SentryApi";
import {
  ACCOUNT_TEST_SECRET,
  createAccountTestApp,
  MemorySiteStatsRepository,
} from "./AccountFixtures";
import { requestUrlText } from "./RequestFixtures";

const VISITOR = "visitor-0123456789abcdef";

describe("站点访问统计", () => {
  test("路径只按板块折叠，房号与未知路径不落库", () => {
    expect(normalizeVisitPath("/")).toBe("/");
    expect(normalizeVisitPath("/WhoIsFaker?ref=x")).toBe("/whoisfaker");
    expect(normalizeVisitPath("/songuessr/room/4821")).toBe("/songuessr/room");
    expect(normalizeVisitPath("/songuessr/solo")).toBe("/songuessr/solo");
    expect(normalizeVisitPath("/cee/room/1234#chat")).toBe("/cee/room");
    expect(normalizeVisitPath("/admin/users/abc")).toBe("/admin");
    expect(normalizeVisitPath("/wp-login.php")).toBe("other");
  });

  test("同一访客同日累加浏览，跨天摘要不同且不含原始 ID", async () => {
    let clock = Date.parse("2026-10-20T15:30:00Z"); // 北京时间 10-20 23:30
    const repository = new MemorySiteStatsRepository();
    const visits = new SiteStatsService({
      repository,
      secret: ACCOUNT_TEST_SECRET,
      logger: new EventLogger(() => {}),
      now: () => clock,
    });

    visits.record({ visitorId: VISITOR, path: "/", userId: null });
    visits.record({ visitorId: VISITOR, path: "/cee/room/1234", userId: "user-1" });
    await visits.flush();
    visits.record({ visitorId: VISITOR, path: "/", userId: null });
    await visits.flush();
    clock += 60 * 60 * 1000; // 跨过北京时间零点
    visits.record({ visitorId: VISITOR, path: "/", userId: null });
    await visits.flush();

    const rows = [...repository.visitors.values()];
    expect(rows.map((row) => [row.day, row.views, row.userId])).toEqual([
      ["2026-10-20", 3, "user-1"],
      ["2026-10-21", 1, null],
    ]);
    expect(rows[0]!.visitorHash).not.toBe(rows[1]!.visitorHash);
    expect(rows.some((row) => row.visitorHash.includes(VISITOR))).toBe(false);
    expect(await repository.pages("2026-10-20", 10)).toEqual([
      { path: "/", views: 3 },
      { path: "/cee/room", views: 1 },
    ]);
  });

  test("写库失败丢弃本窗口，之后照常统计；过期访客行被清理", async () => {
    let clock = Date.parse("2026-10-20T04:00:00Z");
    const repository = new MemorySiteStatsRepository();
    const visits = new SiteStatsService({
      repository,
      secret: ACCOUNT_TEST_SECRET,
      logger: new EventLogger(() => {}),
      now: () => clock,
    });
    repository.failNext = true;
    visits.record({ visitorId: VISITOR, path: "/", userId: null });
    await visits.flush();
    expect(repository.visitors.size).toBe(0);
    visits.record({ visitorId: VISITOR, path: "/", userId: null });
    await visits.close();
    expect(repository.visitors.size).toBe(1);

    clock += 91 * 24 * 60 * 60 * 1000;
    expect(await visits.purge()).toBe(1);
    expect(repository.visitors.size).toBe(0);
    expect(repository.pageRows.size).toBe(1);
  });

  test("上报接口游客可用、登录后关联账号，非法访客 ID 被拒", async () => {
    const { rpc, signIn, visits, siteStats } = createAccountTestApp();
    const { cookie } = await signIn("10001", "Alice");
    expect((await rpc("site/visit", { visitorId: VISITOR, path: "/" })).body).toEqual({ ok: true });
    expect(
      (
        await rpc(
          "site/visit",
          { visitorId: "visitor-fedcba9876543210", path: "/whoisfaker" },
          cookie
        )
      ).status
    ).toBe(200);
    expect((await rpc("site/visit", { visitorId: "short", path: "/" })).status).toBe(400);
    await visits.flush();
    expect([...siteStats.visitors.values()].map((row) => Boolean(row.userId)).sort()).toEqual([
      false,
      true,
    ]);
  });
});

describe("后台概览", () => {
  test("汇总账号、反馈、实时房间与按日访问，缺日补零", async () => {
    const clock = Date.parse("2026-10-20T04:00:00Z");
    const ctx = createAccountTestApp({ adminQqNumbers: ["90001"], now: () => clock });
    const admin = await ctx.signIn("90001", "管理员");
    const alice = await ctx.signIn("10001", "Alice");
    await ctx.rpc("feedback/create", { kind: "bug", title: "t", content: "c" }, alice.cookie);
    await ctx.rpc("site/visit", { visitorId: VISITOR, path: "/cee" });
    await ctx.visits.flush();

    expect((await ctx.rpc("admin/stats/overview", { days: 3 }, alice.cookie)).status).toBe(403);
    const overview = await ctx.rpc("admin/stats/overview", { days: 3 }, admin.cookie);
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({
      // Better Auth 以真实时间写 createdAt，固定时钟下「今日新增」不可断言，由 TiDB 冒烟覆盖。
      users: { total: 2, admins: 1, banned: 0 },
      feedback: { open: 1, processing: 0, resolved: 0, closed: 0 },
      live: { faker: { rooms: 0, onlinePlayers: 0 } },
      pages: [{ path: "/cee", views: 1 }],
    });
    const daily = overview.body.daily as Array<{
      day: string;
      visitors: number;
      games: Record<string, number>;
    }>;
    expect(daily.map((row) => [row.day, row.visitors])).toEqual([
      ["2026-10-18", 0],
      ["2026-10-19", 0],
      [beijingDay(clock), 1],
    ]);
    expect(daily.at(-1)!.games).toEqual({ faker: 0, song: 0, cee: 0 });
    expect((await ctx.rpc("admin/stats/overview", { days: 91 }, admin.cookie)).status).toBe(400);

    expect((await ctx.rpc("admin/stats/sentry", undefined, admin.cookie)).body).toMatchObject({
      configured: false,
    });
  });
});

describe("Sentry 概览", () => {
  test("从 DSN 推出组织与区域，自建 DSN 报配置错误", () => {
    expect(
      deriveSentryApiConfig("https://key@o123.ingest.us.sentry.io/456", ["456", "789"], "tok")
    ).toEqual({
      baseUrl: "https://us.sentry.io",
      organizationId: "123",
      projectIds: ["456", "789"],
      token: "tok",
    });
    expect(
      deriveSentryApiConfig("https://key@o123.ingest.sentry.io/456", ["456"], "tok").baseUrl
    ).toBe("https://sentry.io");
    expect(() => deriveSentryApiConfig("https://key@sentry.example.com/1", ["1"], "tok")).toThrow(
      expect.objectContaining({ code: "CONFIG_ERROR" })
    );
  });

  test("三个查询各自容错、带令牌与项目参数，结果缓存 60 秒", async () => {
    let clock = 0;
    const calls: URL[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(requestUrlText(input));
      calls.push(url);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
      if (url.pathname.endsWith("/issues/")) {
        return Response.json(
          [
            {
              id: "1",
              shortId: "WEB-1",
              title: "TypeError",
              culprit: "app.js",
              level: "error",
              count: "12",
              userCount: 3,
              lastSeen: "2026-10-20T00:00:00Z",
              permalink: "https://sentry.io/i/1",
              project: { slug: "web" },
            },
          ],
          { headers: { "x-hits": "42" } }
        );
      }
      if (url.searchParams.get("dataset") === "errors")
        return Response.json({ data: [{ "count()": 17 }] });
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch;
    const client = new SentryApiClient(
      deriveSentryApiConfig("https://key@o123.ingest.us.sentry.io/456", ["456", "789"], "tok"),
      new EventLogger(() => {}),
      fetcher,
      () => clock
    );

    const overview = await client.overview();
    expect(overview).toMatchObject({
      configured: true,
      errors24h: 17,
      unresolvedIssues: 42,
      transactions: null,
      warnings: ["性能：HTTP 403"],
      issues: [{ shortId: "WEB-1", count: 12, project: "web" }],
    });
    expect(JSON.stringify(overview)).not.toContain("tok");
    expect(
      calls.every(
        (url) =>
          url.origin === "https://us.sentry.io" &&
          url.pathname.startsWith("/api/0/organizations/123/")
      )
    ).toBe(true);
    expect(calls.every((url) => url.searchParams.getAll("project").join() === "456,789")).toBe(
      true
    );
    expect(
      calls.find((url) => url.searchParams.get("dataset") === "spans")!.searchParams.getAll("field")
    ).toContain("p75(span.duration)");

    await client.overview();
    expect(calls).toHaveLength(3);
    clock += 61_000;
    await client.overview();
    expect(calls).toHaveLength(6);
  });
});
