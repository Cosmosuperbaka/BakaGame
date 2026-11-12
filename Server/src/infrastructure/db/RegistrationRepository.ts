import { asc, eq, isNull, lte, sql } from "drizzle-orm";

import { PIONEER_BADGE_LIMIT } from "../../shared/Badges";
import type { EventLogger } from "../EventLogger";
import type { Database } from "./Database";
import { user, userRegistration } from "./Schema";

/** 建号序号：先行者徽章的授予依据，序号按建号顺序递增；中间账号注销留下的空位不回填。 */
export interface RegistrationRepository {
  /** 启动自愈：压实历史跳号、给存量账号按注册时间补齐序号、自检次序；幂等。 */
  ensureAll(): Promise<void>;
  /** 给刚建好的账号分配序号；同一账号重复调用返回原序号。 */
  register(userId: string): Promise<number>;
  /** 账号的注册名次（1 起，按序号排序是第几位）；账号没有序号返回 `null`。 */
  rankOf(userId: string): Promise<number | null>;
  earlyAdopters(limit: number): Promise<Array<{ userId: string; serial: number }>>;
}

/** 存量回填的分批大小：一批账号连续编号后一次插入。 */
export const REGISTRATION_BATCH_SIZE = 100;

/** 并发建号撞上同一序号时的重试次数；每次重试都重读当前最大值。 */
export const REGISTRATION_ASSIGN_ATTEMPTS = 5;

/**
 * 相邻两个序号相差超过它就判为跳号。取先行者名额的量级：注销留不下这么大的连续空洞，
 * 自增预取的段长（数万）又远大于它，两边都离得很远。
 */
export const REGISTRATION_GAP_THRESHOLD = PIONEER_BADGE_LIMIT;

/** 升序序号的压实方案：只列出要改的行；起点按 0 算，序号从跳号值起步也会落到 1。 */
const planCompaction = (serials: readonly number[]): Array<{ from: number; to: number }> => {
  const moves: Array<{ from: number; to: number }> = [];
  let previousOld = 0;
  let previousNew = 0;
  for (const seq of serials) {
    const gap = seq - previousOld;
    const next = gap > REGISTRATION_GAP_THRESHOLD ? previousNew + 1 : previousNew + gap;
    if (next !== seq) moves.push({ from: seq, to: next });
    previousOld = seq;
    previousNew = next;
  }
  return moves;
};

/** MySQL / TiDB 的唯一键冲突。 */
const isDuplicateKey = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "ER_DUP_ENTRY" ||
  (error as { errno?: unknown } | null)?.errno === 1062;

/**
 * 注册序号由应用层按「当前最大值 + 1」分配，**不依赖数据库自增**。
 *
 * 托管库是 TiDB：自增按缓存段预取（`AUTO_ID_CACHE` 默认一段 30000），第 5 个真实账号
 * 就会拿到 30001，先行者的「前 N 名」判定（`seq <= PIONEER_BADGE_LIMIT`）直接被跳号顶穿。
 * 连续序号只能自己算：撞号时主键报错后重读最大值重试。序号行随账号级联删除：中间账号注销
 * 留下的空位不回填，但最后注册的那位注销后，下一位会沿用它的序号（分配只看当前最大值）。
 * 早期自增留下的跳号由启动时的压实收掉。
 */
export class DatabaseRegistrationRepository implements RegistrationRepository {
  private ensured: Promise<void> | null = null;

  constructor(
    private readonly database: Database,
    private readonly logger?: Pick<EventLogger, "warn">
  ) {}

  ensureAll(): Promise<void> {
    this.ensured ??= this.sync().catch((error: unknown) => {
      this.ensured = null;
      throw error;
    });
    return this.ensured;
  }

  private async sync(): Promise<void> {
    await this.database.ready;
    // 先压实再回填：回填的新序号接在压实后的最大值之后，不会又接在跳号后面。
    await this.compactGaps();
    const missing = await this.database.db
      .select({ id: user.id })
      .from(user)
      .leftJoin(userRegistration, eq(user.id, userRegistration.userId))
      .where(isNull(userRegistration.seq))
      .orderBy(asc(user.createdAt), asc(user.id));
    // 分批插入：序号按 createdAt 顺序分配，存量账号因此与真实注册先后一致。
    for (let index = 0; index < missing.length; index += REGISTRATION_BATCH_SIZE) {
      await this.appendBatch(
        missing.slice(index, index + REGISTRATION_BATCH_SIZE).map((row) => row.id)
      );
    }
    await this.auditOrder();
  }

