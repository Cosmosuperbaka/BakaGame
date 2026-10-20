import { and, asc, eq, inArray } from "drizzle-orm";

import { BADGE_CATALOG, type BadgeKind } from "../../shared/Badges";
import type { Database } from "./Database";
import { badge, userBadge } from "./Schema";

/**
 * 账号徽章的读写口。徽章目录由 `ensureCatalog` 在启动时按共享常量补齐，
 * 授予关系只经管理员接口写入；房间与对局快照不读这里。
 */
export interface BadgeRepository {
  ensureCatalog(): Promise<void>;
  badgesOf(userId: string): Promise<BadgeKind[]>;
  badgesOfMany(userIds: readonly string[]): Promise<Map<string, BadgeKind[]>>;
  grant(userId: string, badgeId: BadgeKind, grantedBy: string, now: Date): Promise<void>;
  revoke(userId: string, badgeId: BadgeKind): Promise<void>;
}

export class DatabaseBadgeRepository implements BadgeRepository {
  constructor(private readonly database: Database) {}

  async ensureCatalog(): Promise<void> {
    await this.database.ready;
    for (const entry of BADGE_CATALOG) {
      await this.database.db
        .insert(badge)
        .values(entry)
        .onDuplicateKeyUpdate({
          set: { label: entry.label, description: entry.description, sortOrder: entry.sortOrder },
        });
    }
  }

  async badgesOf(userId: string): Promise<BadgeKind[]> {
    return (await this.badgesOfMany([userId])).get(userId) ?? [];
  }

  async badgesOfMany(userIds: readonly string[]): Promise<Map<string, BadgeKind[]>> {
    const unique = [...new Set(userIds)];
    if (!unique.length) return new Map();
    await this.database.ready;
    const rows = await this.database.db
      .select({ userId: userBadge.userId, badgeId: userBadge.badgeId })
      .from(userBadge)
      .innerJoin(badge, eq(userBadge.badgeId, badge.id))
      .where(inArray(userBadge.userId, unique))
      .orderBy(asc(badge.sortOrder));
    const grouped = new Map<string, BadgeKind[]>();
    for (const row of rows) {
      const list = grouped.get(row.userId) ?? [];
      list.push(row.badgeId as BadgeKind);
      grouped.set(row.userId, list);
    }
    return grouped;
  }

  async grant(
    userId: string,
    badgeId: BadgeKind,
    grantedBy: string,
    now: Date
  ): Promise<void> {
    await this.database.ready;
    await this.database.db
      .insert(userBadge)
      .values({ userId, badgeId, grantedBy, grantedAt: now })
      .onDuplicateKeyUpdate({ set: { grantedBy, grantedAt: now } });
  }

  async revoke(userId: string, badgeId: BadgeKind): Promise<void> {
    await this.database.ready;
    await this.database.db
      .delete(userBadge)
      .where(and(eq(userBadge.userId, userId), eq(userBadge.badgeId, badgeId)));
  }
}
