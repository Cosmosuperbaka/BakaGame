import { and, desc, eq, isNotNull, sql, type SQL } from "drizzle-orm";

import type { FeedbackKind, FeedbackStatus } from "../../shared/ApiContract";
import type { Database } from "./Database";
import { feedback, feedbackReply, userSetting } from "./Schema";

// ==================== 云同步设置 ====================

export interface StoredSetting {
  key: string;
  value: unknown;
  updatedAt: Date;
}

/** 一行一个键，整体覆盖写入；值的结构与加密由应用层负责。 */
export interface UserSettingRepository {
  list(userId: string): Promise<StoredSetting[]>;
  put(userId: string, key: string, value: unknown, now: Date): Promise<void>;
  remove(userId: string, key: string): Promise<void>;
}

export class DatabaseUserSettingRepository implements UserSettingRepository {
  constructor(private readonly database: Database) {}

  async list(userId: string): Promise<StoredSetting[]> {
    await this.database.ready;
    return this.database.db.select({ key: userSetting.key, value: userSetting.value, updatedAt: userSetting.updatedAt })
      .from(userSetting).where(eq(userSetting.userId, userId));
  }

  async put(userId: string, key: string, value: unknown, now: Date): Promise<void> {
    await this.database.ready;
    await this.database.db.insert(userSetting).values({ userId, key, value, updatedAt: now })
      .onDuplicateKeyUpdate({ set: { value, updatedAt: now } });
  }

  async remove(userId: string, key: string): Promise<void> {
    await this.database.ready;
    await this.database.db.delete(userSetting).where(and(eq(userSetting.userId, userId), eq(userSetting.key, key)));
  }
}

// ==================== 反馈 ====================


export interface FeedbackRecord {
  id: string;
  userId: string;
  kind: FeedbackKind;
  title: string;
  content: string;
  status: FeedbackStatus;
  page: string | null;
  userAgent: string | null;
  sentryEventId: string | null;
  lastReplyAt: Date | null;
  userSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FeedbackReplyRecord {
  id: number;
  feedbackId: string;
  authorId: string | null;
  content: string;
  createdAt: Date;
}

export interface FeedbackFilter {
  status?: FeedbackStatus;
  kind?: FeedbackKind;
  userId?: string;
  limit: number;
  offset: number;
}

export interface FeedbackRepository {
  create(record: FeedbackRecord): Promise<void>;
  update(id: string, patch: Partial<Pick<FeedbackRecord, "status" | "sentryEventId" | "lastReplyAt" | "userSeenAt" | "updatedAt">>): Promise<void>;
  get(id: string): Promise<FeedbackRecord | null>;
  list(filter: FeedbackFilter): Promise<{ items: FeedbackRecord[]; total: number }>;
  /** 本人提交后、管理员回复晚于本人查看时间的条数。 */
  countUnread(userId: string): Promise<number>;
  addReply(reply: Omit<FeedbackReplyRecord, "id">): Promise<FeedbackReplyRecord>;
  replies(feedbackId: string): Promise<FeedbackReplyRecord[]>;
}

const asFeedback = (row: typeof feedback.$inferSelect): FeedbackRecord => ({
  ...row,
  kind: row.kind as FeedbackKind,
  status: row.status as FeedbackStatus,
});

export class DatabaseFeedbackRepository implements FeedbackRepository {
  constructor(private readonly database: Database) {}

  async create(record: FeedbackRecord): Promise<void> {
    await this.database.ready;
    await this.database.db.insert(feedback).values(record);
  }

  async update(id: string, patch: Parameters<FeedbackRepository["update"]>[1]): Promise<void> {
    await this.database.ready;
    await this.database.db.update(feedback).set(patch).where(eq(feedback.id, id));
  }

  async get(id: string): Promise<FeedbackRecord | null> {
    await this.database.ready;
    const [row] = await this.database.db.select().from(feedback).where(eq(feedback.id, id)).limit(1);
    return row ? asFeedback(row) : null;
  }

  async list(filter: FeedbackFilter): Promise<{ items: FeedbackRecord[]; total: number }> {
    await this.database.ready;
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(feedback.status, filter.status));
    if (filter.kind) conditions.push(eq(feedback.kind, filter.kind));
    if (filter.userId) conditions.push(eq(feedback.userId, filter.userId));
    const where = conditions.length ? and(...conditions) : undefined;
    const [rows, [count]] = await Promise.all([
      this.database.db.select().from(feedback).where(where).orderBy(desc(feedback.createdAt)).limit(filter.limit).offset(filter.offset),
      this.database.db.select({ total: sql<number>`count(*)` }).from(feedback).where(where),
    ]);
    return { items: rows.map(asFeedback), total: Number(count?.total ?? 0) };
  }

  async countUnread(userId: string): Promise<number> {
    await this.database.ready;
    const [row] = await this.database.db.select({ total: sql<number>`count(*)` }).from(feedback).where(and(
      eq(feedback.userId, userId),
      isNotNull(feedback.lastReplyAt),
      sql`(${feedback.userSeenAt} is null or ${feedback.userSeenAt} < ${feedback.lastReplyAt})`,
    ));
    return Number(row?.total ?? 0);
  }

  async addReply(reply: Omit<FeedbackReplyRecord, "id">): Promise<FeedbackReplyRecord> {
    await this.database.ready;
    const [result] = await this.database.db.insert(feedbackReply).values(reply).$returningId();
    return { ...reply, id: result!.id };
  }

  async replies(feedbackId: string): Promise<FeedbackReplyRecord[]> {
    await this.database.ready;
    return this.database.db.select().from(feedbackReply).where(eq(feedbackReply.feedbackId, feedbackId)).orderBy(feedbackReply.createdAt);
  }
}
