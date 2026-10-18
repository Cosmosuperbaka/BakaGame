import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";

import type { GameRecordEvent, GameRecordPlayer, RecordedGame } from "../../domain/GameRecord";
import type { Database } from "./Database";
import { gameRecord, gameRecordPlayer, gameRecordRound } from "./Schema";

/** 一局：一个房间从创建到销毁。玩家行是本局累计总分。 */
export interface StoredGameRecord {
  id: string;
  game: RecordedGame;
  roomId: string;
  roundCount: number;
  startedAt: Date;
  endedAt: Date;
  players: GameRecordPlayer[];
}

/** 局内一个回合：玩家行为本回合得分增量。 */
export interface StoredGameRecordRound {
  number: number;
  startedAt: Date;
  endedAt: Date;
  players: GameRecordPlayer[];
  summary: Record<string, unknown>;
  timeline: GameRecordEvent[];
}

export interface StoredGameRecordDetail extends StoredGameRecord {
  rounds: StoredGameRecordRound[];
}

export type GameRecordListItem = StoredGameRecord;

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
  /** 一局数：一个房间从创建到销毁算一局。 */
  games: number;
  /** 参与人次：每局按去重玩家数累加。 */
  players: number;
  /** 去重后的登录玩家数。 */
  accounts: number;
}

export interface GameRecordRepository {
  /**
   * 写入一局的最新聚合状态。`round` 非空时在同一事务里落这一回合：
   * 先保证房间行存在，再写回合，避免外键悬空。
   */
  save(record: StoredGameRecord, round?: StoredGameRecordRound): Promise<void>;
  list(filter: GameRecordFilter): Promise<{ items: GameRecordListItem[]; total: number }>;
  get(id: string): Promise<StoredGameRecordDetail | null>;
  dailyCounts(since: Date): Promise<GameDailyCount[]>;
}

/** UTC 落库时间 → 北京时间自然日；与站点访问统计同一口径。 */
const beijingDay = sql<string>`date_format(date_add(${gameRecord.endedAt}, interval 8 hour), '%Y-%m-%d')`;

export class DatabaseGameRecordRepository implements GameRecordRepository {
  constructor(private readonly database: Database) {}

  async save(record: StoredGameRecord, round?: StoredGameRecordRound): Promise<void> {
    await this.database.ready;
    await this.database.db.transaction(async (tx) => {
      await tx
        .insert(gameRecord)
        .values({
          id: record.id,
          game: record.game,
          roomId: record.roomId,
          roundCount: record.roundCount,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
          playerCount: record.players.length,
        })
        .onDuplicateKeyUpdate({
          // 会话身份（id / game / room_id / started_at）不随回合变化，只更新聚合态。
          set: {
            roundCount: record.roundCount,
            endedAt: record.endedAt,
            playerCount: record.players.length,
          },
        });
      await tx.delete(gameRecordPlayer).where(eq(gameRecordPlayer.recordId, record.id));
      if (record.players.length) {
        await tx
          .insert(gameRecordPlayer)
          .values(record.players.map((player) => ({ recordId: record.id, ...player })));
      }
      if (round) {
        const values = {
          recordId: record.id,
          number: round.number,
          startedAt: round.startedAt,
          endedAt: round.endedAt,
          playerCount: round.players.length,
          players: round.players,
          summary: round.summary,
          timeline: round.timeline,
        };
        await tx
          .insert(gameRecordRound)
          .values(values)
          .onDuplicateKeyUpdate({
            set: {
              startedAt: values.startedAt,
              endedAt: values.endedAt,
              playerCount: values.playerCount,
              players: values.players,
              summary: values.summary,
              timeline: values.timeline,
            },
          });
      }
    });
  }

