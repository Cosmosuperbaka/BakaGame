import { asc, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "./Database";
import { user, userRegistration } from "./Schema";

/** 建号序号：先行者徽章的授予依据，序号按建号顺序递增且不回收。 */
export interface RegistrationRepository {
  /** 给存量账号按注册时间补齐序号；幂等，启动时调用。 */
  ensureAll(): Promise<void>;
  /** 给刚建好的账号分配序号；同一账号重复调用返回原序号。 */
  register(userId: string): Promise<number>;
  earlyAdopters(limit: number): Promise<Array<{ userId: string; serial: number }>>;
}

/** 存量回填的分批大小：一批账号连续编号后一次插入。 */
export const REGISTRATION_BATCH_SIZE = 100;

/** 并发建号撞上同一序号时的重试次数；每次重试都重读当前最大值。 */
export const REGISTRATION_ASSIGN_ATTEMPTS = 5;

/** MySQL / TiDB 的唯一键冲突。 */
const isDuplicateKey = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "ER_DUP_ENTRY" ||
  (error as { errno?: unknown } | null)?.errno === 1062;

/**
 * 注册序号由应用层按「当前最大值 + 1」分配，**不依赖数据库自增**。
 *
 * 托管库是 TiDB：自增按缓存段预取（`AUTO_ID_CACHE` 默认一段 30000），第 5 个真实账号
 * 就会拿到 30001，先行者的「前 N 名」判定（`seq <= PIONEER_BADGE_LIMIT`）直接被跳号顶穿。
 * 连续序号只能自己算：撞号时主键报错后重读最大值重试，序号不因注销回收。
 */
export class DatabaseRegistrationRepository implements RegistrationRepository {
  private ensured: Promise<void> | null = null;

  constructor(private readonly database: Database) {}

  ensureAll(): Promise<void> {
    this.ensured ??= this.sync().catch((error: unknown) => {
      this.ensured = null;
      throw error;
    });
    return this.ensured;
  }

  private async sync(): Promise<void> {
    await this.database.ready;
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
