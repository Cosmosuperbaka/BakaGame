import { and, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";

import type { GameRecordEvent, GameRecordPlayer, RecordedGame } from "../../domain/GameRecord";
import type { Database } from "./Database";
import { gameRecord, gameRecordPlayer } from "./Schema";

export interface StoredGameRecord {
  id: string;
  game: RecordedGame;
  roomId: string;
  roundNumber: number;
  startedAt: Date;
  endedAt: Date;
  players: GameRecordPlayer[];
  summary: Record<string, unknown>;
  timeline: GameRecordEvent[];
}

export type GameRecordListItem = Omit<StoredGameRecord, "summary" | "timeline">;

export interface GameRecordFilter {
  game?: RecordedGame;
  roomId?: string;
  /** 只看某个账号参与过的对局。 */
  userId?: string;
  since?: Date;
  limit: number;
  offset: number;
}

/** 北京时间自然日（`YYYY-MM-DD`）× 游戏的对局量。 */
export interface GameDailyCount {
  day: string;
  game: RecordedGame;
  rounds: number;
  /** 参与人次（同一人多轮重复计）。 */
  players: number;
  /** 去重后的登录玩家数。 */
  accounts: number;
}

export interface GameRecordRepository {
  insert(record: StoredGameRecord): Promise<void>;
  /** 删除结束时间早于 `before` 的记录，单批最多 `batch` 条；返回删除条数。 */
  purge(before: Date, batch: number): Promise<number>;
  list(filter: GameRecordFilter): Promise<{ items: GameRecordListItem[]; total: number }>;
  get(id: string): Promise<StoredGameRecord | null>;
  dailyCounts(since: Date): Promise<GameDailyCount[]>;
}

/** UTC 落库时间 → 北京时间自然日；与站点访问统计同一口径。 */
const beijingDay = sql<string>`date_format(date_add(${gameRecord.endedAt}, interval 8 hour), '%Y-%m-%d')`;

export class DatabaseGameRecordRepository implements GameRecordRepository {
  constructor(private readonly database: Database) {}

  async insert(record: StoredGameRecord): Promise<void> {
    await this.database.ready;
    await this.database.db.transaction(async (tx) => {
      await tx.insert(gameRecord).values({
        id: record.id,
        game: record.game,
        roomId: record.roomId,
        roundNumber: record.roundNumber,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        playerCount: record.players.length,
        summary: record.summary,
        timeline: record.timeline,
      });
      if (record.players.length) {
        await tx.insert(gameRecordPlayer).values(record.players.map((player) => ({ recordId: record.id, ...player })));
      }
    });
  }

  async purge(before: Date, batch: number): Promise<number> {
    await this.database.ready;
    const ids = (await this.database.db.select({ id: gameRecord.id }).from(gameRecord)
      .where(lt(gameRecord.endedAt, before)).limit(batch)).map((row) => row.id);
    if (!ids.length) return 0;
    await this.database.db.transaction(async (tx) => {
      await tx.delete(gameRecordPlayer).where(inArray(gameRecordPlayer.recordId, ids));
      await tx.delete(gameRecord).where(inArray(gameRecord.id, ids));
    });
    return ids.length;
  }

  async list(filter: GameRecordFilter): Promise<{ items: GameRecordListItem[]; total: number }> {
    await this.database.ready;
    const conditions: SQL[] = [];
    if (filter.game) conditions.push(eq(gameRecord.game, filter.game));
    if (filter.roomId) conditions.push(eq(gameRecord.roomId, filter.roomId));
    if (filter.since) conditions.push(gte(gameRecord.endedAt, filter.since));
    if (filter.userId) {
      conditions.push(inArray(gameRecord.id, this.database.db.select({ id: gameRecordPlayer.recordId })
        .from(gameRecordPlayer).where(eq(gameRecordPlayer.userId, filter.userId))));
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const columns = {
      id: gameRecord.id, game: gameRecord.game, roomId: gameRecord.roomId, roundNumber: gameRecord.roundNumber,
      startedAt: gameRecord.startedAt, endedAt: gameRecord.endedAt,
    };
    const [rows, [count]] = await Promise.all([
      this.database.db.select(columns).from(gameRecord).where(where)
        .orderBy(desc(gameRecord.endedAt)).limit(filter.limit).offset(filter.offset),
      this.database.db.select({ total: sql<number>`count(*)` }).from(gameRecord).where(where),
    ]);
    const players = await this.playersOf(rows.map((row) => row.id));
    return {
      items: rows.map((row) => ({ ...row, game: row.game as RecordedGame, players: players.get(row.id) ?? [] })),
      total: Number(count?.total ?? 0),
    };
  }

  async get(id: string): Promise<StoredGameRecord | null> {
    await this.database.ready;
    const [row] = await this.database.db.select().from(gameRecord).where(eq(gameRecord.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id,
      game: row.game as RecordedGame,
      roomId: row.roomId,
      roundNumber: row.roundNumber,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      players: (await this.playersOf([id])).get(id) ?? [],
      summary: row.summary as Record<string, unknown>,
      timeline: row.timeline as GameRecordEvent[],
    };
  }

  async dailyCounts(since: Date): Promise<GameDailyCount[]> {
    await this.database.ready;
    const rows = await this.database.db.select({
      day: beijingDay,
      game: gameRecord.game,
      rounds: sql<number>`count(distinct ${gameRecord.id})`,
      players: sql<number>`count(${gameRecordPlayer.playerId})`,
      accounts: sql<number>`count(distinct ${gameRecordPlayer.userId})`,
    }).from(gameRecord)
      .leftJoin(gameRecordPlayer, eq(gameRecordPlayer.recordId, gameRecord.id))
      .where(gte(gameRecord.endedAt, since))
      .groupBy(beijingDay, gameRecord.game)
      .orderBy(beijingDay);
    return rows.map((row) => ({
      day: row.day,
      game: row.game as RecordedGame,
      rounds: Number(row.rounds),
      players: Number(row.players),
      accounts: Number(row.accounts),
    }));
  }

  private async playersOf(ids: string[]): Promise<Map<string, GameRecordPlayer[]>> {
    const result = new Map<string, GameRecordPlayer[]>();
    if (!ids.length) return result;
    const rows = await this.database.db.select().from(gameRecordPlayer).where(inArray(gameRecordPlayer.recordId, ids));
    for (const { recordId, ...player } of rows) {
      const list = result.get(recordId) ?? [];
      list.push(player);
      result.set(recordId, list);
    }
    for (const list of result.values()) list.sort((a, b) => b.score - a.score);
    return result;
  }
}
