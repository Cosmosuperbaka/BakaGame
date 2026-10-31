import type { CEEGuessClientType } from "./CEEAntiCheatSignals";
import type { CEERankedBotSample } from "./CEERankedHandicap";

/**
 * 排位审计的存储端口：一场系列赛（三局两胜）结算后的全部流水。
 *
 * 与通用对局记录分开，只写不改不删；只有评级一行是 upsert。写失败一律抛出，
 * 由调用方重试——审计缺一条比多一条更难解释。
 */

export interface CEERankedRatingRecord {
  userId: string;
  rating: number;
  rd: number;
  seriesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  /** 人机计分所在的北京自然日，`YYYY-MM-DD`；当天没打过人机为空。 */
  botRatedDay: string | null;
  botRatedCount: number;
  lastPlayedAt: number | null;
}

export type CEERankedSeriesEndReasonRecord = "completed" | "exit" | "offline";
export type CEERankedGameEndReasonRecord = "solved" | "surrender" | "draw";

export interface CEERankedSeriesRecord {
  id: string;
  ruleset: string;
  tier: string;
  answerIds: number[];
  startedAt: number;
  endedAt: number;
  endReason: CEERankedSeriesEndReasonRecord;
  rated: boolean;
  /** 不计分的原因，例如 "bot_daily_limit"；计分为 null。 */
  unratedReason: string | null;
  bot: boolean;
  /** placement：定级期直开的人机；manual/auto：排队后主动或兜底进人机。 */
  botEntry: "manual" | "auto" | "placement" | null;
}

export interface CEERankedSeriesPlayerRecord {
  seat: 0 | 1;
  /** 人机席位为 null；真人账号注销后也置空，行本身保留。 */
  userId: string | null;
  name: string;
  clientType: CEEGuessClientType | null;
  clientVersion: string | null;
  botPersona: string | null;
  botTargetRating: number | null;
  /** 生成人机强度（爱噶则含思考时长）时真正用的分数；与计分的 botTargetRating 可差一个校准偏差。 */
  botStrengthRating: number | null;
  queueWaitMs: number | null;
  points: number;
  score: 0 | 0.5 | 1;
  placement: boolean;
  ratingBefore: number | null;
  ratingAfter: number | null;
  rdBefore: number | null;
  rdAfter: number | null;
}

export interface CEERankedGameRecord {
  number: number;
  answerCharacterId: number;
  answerName: string;
  /** 平局或未完成的一局没有胜方。 */
  winnerSeat: 0 | 1 | null;
  endReason: CEERankedGameEndReasonRecord;
  /** 两个席位各自的出手次数。 */
  attempts: [number, number];
  overtime: boolean;
  startedAt: number;
  endedAt: number;
}

export interface CEERankedGuessRecord {
  gameNumber: number;
  seat: 0 | 1;
  attempt: number;
  characterId: number;
  characterName: string;
  correct: boolean;
  createdAt: number;
  clientType: CEEGuessClientType | null;
  /** 该次出手前最近一次角色检索的时刻与命中情况；从未检索时两者为 null。 */
  searchedAt: number | null;
  searchMatched: boolean | null;
}

export interface CEERankedSettlementRecord {
  series: CEERankedSeriesRecord;
  players: [CEERankedSeriesPlayerRecord, CEERankedSeriesPlayerRecord];
  games: CEERankedGameRecord[];
  guesses: CEERankedGuessRecord[];
  /** 需要写回的真人评级（0～2 行）。 */
  ratings: CEERankedRatingRecord[];
}

export interface CEERankedHistoryRecord {
  seriesId: string;
  endedAt: number;
  tier: string;
  rated: boolean;
  opponentName: string;
  opponentIsBot: boolean;
  selfPoints: number;
  opponentPoints: number;
  score: 0 | 0.5 | 1;
  placement: boolean;
  ratingBefore: number | null;
  ratingAfter: number | null;
}

export interface CEERankedSeriesAudit {
  series: CEERankedSeriesRecord;
  players: CEERankedSeriesPlayerRecord[];
  games: CEERankedGameRecord[];
  guesses: CEERankedGuessRecord[];
}

export interface CEERankedStore {
  getRating(userId: string): Promise<CEERankedRatingRecord | null>;
  /** 单事务写入一场系列赛的全部审计行并 upsert 评级；失败抛出。 */
  saveSettlement(record: CEERankedSettlementRecord): Promise<void>;
  /** 本账号最近的系列赛，按结束时间倒序；limit 夹到 [1, 50]。 */
  listHistory(userId: string, limit: number): Promise<CEERankedHistoryRecord[]>;
  /** 审计：本账号参与过的系列赛，按结束时间倒序；before 给定时只取结束时间早于它的；limit 夹到 [1, 100]。 */
  listSeriesByUser(
    userId: string,
    limit: number,
    before?: number
  ): Promise<CEERankedSeriesRecord[]>;
  /** 审计：一场系列赛的全部行；不存在为 null。games 按局号、guesses 按 (局号, 出手时刻, 席位, 第几次) 排序。 */
  getSeriesAudit(seriesId: string): Promise<CEERankedSeriesAudit | null>;
  /** 人机校准样本：只取计分时的人机系列赛，按结束时间倒序；limit 夹到 [1, 1000]。 */
  listRecentBotSamples(limit: number): Promise<CEERankedBotSample[]>;
}

