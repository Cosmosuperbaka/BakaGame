import { and, desc, gte, inArray, lt, sql } from "drizzle-orm";

import type { Database } from "./Database";
import { sitePageDaily, siteVisitDaily, user } from "./Schema";

/** 一次刷写里某访客当天的增量。 */
export interface VisitorDelta {
  day: string;
  visitorHash: string;
  userId: string | null;
  views: number;
}

export interface PageDelta {
  day: string;
  path: string;
  views: number;
}

export interface SiteDailyCount {
  day: string;
  visitors: number;
  signedInVisitors: number;
  views: number;
}

export interface SitePageCount {
  path: string;
  views: number;
}

export interface SiteStatsRepository {
  /** 按主键累加：同一访客同一天多次刷写只增加浏览数，账号以最近一次非空为准。 */
  addVisits(visitors: VisitorDelta[], pages: PageDelta[]): Promise<void>;
  /** 删除早于 `beforeDay`（北京时间自然日）的访客行，返回删除条数；页面汇总不含个人数据，长期保留。 */
  purgeVisitors(beforeDay: string, batch: number): Promise<number>;
  daily(sinceDay: string): Promise<SiteDailyCount[]>;
  pages(sinceDay: string, limit: number): Promise<SitePageCount[]>;
  /** 按北京时间自然日统计新注册账号。 */
  newUsers(since: Date): Promise<Array<{ day: string; count: number }>>;
}

const INSERT_CHUNK = 500;

const chunks = <T>(items: T[]): T[][] => {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += INSERT_CHUNK)
    result.push(items.slice(index, index + INSERT_CHUNK));
  return result;
};

/**
 * 单表查询时 Drizzle 在 SELECT 里省略表名、在 GROUP BY 里保留表名，开启严格
 * `only_full_group_by` 的库会把两者视为不同表达式而报错；因此按别名分组。
 */
const userBeijingDay =
  sql<string>`date_format(date_add(${user.createdAt}, interval 8 hour), '%Y-%m-%d')`.as("day");

export class DatabaseSiteStatsRepository implements SiteStatsRepository {
  constructor(private readonly database: Database) {}

  async addVisits(visitors: VisitorDelta[], pages: PageDelta[]): Promise<void> {
    await this.database.ready;
    await this.database.db.transaction(async (tx) => {
      for (const rows of chunks(visitors)) {
        await tx
          .insert(siteVisitDaily)
          .values(rows)
          .onDuplicateKeyUpdate({
            set: {
              views: sql`${siteVisitDaily.views} + values(${sql.raw("`views`")})`,
              userId: sql`coalesce(values(${sql.raw("`user_id`")}), ${siteVisitDaily.userId})`,
            },
          });
      }
      for (const rows of chunks(pages)) {
        await tx
          .insert(sitePageDaily)
          .values(rows)
          .onDuplicateKeyUpdate({
            set: { views: sql`${sitePageDaily.views} + values(${sql.raw("`views`")})` },
          });
      }
    });
  }

  async purgeVisitors(beforeDay: string, batch: number): Promise<number> {
    await this.database.ready;
    const rows = await this.database.db
      .select({ day: siteVisitDaily.day, visitorHash: siteVisitDaily.visitorHash })
      .from(siteVisitDaily)
      .where(lt(siteVisitDaily.day, beforeDay))
      .limit(batch);
    if (!rows.length) return 0;
    // 复合主键按天分组删除，避免拼超长 OR 条件。
    const byDay = new Map<string, string[]>();
    for (const row of rows) byDay.set(row.day, [...(byDay.get(row.day) ?? []), row.visitorHash]);
    for (const [day, hashes] of byDay) {
      await this.database.db
        .delete(siteVisitDaily)
        .where(
          and(sql`${siteVisitDaily.day} = ${day}`, inArray(siteVisitDaily.visitorHash, hashes))
        );
    }
    return rows.length;
  }

  async daily(sinceDay: string): Promise<SiteDailyCount[]> {
    await this.database.ready;
    const rows = await this.database.db
      .select({
        day: siteVisitDaily.day,
        visitors: sql<number>`count(*)`,
        signedInVisitors: sql<number>`count(${siteVisitDaily.userId})`,
        views: sql<number>`sum(${siteVisitDaily.views})`,
      })
      .from(siteVisitDaily)
      .where(gte(siteVisitDaily.day, sinceDay))
      .groupBy(siteVisitDaily.day)
      .orderBy(siteVisitDaily.day);
    return rows.map((row) => ({
      day: row.day,
      visitors: Number(row.visitors),
      signedInVisitors: Number(row.signedInVisitors),
      views: Number(row.views),
    }));
  }

  async pages(sinceDay: string, limit: number): Promise<SitePageCount[]> {
    await this.database.ready;
    const views = sql<number>`sum(${sitePageDaily.views})`;
    const rows = await this.database.db
      .select({ path: sitePageDaily.path, views })
      .from(sitePageDaily)
      .where(gte(sitePageDaily.day, sinceDay))
      .groupBy(sitePageDaily.path)
      .orderBy(desc(views))
      .limit(limit);
    return rows.map((row) => ({ path: row.path, views: Number(row.views) }));
  }

  async newUsers(since: Date): Promise<Array<{ day: string; count: number }>> {
    await this.database.ready;
    const rows = await this.database.db
      .select({ day: userBeijingDay, count: sql<number>`count(*)` })
      .from(user)
      .where(gte(user.createdAt, since))
      .groupBy(sql`day`)
      .orderBy(sql`day`);
    return rows.map((row) => ({ day: row.day, count: Number(row.count) }));
  }
}