  async list(filter: GameRecordFilter): Promise<{ items: GameRecordListItem[]; total: number }> {
    await this.database.ready;
    const conditions: SQL[] = [];
    if (filter.game) conditions.push(eq(gameRecord.game, filter.game));
    if (filter.roomId) conditions.push(eq(gameRecord.roomId, filter.roomId));
    if (filter.since) conditions.push(gte(gameRecord.endedAt, filter.since));
    if (filter.userId) {
      conditions.push(
        inArray(
          gameRecord.id,
          this.database.db
            .select({ id: gameRecordPlayer.recordId })
            .from(gameRecordPlayer)
            .where(eq(gameRecordPlayer.userId, filter.userId))
        )
      );
    }
    const where = conditions.length ? and(...conditions) : undefined;
    const columns = {
      id: gameRecord.id,
      game: gameRecord.game,
      roomId: gameRecord.roomId,
      roundCount: gameRecord.roundCount,
      startedAt: gameRecord.startedAt,
      endedAt: gameRecord.endedAt,
    };
    const [rows, [count]] = await Promise.all([
      this.database.db
        .select(columns)
        .from(gameRecord)
        .where(where)
        .orderBy(desc(gameRecord.endedAt))
        .limit(filter.limit)
        .offset(filter.offset),
      this.database.db
        .select({ total: sql<number>`count(*)` })
        .from(gameRecord)
        .where(where),
    ]);
    const players = await this.playersOf(rows.map((row) => row.id));
    return {
      items: rows.map((row) => ({
        ...row,
        game: row.game as RecordedGame,
        players: players.get(row.id) ?? [],
      })),
      total: Number(count?.total ?? 0),
    };
  }

  async get(id: string): Promise<StoredGameRecordDetail | null> {
    await this.database.ready;
    const [row] = await this.database.db
      .select()
      .from(gameRecord)
      .where(eq(gameRecord.id, id))
      .limit(1);
    if (!row) return null;
    const rounds = await this.database.db
      .select()
      .from(gameRecordRound)
      .where(eq(gameRecordRound.recordId, id))
      .orderBy(gameRecordRound.number);
    return {
      id: row.id,
      game: row.game as RecordedGame,
      roomId: row.roomId,
      roundCount: row.roundCount,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      players: (await this.playersOf([id])).get(id) ?? [],
      rounds: rounds.map((round) => ({
        number: round.number,
        startedAt: round.startedAt,
        endedAt: round.endedAt,
        players: round.players as GameRecordPlayer[],
        summary: round.summary as Record<string, unknown>,
        timeline: round.timeline as GameRecordEvent[],
      })),
    };
  }

  async dailyCounts(since: Date): Promise<GameDailyCount[]> {
    await this.database.ready;
    const rows = await this.database.db
      .select({
        day: beijingDay,
        game: gameRecord.game,
        games: sql<number>`count(distinct ${gameRecord.id})`,
        players: sql<number>`count(${gameRecordPlayer.playerId})`,
        accounts: sql<number>`count(distinct ${gameRecordPlayer.userId})`,
      })
      .from(gameRecord)
      .leftJoin(gameRecordPlayer, eq(gameRecordPlayer.recordId, gameRecord.id))
      .where(gte(gameRecord.endedAt, since))
      .groupBy(beijingDay, gameRecord.game)
      .orderBy(beijingDay);
    return rows.map((row) => ({
      day: row.day,
      game: row.game as RecordedGame,
      games: Number(row.games),
      players: Number(row.players),
      accounts: Number(row.accounts),
    }));
  }

  private async playersOf(ids: string[]): Promise<Map<string, GameRecordPlayer[]>> {
    const result = new Map<string, GameRecordPlayer[]>();
    if (!ids.length) return result;
    const rows = await this.database.db
      .select()
      .from(gameRecordPlayer)
      .where(inArray(gameRecordPlayer.recordId, ids));
    for (const { recordId, ...player } of rows) {
      const list = result.get(recordId) ?? [];
      list.push(player);
      result.set(recordId, list);
    }
    for (const list of result.values()) list.sort((a, b) => b.score - a.score);
    return result;
  }
}