  /**
   * 跳号压实：自增预取留下的巨大空洞整体前移，注销留下的小空洞与正常序号一个不动。
   *
   * 整个过程在一个事务里，按序号升序逐行改：每行新值都小于旧值，且目标位要么本来就空、
   * 要么已被前面搬走的行腾出，不会撞主键。幂等：压实后没有超过阈值的差距，再跑是空操作。
   * 并发建号走「最大值加一」加撞号重试：进程内的建号先等本方法跑完；别的实例在事务期间
   * 插入的行最多留下一处新的跳号，下一次启动的压实会收掉，展示侧另有名额兜底。
   */
  private async compactGaps(): Promise<void> {
    const moves = await this.database.db.transaction(async (tx) => {
      const rows = await tx
        .select({ seq: userRegistration.seq, userId: userRegistration.userId })
        .from(userRegistration)
        .orderBy(asc(userRegistration.seq))
        .for("update");
      const planned = planCompaction(rows.map((row) => row.seq));
      for (const move of planned) {
        await tx
          .update(userRegistration)
          .set({ seq: move.to })
          .where(eq(userRegistration.seq, move.from));
      }
      return planned;
    });
    if (!moves.length) return;
    this.logger?.warn("注册序号跳号已压实", {
      rows: moves.length,
      maxBefore: Math.max(...moves.map((move) => move.from)),
      maxAfter: Math.max(...moves.map((move) => move.to)),
      samples: moves.slice(0, 5).map((move) => ({ from: move.from, to: move.to })),
    });
  }

  /** 次序自检：序号顺序与账号创建时间相反的相邻对只告警数量，不自动改。 */
  private async auditOrder(): Promise<void> {
    const rows = await this.database.db
      .select({ seq: userRegistration.seq, createdAt: user.createdAt })
      .from(userRegistration)
      .innerJoin(user, eq(user.id, userRegistration.userId))
      .orderBy(asc(userRegistration.seq));
    let inversions = 0;
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (previous && current && current.createdAt.getTime() < previous.createdAt.getTime())
        inversions += 1;
    }
    if (inversions > 0) this.logger?.warn("注册序号次序与账号创建时间不一致", { inversions });
  }

  async register(userId: string): Promise<number> {
    // 先补齐存量账号：否则启动回填尚未跑完时，新号会拿到比老号更小的序号。
    await this.ensureAll();
    const existing = await this.seqOf(userId);
    if (existing !== null) return existing;
    await this.appendBatch([userId]);
    const serial = await this.seqOf(userId);
    if (serial === null) throw new Error("注册序号写入后读不回来");
    return serial;
  }

  async rankOf(userId: string): Promise<number | null> {
    await this.database.ready;
    const seq = await this.seqOf(userId);
    if (seq === null) return null;
    const [row] = await this.database.db
      .select({ value: sql<number>`count(*)` })
      .from(userRegistration)
      .where(lte(userRegistration.seq, seq));
    return Number(row?.value ?? 0);
  }

  /** 一批账号接在现有最大值之后连续编号；被并发建号抢先就重读最大值重来。 */
  private async appendBatch(userIds: readonly string[]): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const start = (await this.maxSeq()) + 1;
      try {
        await this.database.db
          .insert(userRegistration)
          .values(userIds.map((userId, offset) => ({ seq: start + offset, userId })));
        return;
      } catch (error) {
        // 同批账号已在别处落号（重复调用）属于幂等成功，重读即可。
        if (!isDuplicateKey(error) || attempt >= REGISTRATION_ASSIGN_ATTEMPTS) throw error;
        const placed = await this.seqOf(userIds[0] as string);
        if (placed !== null) return;
      }
    }
  }

  /** 当前最大序号；空表按 0 起算，第一条即 1。 */
  private async maxSeq(): Promise<number> {
    const [row] = await this.database.db
      .select({ value: sql<number | null>`max(${userRegistration.seq})` })
      .from(userRegistration);
    return row?.value == null ? 0 : Number(row.value);
  }

  private async seqOf(userId: string): Promise<number | null> {
    const [row] = await this.database.db
      .select({ seq: userRegistration.seq })
      .from(userRegistration)
      .where(eq(userRegistration.userId, userId))
      .limit(1);
    return row ? row.seq : null;
  }

  /** 先行者名单：按序号升序取前 N 名，序号的数值大小不参与判定。 */
  async earlyAdopters(limit: number): Promise<Array<{ userId: string; serial: number }>> {
    await this.database.ready;
    return this.database.db
      .select({ userId: userRegistration.userId, serial: userRegistration.seq })
      .from(userRegistration)
      .orderBy(asc(userRegistration.seq))
      .limit(limit);
  }
}
