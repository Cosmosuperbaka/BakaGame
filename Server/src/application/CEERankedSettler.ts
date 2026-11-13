// ==================== 排位结算写库 ====================
// 系列赛打完之后：先推「结算中」，算新评级与审计记录，带退避重试地写库，落定后记对手并推结果。
// 「结算中」的账号集合归这里：期间排队回 RANKED_SETTLING，落定（成功、彻底失败或抛错）才放开。
import type { CEERankedSeriesPlayerRecord, CEERankedSettlementRecord } from "./CEERankedStore";
import { ceeRankedBotSampleOf } from "./CEERankedStore";
import { ceeRankedSeriesScore } from "../domain/CEERankedSeries";
import type { CEERankedProfileQueries } from "./CEERankedProfileQueries";
import {
  errorMessageOf,
  pushSeries,
  requireStore,
  type CEERankedContext,
  type CEERankedSeriesRuntime,
} from "./CEERankedRuntime";
import {
  gameRecords,
  guessRecords,
  playerRecord,
  resolveRatings,
  seatRatingRecords,
  seriesRecord,
  settlementResults,
} from "./CEERankedSettlement";
import type { CEERankedSeatResultMeta } from "./CEERankedViews";

/** 每组每攒满这么多新样本打一次当前偏差，便于观察收敛。 */
const HANDICAP_LOG_EVERY = 20;
export class CEERankedSettler {
  private readonly ctx: CEERankedContext;
  private readonly profiles: CEERankedProfileQueries;
  /** 结算尚未落定的账号：期间 `queue` 回 RANKED_SETTLING。 */
  private readonly settling = new Set<string>();

  constructor(ctx: CEERankedContext, profiles: CEERankedProfileQueries) {
    this.ctx = ctx;
    this.profiles = profiles;
  }

  isSettling(userId: string): boolean {
    return this.settling.has(userId);
  }

  async settle(runtime: CEERankedSeriesRuntime): Promise<void> {
    const running = runtime.settling;
    if (running) return running;
    const work = this.doSettle(runtime);
    runtime.settling = work;
    try {
      await work;
    } finally {
      runtime.settling = null;
    }
  }

  private async doSettle(runtime: CEERankedSeriesRuntime): Promise<void> {
    const endedAt = runtime.series.endedAt ?? this.ctx.now();
    const userIds: string[] = [];
    for (const seat of runtime.seats) {
      if (seat.isBot || seat.userId === null) continue;
      userIds.push(seat.userId);
    }
    for (const userId of userIds) this.settling.add(userId);
    try {
      runtime.settlement = "pending";
      pushSeries(this.ctx, runtime);

      const outcome = await this.writeSettlement(runtime, endedAt);
      runtime.results = outcome.results;
      runtime.settlement = outcome.written ? (runtime.rated ? "rated" : "unrated") : "failed";
    } catch (error) {
      // 中途抛错也要落定：标记未计分并放开账号，否则账号会永远卡在「上一场还在结算」。
      runtime.settlement = "failed";
      throw error;
    } finally {
      runtime.settlementDone = true;
      for (const userId of userIds) this.settling.delete(userId);
    }
    this.rememberOpponents(runtime, endedAt);
    pushSeries(this.ctx, runtime);
  }

  /** 算新评级、组装审计、写库；返回视图要用的结果元数据。 */
  private async writeSettlement(
    runtime: CEERankedSeriesRuntime,
    endedAt: number
  ): Promise<{
    written: boolean;
    results: [CEERankedSeatResultMeta | null, CEERankedSeatResultMeta | null];
  }> {
    const scores: [0 | 0.5 | 1, 0 | 0.5 | 1] = [
      ceeRankedSeriesScore(runtime.series, 0),
      ceeRankedSeriesScore(runtime.series, 1),
    ];
    const rating = resolveRatings(runtime, scores, endedAt);
    const record: CEERankedSettlementRecord = {
      series: seriesRecord(runtime, endedAt),
      players: [
        playerRecord(runtime, 0, scores[0], rating.before[0], rating.after[0]),
        playerRecord(runtime, 1, scores[1], rating.before[1], rating.after[1]),
      ],
      games: gameRecords(runtime, endedAt),
      guesses: guessRecords(runtime),
      ratings: seatRatingRecords(runtime, rating.after, scores, endedAt),
    };
    const written = await this.saveWithRetry(record, runtime.series.id);
    if (!written) return { written: false, results: [null, null] };
    // 只有真写进审计的计分人机局才算校准样本：写库失败或人机不计分都不进窗口。
    if (runtime.rated && runtime.bot) this.rememberBotSample(record.players);
    return { written: true, results: settlementResults(runtime, rating) };
  }

  /** 记一笔人机校准样本，每组每满 20 条打一次当前偏差。 */
  private rememberBotSample(players: readonly CEERankedSeriesPlayerRecord[]): void {
    const sample = ceeRankedBotSampleOf(players);
    if (sample === null) return;
    this.ctx.handicap.add(sample);
    const samples = this.ctx.handicap.count(sample.group);
    if (samples % HANDICAP_LOG_EVERY !== 0) return;
    this.ctx.logger?.info("排位人机校准", {
      group: sample.group,
      bias: this.ctx.handicap.bias(sample.group),
      samples,
    });
  }

  private async saveWithRetry(
    record: CEERankedSettlementRecord,
    seriesId: string
  ): Promise<boolean> {
    const store = requireStore(this.ctx);
    const attempts = this.ctx.settleRetryDelaysMs.length + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await store.saveSettlement(record);
        // 分数变了：排行榜下次现查，刚打完的人看得到自己的新名次。
        this.profiles.invalidate();
        return true;
      } catch (error) {
        // 事务可能已提交而响应丢了：重试会撞主键。先确认这场是否已落库，已落库就当作成功。
        if (await this.alreadySaved(seriesId)) {
          this.profiles.invalidate();
          return true;
        }
        if (attempt + 1 >= attempts) {
          this.ctx.logger?.error("排位结算写库失败", {
            seriesId,
            record,
            error: errorMessageOf(error),
          });
          return false;
        }
        await this.wait(this.ctx.settleRetryDelaysMs[attempt] ?? 0);
      }
    }
    return false;
  }

  /** 审计里已有这场系列赛；读失败按「未落库」处理，交给重试。 */
  private async alreadySaved(seriesId: string): Promise<boolean> {
    try {
      return (await requireStore(this.ctx).getSeriesAudit(seriesId)) !== null;
    } catch (error) {
      this.ctx.logger?.warn("排位结算落库确认读取失败", { seriesId, error: errorMessageOf(error) });
      return false;
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (ms <= 0) {
        resolve();
        return;
      }
      let cancel: (() => void) | null = null;
      cancel = this.ctx.setTimer(() => {
        if (cancel) cancel();
        resolve();
      }, ms);
    });
  }

  /** 记下上一场对手与人格，供下一次排队避开。 */
  private rememberOpponents(runtime: CEERankedSeriesRuntime, at: number): void {
    for (const index of [0, 1] as const) {
      const self = runtime.seats[index];
      const other = runtime.seats[index === 0 ? 1 : 0];
      if (self.isBot || self.userId === null) continue;
      if (other.isBot) {
        const spec = runtime.botSpec;
        if (spec !== null) this.ctx.lastPersona.set(self.userId, { id: spec.persona.id, at });
      } else if (other.userId !== null)
        this.ctx.lastOpponent.set(self.userId, { userId: other.userId, at });
    }
  }
}
