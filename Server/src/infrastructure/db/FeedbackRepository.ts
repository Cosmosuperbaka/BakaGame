import { and, desc, eq, isNotNull, sql, type SQL } from "drizzle-orm";

import type { FeedbackKind, FeedbackStatus } from "../../shared/ApiContract";
import type { Database } from "./Database";
import { feedback, feedbackReply } from "./Schema";

export interface FeedbackRecord {
  id: string;
  /** 匿名反馈为空；登录用户提交时关联账号。 */
  userId: string | null;
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
  update(
    id: string,
    patch: Partial<
      Pick<FeedbackRecord, "status" | "sentryEventId" | "lastReplyAt" | "userSeenAt" | "updatedAt">
    >
  ): Promise<void>;
  get(id: string): Promise<FeedbackRecord | null>;
  list(filter: FeedbackFilter): Promise<{ items: FeedbackRecord[]; total: number }>;
  /** 本人提交后、管理员回复晚于本人查看时间的条数。 */
  countUnread(userId: string): Promise<number>;
  /** 各状态条数，供后台概览；没有记录的状态不出现。 */
  countByStatus(): Promise<Partial<Record<FeedbackStatus, number>>>;
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
    const db = await this.database.client();
    await db.insert(feedback).values(record);
  }

  async update(id: string, patch: Parameters<FeedbackRepository["update"]>[1]): Promise<void> {
    const db = await this.database.client();
    await db.update(feedback).set(patch).where(eq(feedback.id, id));
  }

  async get(id: string): Promise<FeedbackRecord | null> {
    const db = await this.database.client();
    const [row] = await db
      .select()
      .from(feedback)
      .where(eq(feedback.id, id))
      .limit(1);
    return row ? asFeedback(row) : null;
  }

  async list(filter: FeedbackFilter): Promise<{ items: FeedbackRecord[]; total: number }> {
    const db = await this.database.client();
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(feedback.status, filter.status));
    if (filter.kind) conditions.push(eq(feedback.kind, filter.kind));
    if (filter.userId) conditions.push(eq(feedback.userId, filter.userId));
    const where = conditions.length ? and(...conditions) : undefined;
    const [rows, [count]] = await Promise.all([
      db
        .select()
        .from(feedback)
        .where(where)
        .orderBy(desc(feedback.createdAt))
        .limit(filter.limit)
        .offset(filter.offset),
      db
        .select({ total: sql<number>`count(*)` })
        .from(feedback)
        .where(where),
    ]);
    return { items: rows.map(asFeedback), total: Number(count?.total ?? 0) };
  }

  async countUnread(userId: string): Promise<number> {
    const db = await this.database.client();
    const [row] = await db
      .select({ total: sql<number>`count(*)` })
      .from(feedback)
      .where(
        and(
          eq(feedback.userId, userId),
          isNotNull(feedback.lastReplyAt),
          sql`(${feedback.userSeenAt} is null or ${feedback.userSeenAt} < ${feedback.lastReplyAt})`
        )
      );
    return Number(row?.total ?? 0);
  }

  async countByStatus(): Promise<Partial<Record<FeedbackStatus, number>>> {
    const db = await this.database.client();
    const rows = await db
      .select({ status: feedback.status, total: sql<number>`count(*)` })
      .from(feedback)
      .groupBy(feedback.status);
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.total)]));
  }

  async addReply(reply: Omit<FeedbackReplyRecord, "id">): Promise<FeedbackReplyRecord> {
    const db = await this.database.client();
    const [result] = await db.insert(feedbackReply).values(reply).$returningId();
    return { ...reply, id: result!.id };
  }

  async replies(feedbackId: string): Promise<FeedbackReplyRecord[]> {
    const db = await this.database.client();
    return db
      .select()
      .from(feedbackReply)
      .where(eq(feedbackReply.feedbackId, feedbackId))
      .orderBy(feedbackReply.createdAt);
  }
}
