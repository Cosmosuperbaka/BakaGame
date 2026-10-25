import { asc, eq, isNull, lte } from "drizzle-orm";

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
    for (let index = 0; index < missing.length; index += 100) {
      const rows = missing.slice(index, index + 100).map((row) => ({ userId: row.id }));
      await this.database.db.insert(userRegistration).ignore().values(rows);
    }
  }

  async register(userId: string): Promise<number> {
    // 先补齐存量账号：否则启动回填尚未跑完时，新号会拿到比老号更小的序号。
    await this.ensureAll();
    await this.database.db
      .insert(userRegistration)
      .values({ userId })
      .onDuplicateKeyUpdate({ set: { userId } });
    const [row] = await this.database.db
      .select({ seq: userRegistration.seq })
      .from(userRegistration)
      .where(eq(userRegistration.userId, userId))
      .limit(1);
    if (!row) throw new Error("注册序号写入后读不回来");
    return row.seq;
  }

  async earlyAdopters(limit: number): Promise<Array<{ userId: string; serial: number }>> {
    await this.database.ready;
    return this.database.db
      .select({ userId: userRegistration.userId, serial: userRegistration.seq })
      .from(userRegistration)
      .where(lte(userRegistration.seq, limit))
      .orderBy(asc(userRegistration.seq));
  }
}
