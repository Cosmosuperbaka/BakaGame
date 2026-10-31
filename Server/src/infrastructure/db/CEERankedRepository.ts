import { and, desc, eq, getTableColumns, isNotNull, isNull, lt, ne, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";

import type { CEEGuessClientType } from "../../application/CEEAntiCheatSignals";
import type { CEERankedBotSample } from "../../application/CEERankedHandicap";
import type {
  CEERankedGameRecord,
  CEERankedGuessRecord,
  CEERankedHistoryRecord,
  CEERankedRatingRecord,
  CEERankedSeriesAudit,
  CEERankedSeriesPlayerRecord,
  CEERankedSeriesRecord,
  CEERankedSettlementRecord,
  CEERankedStore,
} from "../../application/CEERankedStore";
import type { Database } from "./Database";
import {
  ceeRankedGame,
  ceeRankedGuess,
  ceeRankedRating,
  ceeRankedSeries,
  ceeRankedSeriesPlayer,
} from "./Schema";

/** 猜测单批最多行数：上千行的单条 INSERT 语句过长，分批发出去更稳。 */
const GUESS_BATCH_SIZE = 500;

/** 历史列表里对手那一行，与本人行同表不同席位。 */
const opponent = alias(ceeRankedSeriesPlayer, "opponent");

const msOf = (value: Date | null | undefined): number | null => (value ? value.getTime() : null);
const dateOf = (value: number | null): Date | null => (value === null ? null : new Date(value));

const toSeries = (row: typeof ceeRankedSeries.$inferSelect): CEERankedSeriesRecord => ({
  id: row.id,
  ruleset: row.ruleset,
  tier: row.tier,
  answerIds: row.answerIds as number[],
  startedAt: row.startedAt.getTime(),
  endedAt: row.endedAt.getTime(),
  endReason: row.endReason as CEERankedSeriesRecord["endReason"],
  rated: row.rated,
  unratedReason: row.unratedReason,
  bot: row.bot,
  botEntry: row.botEntry as CEERankedSeriesRecord["botEntry"],
});

const toPlayer = (row: typeof ceeRankedSeriesPlayer.$inferSelect): CEERankedSeriesPlayerRecord => ({
  seat: row.seat as 0 | 1,
  userId: row.userId,
  name: row.name,
  clientType: row.clientType as CEEGuessClientType | null,
  clientVersion: row.clientVersion,
  botPersona: row.botPersona,
  botTargetRating: row.botTargetRating,
  botStrengthRating: row.botStrengthRating,
  queueWaitMs: row.queueWaitMs,
  points: row.points,
  score: row.score as CEERankedSeriesPlayerRecord["score"],
  placement: row.placement,
  ratingBefore: row.ratingBefore,
  ratingAfter: row.ratingAfter,
  rdBefore: row.rdBefore,
  rdAfter: row.rdAfter,
});

const toGame = (row: typeof ceeRankedGame.$inferSelect): CEERankedGameRecord => ({
  number: row.number,
  answerCharacterId: row.answerCharacterId,
  answerName: row.answerName,
  winnerSeat: row.winnerSeat === null ? null : (row.winnerSeat as 0 | 1),
  endReason: row.endReason as CEERankedGameRecord["endReason"],
  attempts: [row.attempts0, row.attempts1],
  overtime: row.overtime,
  startedAt: row.startedAt.getTime(),
  endedAt: row.endedAt.getTime(),
});

const toGuess = (row: typeof ceeRankedGuess.$inferSelect): CEERankedGuessRecord => ({
  gameNumber: row.gameNumber,
  seat: row.seat as 0 | 1,
  attempt: row.attempt,
  characterId: row.characterId,
  characterName: row.characterName,
  correct: row.correct,
  createdAt: row.createdAt.getTime(),
  clientType: row.clientType as CEEGuessClientType | null,
  searchedAt: msOf(row.searchedAt),
  searchMatched: row.searchMatched,
});

const toRating = (row: typeof ceeRankedRating.$inferSelect): CEERankedRatingRecord => ({
  userId: row.userId,
  rating: row.rating,
  rd: row.rd,
  seriesPlayed: row.seriesPlayed,
  wins: row.wins,
  losses: row.losses,
  draws: row.draws,
  botRatedDay: row.botRatedDay,
  botRatedCount: row.botRatedCount,
  lastPlayedAt: msOf(row.lastPlayedAt),
});

/** 按批大小切开；空数组返回空列表，调用方据此跳过语句。 */
const inBatches = <T>(items: readonly T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    batches.push(items.slice(index, index + size));
  return batches;
};

/**
 * 排位审计的 MySQL 适配。写路径只有「一场结算的全部行 + 评级 upsert」，在一个事务里完成；
 * 任何一条失败都抛出，由调用方决定重试。
 */
export class CEERankedRepository implements CEERankedStore {
  constructor(private readonly database: Database) {}

  async getRating(userId: string): Promise<CEERankedRatingRecord | null> {
    await this.database.ready;
    const [row] = await this.database.db
      .select()
      .from(ceeRankedRating)
      .where(eq(ceeRankedRating.userId, userId))
      .limit(1);
    return row ? toRating(row) : null;
  }

  async saveSettlement(record: CEERankedSettlementRecord): Promise<void> {
    await this.database.ready;
    const seriesId = record.series.id;
    await this.database.db.transaction(async (tx) => {
      await tx.insert(ceeRankedSeries).values({
        ...record.series,
        startedAt: new Date(record.series.startedAt),
        endedAt: new Date(record.series.endedAt),
      });
      await tx
        .insert(ceeRankedSeriesPlayer)
        .values(record.players.map((player) => ({ seriesId, ...player })));
      if (record.games.length > 0) {
        await tx.insert(ceeRankedGame).values(
          record.games.map((game) => ({
            seriesId,
            number: game.number,
            answerCharacterId: game.answerCharacterId,
            answerName: game.answerName,
            winnerSeat: game.winnerSeat,
            endReason: game.endReason,
            attempts0: game.attempts[0],
            attempts1: game.attempts[1],
            overtime: game.overtime,
            startedAt: new Date(game.startedAt),
            endedAt: new Date(game.endedAt),
          }))
        );
      }
      for (const batch of inBatches(record.guesses, GUESS_BATCH_SIZE)) {
        await tx.insert(ceeRankedGuess).values(
          batch.map((guess) => ({
            seriesId,
            gameNumber: guess.gameNumber,
            seat: guess.seat,
            attempt: guess.attempt,
            characterId: guess.characterId,
            characterName: guess.characterName,
            correct: guess.correct,
            createdAt: new Date(guess.createdAt),
            clientType: guess.clientType,
            searchedAt: dateOf(guess.searchedAt),
            searchMatched: guess.searchMatched,
          }))
        );
      }
      for (const rating of record.ratings) {
        await tx
          .insert(ceeRankedRating)
          .values({ ...rating, lastPlayedAt: dateOf(rating.lastPlayedAt) })
          .onDuplicateKeyUpdate({
            set: {
              rating: rating.rating,
              rd: rating.rd,
              seriesPlayed: rating.seriesPlayed,
              wins: rating.wins,
              losses: rating.losses,
              draws: rating.draws,
              botRatedDay: rating.botRatedDay,
              botRatedCount: rating.botRatedCount,
              lastPlayedAt: dateOf(rating.lastPlayedAt),
            },
          });
      }
    });
  }

  async listHistory(userId: string, limit: number): Promise<CEERankedHistoryRecord[]> {
    await this.database.ready;
    const capped = Math.min(Math.max(limit, 1), 50);
    const rows = await this.database.db
      .select({
        seriesId: ceeRankedSeries.id,
        endedAt: ceeRankedSeries.endedAt,
        tier: ceeRankedSeries.tier,
        rated: ceeRankedSeries.rated,
        opponentName: opponent.name,
        opponentUserId: opponent.userId,
        opponentBotPersona: opponent.botPersona,
        opponentPoints: opponent.points,
        selfPoints: ceeRankedSeriesPlayer.points,
        score: ceeRankedSeriesPlayer.score,
        placement: ceeRankedSeriesPlayer.placement,
        ratingBefore: ceeRankedSeriesPlayer.ratingBefore,
        ratingAfter: ceeRankedSeriesPlayer.ratingAfter,
      })
      .from(ceeRankedSeriesPlayer)
      .innerJoin(ceeRankedSeries, eq(ceeRankedSeriesPlayer.seriesId, ceeRankedSeries.id))
      .innerJoin(
        opponent,
        and(
          eq(opponent.seriesId, ceeRankedSeriesPlayer.seriesId),
          ne(opponent.seat, ceeRankedSeriesPlayer.seat)
        )
      )
      .where(eq(ceeRankedSeriesPlayer.userId, userId))
      .orderBy(desc(ceeRankedSeries.endedAt))
      .limit(capped);
    return rows.map((row) => ({
      seriesId: row.seriesId,
      endedAt: row.endedAt.getTime(),
      tier: row.tier,
      rated: row.rated,
      opponentName: row.opponentName,
      // 人机席位没有账号 ID，但有 persona；注销掉账号的真人对手不会被误判成机器人。
      opponentIsBot: row.opponentUserId === null && row.opponentBotPersona !== null,
      selfPoints: row.selfPoints,
      opponentPoints: row.opponentPoints,
      score: row.score as CEERankedHistoryRecord["score"],
      placement: row.placement,
      ratingBefore: row.ratingBefore,
      ratingAfter: row.ratingAfter,
    }));
  }

  async listSeriesByUser(
    userId: string,
    limit: number,
    before?: number
  ): Promise<CEERankedSeriesRecord[]> {
    await this.database.ready;
    const capped = Math.min(Math.max(limit, 1), 100);
    const conditions: SQL[] = [eq(ceeRankedSeriesPlayer.userId, userId)];
    if (before !== undefined) conditions.push(lt(ceeRankedSeries.endedAt, new Date(before)));
    const rows = await this.database.db
      .select(getTableColumns(ceeRankedSeries))
      .from(ceeRankedSeries)
      .innerJoin(ceeRankedSeriesPlayer, eq(ceeRankedSeriesPlayer.seriesId, ceeRankedSeries.id))
      .where(and(...conditions))
      .orderBy(desc(ceeRankedSeries.endedAt))
      .limit(capped);
    return rows.map(toSeries);
  }

  async getSeriesAudit(seriesId: string): Promise<CEERankedSeriesAudit | null> {
    await this.database.ready;
    const [series] = await this.database.db
      .select()
      .from(ceeRankedSeries)
      .where(eq(ceeRankedSeries.id, seriesId))
      .limit(1);
    if (!series) return null;
    const [playerRows, gameRows, guessRows] = await Promise.all([
      this.database.db
        .select()
        .from(ceeRankedSeriesPlayer)
        .where(eq(ceeRankedSeriesPlayer.seriesId, seriesId))
        .orderBy(ceeRankedSeriesPlayer.seat),
      this.database.db
        .select()
        .from(ceeRankedGame)
        .where(eq(ceeRankedGame.seriesId, seriesId))
        .orderBy(ceeRankedGame.number),
      this.database.db
        .select()
        .from(ceeRankedGuess)
        .where(eq(ceeRankedGuess.seriesId, seriesId))
        .orderBy(
          ceeRankedGuess.gameNumber,
          ceeRankedGuess.createdAt,
          ceeRankedGuess.seat,
          ceeRankedGuess.attempt
        ),
    ]);
    return {
      series: toSeries(series),
      players: playerRows.map(toPlayer),
      games: gameRows.map(toGame),
      guesses: guessRows.map(toGuess),
    };
  }

  async listRecentBotSamples(limit: number): Promise<CEERankedBotSample[]> {
    await this.database.ready;
    const capped = Math.min(Math.max(limit, 1), 1_000);
    const rows = await this.database.db
      .select({
        botPersona: opponent.botPersona,
        botStrengthRating: opponent.botStrengthRating,
        playerRating: ceeRankedSeriesPlayer.ratingBefore,
        playerRd: ceeRankedSeriesPlayer.rdBefore,
        score: ceeRankedSeriesPlayer.score,
      })
      .from(ceeRankedSeriesPlayer)
      .innerJoin(ceeRankedSeries, eq(ceeRankedSeriesPlayer.seriesId, ceeRankedSeries.id))
      .innerJoin(
        opponent,
        and(
          eq(opponent.seriesId, ceeRankedSeriesPlayer.seriesId),
          ne(opponent.seat, ceeRankedSeriesPlayer.seat)
        )
      )
      .where(
        and(
          eq(ceeRankedSeries.bot, true),
          eq(ceeRankedSeries.rated, true),
          isNotNull(ceeRankedSeriesPlayer.userId),
          isNull(opponent.userId),
          isNotNull(opponent.botPersona),
          isNotNull(opponent.botStrengthRating),
          isNotNull(ceeRankedSeriesPlayer.ratingBefore),
          isNotNull(ceeRankedSeriesPlayer.rdBefore)
        )
      )
      .orderBy(desc(ceeRankedSeries.endedAt))
      .limit(capped);
    const samples: CEERankedBotSample[] = [];
    for (const row of rows) {
      const { playerRating, playerRd, botStrengthRating } = row;
      if (playerRating === null || playerRd === null || botStrengthRating === null) continue;
      samples.push({
        group: row.botPersona === "aiga" ? "aiga" : "regular",
        playerRating,
        playerRd,
        strengthRating: botStrengthRating,
        score: row.score as CEERankedBotSample["score"],
      });
    }
    return samples;
  }
}
