import { describe, expect, test } from "bun:test";

import {
  DatabaseSiteStatsRepository,
  type PageDelta,
  type VisitorDelta,
} from "../src/infrastructure/db/SiteStatsRepository";
import { createDrizzleStub, stamp, tupleOf } from "./DrizzleStub";

const T0 = Date.parse("2026-01-02T03:04:05.678Z");

const visitors = (count: number): VisitorDelta[] =>
  Array.from({ length: count }, (_, index) => ({
    day: "2026-01-02",
    visitorHash: `h${index}`,
    userId: index % 2 === 0 ? `u${index}` : null,
    views: index + 1,
  }));

const pages = (count: number): PageDelta[] =>
  Array.from({ length: count }, (_, index) => ({
    day: "2026-01-02",
    path: `/page-${index}`,
    views: index + 1,
  }));

describe("站点访问统计仓储（连接桩）", () => {
  test("访客与页面在同一事务里累加，浏览数按主键相加而不是覆盖", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseSiteStatsRepository(stub.database);

    await repository.addVisits(visitors(2), pages(1));

    const statements = stub.queries.map((query) => query.statement);
    expect(statements[0]).toBe("begin");
    expect(statements.at(-1)).toBe("commit");
    const visit = stub.queryAt(1);
    expect(visit.statement).toContain("insert into `site_visit_daily`");
    // 同一访客同一天多次刷写只加浏览数；账号以最近一次非空为准。
    expect(visit.statement).toContain(
      "on duplicate key update `user_id` = coalesce(values(`user_id`), `site_visit_daily`.`user_id`), `views` = `site_visit_daily`.`views` + values(`views`)"
    );
    expect(visit.params).toEqual(["2026-01-02", "h0", "u0", 1, "2026-01-02", "h1", null, 2]);

    const page = stub.queryAt(2);
    expect(page.statement).toContain("insert into `site_page_daily`");
    expect(page.statement).toContain(
      "on duplicate key update `views` = `site_page_daily`.`views` + values(`views`)"
    );
    expect(page.params).toEqual(["2026-01-02", "/page-0", 1]);
  });

  test("空批次不开事务写空语句，超大批次按 500 行分片", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseSiteStatsRepository(stub.database);

    await repository.addVisits([], []);
    expect(stub.queries).toHaveLength(2);
    expect(stub.queryAt(0).statement).toBe("begin");
    expect(stub.queryAt(1).statement).toBe("commit");

    stub.reset();
    await repository.addVisits(visitors(501), pages(500));
    // 两条访客插入 + 一条页面插入，夹在 begin / commit 之间。
    expect(stub.queries).toHaveLength(5);
    expect(stub.queryAt(1).params).toHaveLength(500 * 4);
    expect(stub.queryAt(2).params).toHaveLength(1 * 4);
  });

  test("清理按天分组删除，只动早于阈值的访客行并返回条数", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseSiteStatsRepository(stub.database);
    stub.reply([
      tupleOf("2025-12-30", "h1"),
      tupleOf("2025-12-31", "h2"),
      tupleOf("2025-12-31", "h3"),
    ]);

    expect(await repository.purgeVisitors("2026-01-01", 100)).toBe(3);
    const probe = stub.queryAt(0);
    expect(probe.statement).toContain("where `site_visit_daily`.`day` < ?");
    expect(probe.params).toEqual(["2026-01-01", 100]);

    // 复合主键按天分组，避免拼超长 OR 条件。
    expect(stub.queries).toHaveLength(3);
    expect(stub.queryAt(1).params).toEqual(["2025-12-30", "h1"]);
    expect(stub.queryAt(2).params).toEqual(["2025-12-31", "h2", "h3"]);
    expect(stub.queryAt(2).statement).toContain("`site_visit_daily`.`visitor_hash` in (?, ?)");
  });

  test("没有到期数据时不发出删除语句", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseSiteStatsRepository(stub.database);
    stub.reply([]);

    expect(await repository.purgeVisitors("2026-01-01", 100)).toBe(0);
    expect(stub.queries).toHaveLength(1);
  });

  test("日格把驱动的字符串计数转成数字", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseSiteStatsRepository(stub.database);
    stub.reply([tupleOf("2026-01-02", "12", "5", "88")]);

    expect(await repository.daily("2026-01-01")).toEqual([
      { day: "2026-01-02", visitors: 12, signedInVisitors: 5, views: 88 },
    ]);
    const query = stub.queryAt(0);
    expect(query.statement).toContain("group by `site_visit_daily`.`day`");
    expect(query.params).toEqual(["2026-01-01"]);
  });

  test("页面排行按浏览量倒序取前 N", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseSiteStatsRepository(stub.database);
    stub.reply([tupleOf("/songuessr", "40"), tupleOf("/", "12")]);

    expect(await repository.pages("2026-01-01", 2)).toEqual([
      { path: "/songuessr", views: 40 },
      { path: "/", views: 12 },
    ]);
    const query = stub.queryAt(0);
    expect(query.statement).toContain("group by `site_page_daily`.`path`");
    expect(query.statement).toContain("order by sum(`site_page_daily`.`views`) desc");
    expect(query.params).toEqual(["2026-01-01", 2]);
  });

  test("新注册按北京时间切日并以别名分组，避开严格 only_full_group_by", async () => {
    const stub = createDrizzleStub();
    const repository = new DatabaseSiteStatsRepository(stub.database);
    stub.reply([tupleOf("2026-01-02", "3")]);

    expect(await repository.newUsers(new Date(T0))).toEqual([{ day: "2026-01-02", count: 3 }]);
    const query = stub.queryAt(0);
    // SELECT 里 Drizzle 会省略表名，GROUP BY 必须跟着用别名，否则严格 only_full_group_by 报错。
    expect(query.statement).toContain(
      "select date_format(date_add(`created_at`, interval 8 hour), '%Y-%m-%d') as `day`, count(*) from `user`"
    );
    expect(query.statement).toContain("group by day order by day");
    expect(query.params).toEqual([stamp(T0)]);
  });

  test("迁移未就绪时统计写入整体失败", async () => {
    const stub = createDrizzleStub({ ready: Promise.reject(new Error("db down")) });
    const repository = new DatabaseSiteStatsRepository(stub.database);

    await expect(repository.daily("2026-01-01")).rejects.toThrow("db down");
    expect(stub.queries).toHaveLength(0);
  });
});
