import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";

import type { Database } from "./Database";
import { auditLog } from "./Schema";

export interface AuditEntry {
  /** 操作人；系统动作为空。 */
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown> | null;
  createdAt: Date;
}

export interface StoredAuditEntry extends AuditEntry {
  id: number;
}

export interface AuditFilter {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  since?: Date;
  limit: number;
  offset: number;
}

export interface AuditLogRepository {
  append(entry: AuditEntry): Promise<void>;
  list(filter: AuditFilter): Promise<{ items: StoredAuditEntry[]; total: number }>;
}

export class DatabaseAuditLogRepository implements AuditLogRepository {
  constructor(private readonly database: Database) {}

  async append(entry: AuditEntry): Promise<void> {
    await this.database.ready;
    // 不记录 IP：经反向代理时 X-Forwarded-For 可被客户端伪造，记下来反而误导追查。
    await this.database.db.insert(auditLog).values({ ...entry, ipAddress: null });
  }

  async list(filter: AuditFilter): Promise<{ items: StoredAuditEntry[]; total: number }> {
    await this.database.ready;
    const conditions: SQL[] = [];
    if (filter.actorId) conditions.push(eq(auditLog.actorId, filter.actorId));
    if (filter.action) conditions.push(eq(auditLog.action, filter.action));
    if (filter.targetType) conditions.push(eq(auditLog.targetType, filter.targetType));
    if (filter.targetId) conditions.push(eq(auditLog.targetId, filter.targetId));
    if (filter.since) conditions.push(gte(auditLog.createdAt, filter.since));
    const where = conditions.length ? and(...conditions) : undefined;
    const [rows, [count]] = await Promise.all([
      this.database.db.select({
        id: auditLog.id, actorId: auditLog.actorId, action: auditLog.action, targetType: auditLog.targetType,
        targetId: auditLog.targetId, detail: auditLog.detail, createdAt: auditLog.createdAt,
      }).from(auditLog).where(where).orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(filter.limit).offset(filter.offset),
      this.database.db.select({ total: sql<number>`count(*)` }).from(auditLog).where(where),
    ]);
    return {
      items: rows.map((row) => ({ ...row, detail: (row.detail ?? null) as Record<string, unknown> | null })),
      total: Number(count?.total ?? 0),
    };
  }
}
