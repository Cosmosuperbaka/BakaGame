import { asc, eq, isNull, lte, sql } from "drizzle-orm";

import { PIONEER_BADGE_LIMIT } from "../../shared/Badges";
import type { EventLogger } from "../EventLogger";
import type { Database, DatabaseClient } from "./Database";
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
const planCompaction = (serials: readonly number[]): SerialMove[] => {
  const moves: SerialMove[] = [];
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

interface SerialMove {
  from: number;
  to: number;
}

/** 数据库连接或事务：自愈与自检共用的读写口。 */
type SerialExecutor = Pick<DatabaseClient, "select" | "update">;

interface TimedRegistration {
  seq: number;
  userId: string;
  createdAt: Date;
}

/** 无符号整型列的上限：重排先把行挪到高位，高位值不得溢出它。 */
const UNSIGNED_INT_MAX = 4_294_967_295;

/** 按序号升序排列的相邻对里，创建时间反过来的有多少对。 */
const countInversions = (rows: readonly Pick<TimedRegistration, "createdAt">[]): number => {
  let inversions = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (previous && current && current.createdAt.getTime() < previous.createdAt.getTime())
      inversions += 1;
  }
  return inversions;
};

/** 重排方案：按（创建时间，账号 id）排成 1..N，与启动回填同一口径；只列出要改的行。 */
const planResequence = (rows: readonly TimedRegistration[]): SerialMove[] =>
  [...rows]
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)
    )
    .flatMap((row, index) => (row.seq === index + 1 ? [] : [{ from: row.seq, to: index + 1 }]));

/** 按序号升序读出每行账号的创建时间。 */
const readCreationOrder = (
  executor: SerialExecutor
): Promise<Array<{ seq: number; createdAt: Date }>> =>
  executor
    .select({ seq: userRegistration.seq, createdAt: user.createdAt })
    .from(userRegistration)
    .innerJoin(user, eq(user.id, userRegistration.userId))
    .orderBy(asc(userRegistration.seq));

