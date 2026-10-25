import { and, asc, eq, inArray, isNull, ne, notInArray } from "drizzle-orm";

import { BADGE_CATALOG, BADGE_KINDS, type AccountBadge, type BadgeKind } from "../../shared/Badges";
import type { Database } from "./Database";
import { badge, user, userBadge, userRegistration } from "./Schema";

/**
 * 账号徽章的读写口。目录由 `ensureCatalog` 幂等补齐并清理已下线类型；
 * 授予关系只经这里写入，房间与对局快照不读这里。
 */
export interface BadgeRepository {
  ensureCatalog(): Promise<void>;
  badgesOf(userId: string): Promise<AccountBadge[]>;
  badgesOfMany(userIds: readonly string[]): Promise<Map<string, AccountBadge[]>>;
  /** `grantedBy` 为空表示系统自动授予；没有佩戴徽章时顺带佩戴这一枚。 */
  grant(userId: string, badgeId: BadgeKind, grantedBy: string | null, now: Date): Promise<void>;
  revoke(userId: string, badgeId: BadgeKind): Promise<void>;
  /** 只保留指定账号的某类徽章；`keepUserId` 为空时清空该类徽章。 */
  resetExclusive(badgeId: BadgeKind, keepUserId: string | null): Promise<void>;
}

export class DatabaseBadgeRepository implements BadgeRepository {
  private catalog: Promise<void> | null = null;

  constructor(private readonly database: Database) {}

  ensureCatalog(): Promise<void> {
    this.catalog ??= this.syncCatalog().catch((error: unknown) => {
      this.catalog = null;
      throw error;
    });
    return this.catalog;
  }

  private async syncCatalog(): Promise<void> {
    await this.database.ready;
    for (const entry of BADGE_CATALOG) {
      await this.database.db
        .insert(badge)
        .values(entry)
        .onDuplicateKeyUpdate({
          set: { label: entry.label, description: entry.description, sortOrder: entry.sortOrder },
        });
    }
    // 已下线的旧类型连同授予关系一起清掉，避免客户端拿到不认识的徽章。
    await this.database.db.delete(badge).where(notInArray(badge.id, [...BADGE_KINDS]));
  }

  async badgesOf(userId: string): Promise<AccountBadge[]> {
    return (await this.badgesOfMany([userId])).get(userId) ?? [];
  }

  async badgesOfMany(userIds: readonly string[]): Promise<Map<string, AccountBadge[]>> {
    const unique = [...new Set(userIds)];
    if (!unique.length) return new Map();
    await this.database.ready;
    const rows = await this.database.db
      .select({
        userId: userBadge.userId,
        badgeId: userBadge.badgeId,
        serial: userRegistration.seq,
      })
      .from(userBadge)
      .innerJoin(badge, eq(userBadge.badgeId, badge.id))
      .leftJoin(userRegistration, eq(userRegistration.userId, userBadge.userId))
      .where(inArray(userBadge.userId, unique))
      .orderBy(asc(badge.sortOrder));
    const grouped = new Map<string, AccountBadge[]>();
    for (const row of rows) {
      const kind = row.badgeId as BadgeKind;
      const list = grouped.get(row.userId) ?? [];
      list.push({ kind, serial: kind === "pioneer" ? (row.serial ?? null) : null });
      grouped.set(row.userId, list);
    }
    return grouped;
  }

  async grant(
    userId: string,
    badgeId: BadgeKind,
    grantedBy: string | null,
    now: Date
  ): Promise<void> {
    await this.ensureCatalog();
    await this.database.db.transaction(async (tx) => {
      await tx
        .insert(userBadge)
        .values({ userId, badgeId, grantedBy, grantedAt: now })
        .onDuplicateKeyUpdate({ set: { grantedBy, grantedAt: now } });
      // 只在没有佩戴徽章时给新徽章让位；玩家主动选择过就不覆盖。
      await tx
        .update(user)
        .set({ equippedBadge: badgeId })
        .where(and(eq(user.id, userId), isNull(user.equippedBadge)));
    });
  }

  async revoke(userId: string, badgeId: BadgeKind): Promise<void> {
    await this.database.ready;
    await this.database.db.transaction(async (tx) => {
      await tx
        .delete(userBadge)
        .where(and(eq(userBadge.userId, userId), eq(userBadge.badgeId, badgeId)));
      await tx
        .update(user)
        .set({ equippedBadge: null })
        .where(and(eq(user.id, userId), eq(user.equippedBadge, badgeId)));
    });
  }

  async resetExclusive(badgeId: BadgeKind, keepUserId: string | null): Promise<void> {
    await this.ensureCatalog();
    await this.database.db.transaction(async (tx) => {
      await tx
        .delete(userBadge)
        .where(
          keepUserId
            ? and(eq(userBadge.badgeId, badgeId), ne(userBadge.userId, keepUserId))
            : eq(userBadge.badgeId, badgeId)
        );
      await tx
        .update(user)
        .set({ equippedBadge: null })
        .where(
          keepUserId
            ? and(eq(user.equippedBadge, badgeId), ne(user.id, keepUserId))
            : eq(user.equippedBadge, badgeId)
        );
    });
  }
}