/** 测试与无库夹具用的内存实现，语义与 MySQL 适配一致（含 upsert 与历史推导）。 */
export class InMemoryCEERankedStore implements CEERankedStore {
  private readonly ratings = new Map<string, CEERankedRatingRecord>();
  private readonly settled: CEERankedSettlementRecord[] = [];

  async getRating(userId: string): Promise<CEERankedRatingRecord | null> {
    const rating = this.ratings.get(userId);
    return rating ? { ...rating } : null;
  }

  async saveSettlement(record: CEERankedSettlementRecord): Promise<void> {
    this.settled.push(copySettlement(record));
    for (const rating of record.ratings) this.ratings.set(rating.userId, { ...rating });
  }

  async listHistory(userId: string, limit: number): Promise<CEERankedHistoryRecord[]> {
    const capped = Math.min(Math.max(limit, 1), 50);
    const rows: CEERankedHistoryRecord[] = [];
    for (const item of this.byEndedAtDesc()) {
      const self = item.players.find((player) => player.userId === userId);
      const opponent = item.players.find(
        (player) => self !== undefined && player.seat !== self.seat
      );
      if (!self || !opponent) continue;
      rows.push({
        seriesId: item.series.id,
        endedAt: item.series.endedAt,
        tier: item.series.tier,
        rated: item.series.rated,
        opponentName: opponent.name,
        opponentIsBot: opponent.userId === null && opponent.botPersona !== null,
        selfPoints: self.points,
        opponentPoints: opponent.points,
        score: self.score,
        placement: self.placement,
        ratingBefore: self.ratingBefore,
        ratingAfter: self.ratingAfter,
      });
      if (rows.length === capped) break;
    }
    return rows;
  }

  async listSeriesByUser(
    userId: string,
    limit: number,
    before?: number
  ): Promise<CEERankedSeriesRecord[]> {
    const capped = Math.min(Math.max(limit, 1), 100);
    return this.byEndedAtDesc()
      .filter(
        (item) =>
          item.players.some((player) => player.userId === userId) &&
          (before === undefined || item.series.endedAt < before)
      )
      .slice(0, capped)
      .map((item) => item.series);
  }

  async getSeriesAudit(seriesId: string): Promise<CEERankedSeriesAudit | null> {
    const item = this.settled.find((entry) => entry.series.id === seriesId);
    if (!item) return null;
    return {
      series: item.series,
      players: item.players,
      games: [...item.games].sort((a, b) => a.number - b.number),
      guesses: [...item.guesses].sort(
        (a, b) =>
          a.gameNumber - b.gameNumber ||
          a.createdAt - b.createdAt ||
          a.seat - b.seat ||
          a.attempt - b.attempt
      ),
    };
  }

  async listRecentBotSamples(limit: number): Promise<CEERankedBotSample[]> {
    const capped = Math.min(Math.max(limit, 1), 1_000);
    const rows: CEERankedBotSample[] = [];
    for (const item of this.byEndedAtDesc()) {
      if (!item.series.bot || !item.series.rated) continue;
      const sample = ceeRankedBotSampleOf(item.players);
      if (!sample) continue;
      rows.push(sample);
      if (rows.length === capped) break;
    }
    return rows;
  }

  private byEndedAtDesc(): CEERankedSettlementRecord[] {
    return [...this.settled].sort((a, b) => b.series.endedAt - a.series.endedAt);
  }
}

/** 存副本：调用方复用同一个对象结算下一场时，不能改写已经落进去的历史。 */
const copySettlement = (record: CEERankedSettlementRecord): CEERankedSettlementRecord => ({
  series: { ...record.series, answerIds: [...record.series.answerIds] },
  players: [{ ...record.players[0] }, { ...record.players[1] }],
  games: record.games.map((game) => ({
    ...game,
    attempts: [game.attempts[0], game.attempts[1]],
  })),
  guesses: record.guesses.map((guess) => ({ ...guess })),
  ratings: record.ratings.map((rating) => ({ ...rating })),
});

/**
 * 从一场人机系列赛的两个席位还原校准样本。
 *
 * 校准要的是「赛前分 vs 实际战绩」，缺赛前 μ/φ 或旧数据没有强度列的行一律不参与。
 */
export function ceeRankedBotSampleOf(
  players: readonly CEERankedSeriesPlayerRecord[]
): CEERankedBotSample | null {
  const bot = players.find((player) => player.userId === null);
  const human = players.find((player) => player.userId !== null);
  if (!bot || !human || bot.botPersona === null) return null;
  if (human.ratingBefore === null || human.rdBefore === null || bot.botStrengthRating === null)
    return null;
  return {
    group: bot.botPersona === "aiga" ? "aiga" : "regular",
    playerRating: human.ratingBefore,
    playerRd: human.rdBefore,
    strengthRating: bot.botStrengthRating,
    score: human.score,
  };
}