/** 日志里只带错误类别，不带语句与参数（语句里可能有账号标识）。 */
const errorKindOf = (error: unknown): Record<string, unknown> => ({
  name: error instanceof Error ? error.name : typeof error,
  code: (error as { code?: unknown } | null)?.code ?? null,
});

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
  /** 自愈本进程只试一次：事务被库拒绝时，不能让每次建号都重跑一遍失败的事务。 */
  private healAttempted = false;

  constructor(
    private readonly database: Database,
    private readonly logger?: Pick<EventLogger, "warn" | "error">
  ) {}

  ensureAll(): Promise<void> {
    this.ensured ??= this.sync().catch((error: unknown) => {
      this.ensured = null;
      throw error;
    });
    return this.ensured;
  }

  private async sync(): Promise<void> {
    const db = await this.database.client();
    // 先自愈再回填：回填的新序号接在修好的最大值之后，不会又接在跳号后面。
    await this.heal();
    const missing = await db
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
   * 自愈失败不是启动失败：库若拒绝这次事务，`register` 每次先等 `ensureAll`，让它抛错
   * 等于所有新号都拿不到序号与徽章。所以只记错误日志，回填与建号照常，下次进程启动再试。
   */
  private async heal(): Promise<void> {
    if (this.healAttempted) return;
    this.healAttempted = true;
    try {
      await this.repairSerials();
    } catch (error) {
      this.logger?.error("注册序号自愈失败，本进程不再重试，回填与建号照常", errorKindOf(error));
    }
  }

  /**
   * 检出跳号才动手，整个过程在一个事务里：
   * - 现有序号顺序与创建时间没有逆序：保序压实。跳号整体前移，注销留下的小空洞与正常序号
   *   一个不动；按序号升序逐行改，每行新值都小于旧值且目标位已腾空，不会撞主键。
   * - 存在逆序：托管库多节点各自预取自增段，早期序号的顺序本身就可能与建号先后相反，
   *   整表按（创建时间，账号 id）重排为 1..N。新旧值会交叉，所以先把要改的行全部挪到高位
   *   （当前最大值之上、不溢出无符号整型），再写目标值。
   * - 没有跳号：一行不动。稳定运行期的个别逆序来自并发建号或漏发回填，为它整表重排会改掉
   *   一批玩家已经看到的编号，只由次序自检告警。
   * 幂等：处理后没有超过阈值的差距，再跑是空操作。并发建号走「最大值加一」加撞号重试：
   * 进程内的建号先等 `ensureAll`；别的实例在事务期间插入的行最多留下一处新跳号，下次启动
   * 的自愈会收掉，展示侧另有名额兜底。
   */
  private async repairSerials(): Promise<void> {
    const db = await this.database.client();
    const outcome = await db.transaction(async (tx) => {
      const rows = await tx
        .select({ seq: userRegistration.seq, userId: userRegistration.userId })
        .from(userRegistration)
        .orderBy(asc(userRegistration.seq))
        .for("update");
      const compaction = planCompaction(rows.map((row) => row.seq));
      if (!compaction.length) return null;
      const createdBySeq = new Map(
        (await readCreationOrder(tx)).map((row) => [row.seq, row.createdAt])
      );
      const timed = rows.map((row) => ({
        ...row,
        createdAt: createdBySeq.get(row.seq) ?? new Date(0),
      }));
      if (countInversions(timed) === 0) {
        for (const move of compaction) await this.moveSerial(tx, move.from, move.to);
        return { kind: "compact" as const, moves: compaction };
      }
      const moves = planResequence(timed);
      const maxSeq = rows.at(-1)?.seq ?? 0;
      if (maxSeq * 2 > UNSIGNED_INT_MAX) throw new Error("注册序号挪到高位会溢出无符号整型");
      for (const move of moves) await this.moveSerial(tx, move.from, move.from + maxSeq);
      for (const move of moves) await this.moveSerial(tx, move.from + maxSeq, move.to);
      return { kind: "resequence" as const, moves };
    });
    if (!outcome?.moves.length) return;
    const { moves } = outcome;
    this.logger?.warn(
      outcome.kind === "compact"
        ? "注册序号跳号已压实"
        : "注册序号跳号且次序不符，已按建号时间重排",
      {
        rows: moves.length,
        maxBefore: Math.max(...moves.map((move) => move.from)),
        maxAfter: Math.max(...moves.map((move) => move.to)),
        samples: moves.slice(0, 5).map((move) => ({ from: move.from, to: move.to })),
      }
    );
  }

  private async moveSerial(executor: SerialExecutor, from: number, to: number): Promise<void> {
    await executor.update(userRegistration).set({ seq: to }).where(eq(userRegistration.seq, from));
  }

  /** 次序自检：序号顺序与账号创建时间相反的相邻对只告警数量，不自动改；失败只记日志。 */
  private async auditOrder(): Promise<void> {
    try {
      const db = await this.database.client();
      const inversions = countInversions(await readCreationOrder(db));
      if (inversions > 0) this.logger?.warn("注册序号次序与账号创建时间不一致", { inversions });
    } catch (error) {
      this.logger?.error("注册序号次序自检失败", errorKindOf(error));
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

  async rankOf(userId: string): Promise<number | null> {
    const db = await this.database.client();
    const seq = await this.seqOf(userId);
    if (seq === null) return null;
    const [row] = await db
      .select({ value: sql<number>`count(*)` })
      .from(userRegistration)
      .where(lte(userRegistration.seq, seq));
    return Number(row?.value ?? 0);
  }

  /** 一批账号接在现有最大值之后连续编号；被并发建号抢先就重读最大值重来。 */
  private async appendBatch(userIds: readonly string[]): Promise<void> {
    const db = await this.database.client();
    for (let attempt = 1; ; attempt += 1) {
      const start = (await this.maxSeq()) + 1;
      try {
        await db
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
    const db = await this.database.client();
    const [row] = await db
      .select({ value: sql<number | null>`max(${userRegistration.seq})` })
      .from(userRegistration);
    return row?.value == null ? 0 : Number(row.value);
  }

  private async seqOf(userId: string): Promise<number | null> {
    const db = await this.database.client();
    const [row] = await db
      .select({ seq: userRegistration.seq })
      .from(userRegistration)
      .where(eq(userRegistration.userId, userId))
      .limit(1);
    return row ? row.seq : null;
  }

  /** 先行者名单：按序号升序取前 N 名，序号的数值大小不参与判定。 */
  async earlyAdopters(limit: number): Promise<Array<{ userId: string; serial: number }>> {
    const db = await this.database.client();
    return db
      .select({ userId: userRegistration.userId, serial: userRegistration.seq })
      .from(userRegistration)
      .orderBy(asc(userRegistration.seq))
      .limit(limit);
  }
}
