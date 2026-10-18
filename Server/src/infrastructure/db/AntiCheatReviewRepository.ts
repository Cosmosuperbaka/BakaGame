import { and, desc, eq, gte, sql } from "drizzle-orm";
import type {
  CEEAntiCheatReview,
  CEEAntiCheatReviewQueue,
  CEEUnitFeatures,
} from "../../application/CEEAntiCheatSignals";
import type { Database } from "./Database";
import { ceeAntiCheatReview } from "./Schema";

/** 复核条目状态：只有人能在后台改，代码路径永不写除 `open` 以外的值。 */
export type CEEAntiCheatReviewStatus = "open" | "cleared" | "actioned";

export interface CEEAntiCheatReviewItem extends CEEAntiCheatReview {
  id: string;
  status: CEEAntiCheatReviewStatus;
}

/**
 * CEE 反作弊人工复核队列。
 *
 * 这张表存的是「值得人看一眼」的候选，不是结论：写入只由服务端可观测特征触发，
 * 是否处置全部由人在队列里判断。因此这里没有封禁、没有扣分，也没有任何自动动作。
 */
export class AntiCheatReviewRepository implements CEEAntiCheatReviewQueue {
  constructor(
    private readonly database: Database,
    private readonly onWarn: (message: string, context?: Record<string, unknown>) => void = () => {}
  ) {}
  /** 与对局记录同口径：异步写入，失败只记日志，绝不影响对局本身。 */
  add(review: CEEAntiCheatReview): void {
    this.insert(review).catch((error: unknown) => {
      this.onWarn("反作弊复核条目写入失败", { roomId: review.roomId, error });
    });
  }
  private async insert(review: CEEAntiCheatReview): Promise<void> {
    await this.database.ready;
    await this.database.db.insert(ceeAntiCheatReview).values({
      id: crypto.randomUUID(),
      roomId: review.roomId,
      roomCreatedAt: new Date(review.roomCreatedAt),
      roundNumber: review.roundNumber,
      playerId: review.playerId,
      playerName: review.playerName,
      userId: review.userId,
      clientType: review.clientType,
      score: review.score,
      reasons: review.reasons,
      features: review.features,
      status: "open",
      createdAt: new Date(review.recordedAt),
    });
  }
  async list(
    options: {
      status?: CEEAntiCheatReviewStatus;
      since?: number;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ items: CEEAntiCheatReviewItem[]; total: number }> {
    await this.database.ready;
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const conditions = [];
    if (options.status) conditions.push(eq(ceeAntiCheatReview.status, options.status));
    if (options.since !== undefined)
      conditions.push(gte(ceeAntiCheatReview.createdAt, new Date(options.since)));
    const where = conditions.length ? and(...conditions) : undefined;
    const [rows, totals] = await Promise.all([
      this.database.db
        .select()
        .from(ceeAntiCheatReview)
        .where(where)
        .orderBy(desc(ceeAntiCheatReview.createdAt))
        .limit(limit)
        .offset(offset),
      this.database.db
        .select({ total: sql<number>`count(*)` })
        .from(ceeAntiCheatReview)
        .where(where),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        roomId: row.roomId,
        roomCreatedAt: row.roomCreatedAt.getTime(),
        roundNumber: row.roundNumber,
        playerId: row.playerId,
        playerName: row.playerName,
        userId: row.userId,
        clientType: row.clientType as CEEAntiCheatReviewItem["clientType"],
        recordedAt: row.createdAt.getTime(),
        score: row.score,
        reasons: row.reasons as string[],
        features: row.features as CEEUnitFeatures,
        status: row.status as CEEAntiCheatReviewStatus,
      })),
      total: Number(totals[0]?.total ?? 0),
    };
  }
  async setStatus(id: string, status: CEEAntiCheatReviewStatus): Promise<void> {
    await this.database.ready;
    await this.database.db
      .update(ceeAntiCheatReview)
      .set({ status })
      .where(eq(ceeAntiCheatReview.id, id));
  }
}
