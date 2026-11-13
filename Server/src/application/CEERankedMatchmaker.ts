// ==================== 排位撮合与开赛 ====================
// 排队、取消、选人机、匹配跳与开赛编排。「匹配中」的在途集合与排队相关的几张表都归这里，
// 与结算、门面之间只通过窄接口（是否结算中、离开结果页、重排计时器）往来，不共享可变引用。
import type { CEECharacterView } from "../shared/Index";
import {
  CEE_RANKED_BOT_FALLBACK_MS,
  CEE_RANKED_BOT_OPTION_MS,
  CEE_RANKED_PLACEMENT_SERIES,
  CEE_RANKED_SERIES_GAMES,
  CEE_RANKED_SERIES_MAX_GAMES,
  ceeRankedTierFor,
  type CEERankedState,
  type CEERankedTier,
} from "../shared/CEERanked";
import { AppError } from "../domain/Errors";
import { createCEERankedSeries, setCEERankedSeatOnline } from "../domain/CEERankedSeries";
import { conservativeCEERating } from "../domain/CEERankedRating";
import {
  ceeRankedBotStrength,
  pickCEERankedPersona,
  type CEERankedPersonaId,
} from "../domain/CEERankedBotProfile";
import type { CEERankedCandidate } from "../domain/CEERankedSolver";
import { ceeClientTypeOf } from "./CEEAntiCheatSignals";
import type { CEERankedBotGroup } from "./CEERankedHandicap";
import type { CEERankedPool } from "./CEERankedPool";
import { CEERankedQueue, ceeRankedWindow, type CEERankedQueueEntry } from "./CEERankedQueue";
import {
  connectionFor,
  errorMessageOf,
  idleState,
  pushSeries,
  pushState,
  requirePool,
  requireStore,
  type CEERankedBotEntry,
  type CEERankedBotSpec,
  type CEERankedContext,
  type CEERankedSeatRuntime,
  type CEERankedSeriesRuntime,
} from "./CEERankedRuntime";
import { initialRatingRecord, shouldRateBotSeries, toRating } from "./CEERankedSettlement";
import type { CEERankedRatingRecord } from "./CEERankedStore";

/** 撮合向门面要的三件事：账号是否还在结算、替玩家离开结果页、开出系列赛后重排计时器。 */
export interface CEERankedMatchHost {
  isSettling(userId: string): boolean;
  forgetSeries(runtime: CEERankedSeriesRuntime, userId: string): void;
  scheduleTimer(runtime: CEERankedSeriesRuntime): void;
}

/** 匹配跳周期：1 秒一跳，只在队列非空时运行。 */
const MATCH_TICK_MS = 1_000;
/** 缺省昵称解析失败时的显示名。 */
const FALLBACK_NAME = "玩家";

export class CEERankedMatchmaker {
  private readonly ctx: CEERankedContext;
  private readonly host: CEERankedMatchHost;
  private readonly queue = new CEERankedQueue();
  /** 账号 → 最近一次推送的排队窗口：窗口没变就不重复推。 */
  private readonly pushedWindow = new Map<string, number>();
  /** 正在开赛的账号：异步组装题库与昵称期间，`queue` 报忙、`cancel` 无效。 */
  private readonly starting = new Set<string>();
  private matchCancel: (() => void) | null = null;
  private closed = false;

  constructor(ctx: CEERankedContext, host: CEERankedMatchHost) {
    this.ctx = ctx;
    this.host = host;
  }

  /** 关停：不再排匹配跳，已排的那一跳取消。 */
  close(): void {
    this.closed = true;
    if (this.matchCancel) {
      this.matchCancel();
      this.matchCancel = null;
    }
  }

  /** 兜底巡检：队列非空但匹配计时器断了就重排。 */
  ensureTick(): void {
    if (this.queue.size > 0 && !this.matchCancel) this.scheduleMatchTick();
  }

  /** 连接断开：还在排队就移出队列。 */
  dropFromQueue(userId: string): void {
    if (this.queue.remove(userId)) this.pushedWindow.delete(userId);
  }

  /** 该账号正在排队时的状态帧；不在队列里返回 null。 */
  queuedSnapshot(userId: string): CEERankedState | null {
    const entry = this.queue.get(userId);
    if (entry) return this.queuedState(entry, this.ctx.now());
    return null;
  }

  async enqueue(userId: string): Promise<Record<string, never>> {
    if (this.host.isSettling(userId)) throw new AppError("RANKED_SETTLING", "上一场还在结算");
    if (this.starting.has(userId)) throw new AppError("RANKED_STARTING", "正在为你开赛");
    if (this.queue.get(userId)) throw new AppError("RANKED_ALREADY_QUEUED", "已经在排队了");
    const current = this.ctx.seriesByUser.get(userId);
    if (current) {
      if (current.series.phase !== "settled")
        throw new AppError("RANKED_IN_SERIES", "请先打完当前这场");
      // 结果页还留着：重新排队前先自动离开。
      this.host.forgetSeries(current, userId);
      pushState(this.ctx, userId, idleState());
    }
    // 在读评级之前就先占位：连点两次 `queue` 不会开出两场。
    this.starting.add(userId);
    try {
      const prior = (await requireStore(this.ctx).getRating(userId)) ?? initialRatingRecord(userId);
      const entry: CEERankedQueueEntry = {
        userId,
        rating: prior.rating,
        queuedAt: this.ctx.now(),
        lastOpponent: this.ctx.lastOpponent.get(userId) ?? null,
      };
      // 定级赛只打人机：不满 5 场不进真人队列，直接开一场，推给客户端的就是系列赛。
      if (prior.seriesPlayed < CEE_RANKED_PLACEMENT_SERIES) {
        await this.startBotSeries(userId, "placement", entry);
        return {};
      }
      this.queue.add(entry);
      pushState(this.ctx, userId, this.queuedState(entry, this.ctx.now()));
      if (!this.closed) this.scheduleMatchTick();
      return {};
    } catch (error) {
      this.resetToIdle(userId);
      throw error;
    } finally {
      this.starting.delete(userId);
    }
  }

  cancel(userId: string): Record<string, never> {
    // 正在开赛：此时取消不会收回已经在开的那场，直接忽略。
    if (this.starting.has(userId)) return {};
    this.queue.remove(userId);
    this.pushedWindow.delete(userId);
    pushState(this.ctx, userId, idleState());
    return {};
  }

  async playBot(userId: string): Promise<Record<string, never>> {
    const entry = this.queue.get(userId);
    if (!entry) throw new AppError("INVALID_PHASE", "当前不在排队中");
    if (this.ctx.now() - entry.queuedAt < CEE_RANKED_BOT_OPTION_MS)
      throw new AppError("RANKED_BOT_NOT_READY", "再等一会儿才能选择人机");
    this.queue.remove(userId);
    this.pushedWindow.delete(userId);
    try {
      await this.guardedStart([userId], () => this.startBotSeries(userId, "manual", entry));
    } catch (error) {
      this.resetToIdle(userId);
      throw error;
    }
    return {};
  }

  /** 开赛护栏：组装是异步的，这期间同一账号的 `queue` 报忙、`cancel` 无效。 */
  private async guardedStart(userIds: readonly string[], open: () => Promise<void>): Promise<void> {
    for (const userId of userIds) this.starting.add(userId);
    await this.openClaimed(userIds, open);
  }

  /** 开赛护栏的释放半边：账号已在同一同步段里占位，这里只在自己结束时释放自己的那几位。 */
  private async openClaimed(userIds: readonly string[], open: () => Promise<void>): Promise<void> {
    try {
      await open();
    } finally {
      for (const userId of userIds) this.starting.delete(userId);
    }
  }

  private scheduleMatchTick(): void {
    if (this.matchCancel !== null || this.queue.size === 0 || this.closed) return;
    this.matchCancel = this.ctx.setTimer(() => {
      this.matchCancel = null;
      void this.tickMatch()
        .catch((error: unknown) => {
          this.ctx.logger?.error("排位匹配跳异常", { error: errorMessageOf(error) });
        })
        .finally(() => {
          if (!this.closed && this.queue.size > 0 && this.matchCancel === null)
            this.scheduleMatchTick();
        });
    }, MATCH_TICK_MS);
  }

  private async tickMatch(): Promise<void> {
    const now = this.ctx.now();
    const { pairs, fallbacks } = this.queue.tick(now);
    // 出队与占位必须在同一个同步段：后面几对要等前面的 await，这期间不能让他们处于「既不在队列也不在开赛中」。
    for (const [first, second] of pairs) {
      this.starting.add(first.userId);
      this.starting.add(second.userId);
    }
    for (const entry of fallbacks) this.starting.add(entry.userId);
    // 一场开失败不能带走整跳：其余候选照常开赛，失败的两位回队列外等下一次点排队。
    for (const [first, second] of pairs) {
      try {
        await this.openClaimed([first.userId, second.userId], () =>
          this.startHumanSeries(first, second, now)
        );
      } catch (error) {
        this.ctx.logger?.error("排位开赛失败", {
          userIds: [first.userId, second.userId],
          error: errorMessageOf(error),
        });
        this.resetToIdle(first.userId);
        this.resetToIdle(second.userId);
      }
    }
    for (const entry of fallbacks) {
      try {
        await this.openClaimed([entry.userId], () =>
          this.startBotSeries(entry.userId, "auto", entry, now)
        );
      } catch (error) {
        this.ctx.logger?.error("排位开赛失败", {
          userIds: [entry.userId],
          error: errorMessageOf(error),
        });
        this.resetToIdle(entry.userId);
      }
    }
    // 仍在排队的人窗口可能又放宽了一档，只给变化的推一帧。
    for (const userId of this.ctx.attachment.keys()) {
      const entry = this.queue.get(userId);
      if (!entry) continue;
      if (ceeRankedWindow(entry, now) === this.pushedWindow.get(userId)) continue;
      pushState(this.ctx, userId, this.queuedState(entry, now));
    }
  }

  /** 排位连接都在 `attachment` 里，排队中的账号必然有一条：据此推送，队列不必暴露迭代口。 */
  private async startHumanSeries(
    first: CEERankedQueueEntry,
    second: CEERankedQueueEntry,
    now: number
  ): Promise<void> {
    const store = requireStore(this.ctx);
    const [priorA, priorB] = await Promise.all([
      store.getRating(first.userId),
      store.getRating(second.userId),
    ]);
    const recordA = priorA ?? initialRatingRecord(first.userId);
    const recordB = priorB ?? initialRatingRecord(second.userId);
    const ratingA = toRating(recordA);
    const ratingB = toRating(recordB);
    const tier = ceeRankedTierFor(
      (conservativeCEERating(ratingA, now) + conservativeCEERating(ratingB, now)) / 2
    );
    const pool = await requirePool(this.ctx).getRankedPool(tier.id, now);
    const answers = pickAnswers(pool.candidates, this.ctx.random);
    if (!answers) {
      this.ctx.logger?.error("排位题库不足三题", {
        userId: first.userId,
        opponentId: second.userId,
        tier: tier.id,
      });
      this.resetToIdle(first.userId);
      this.resetToIdle(second.userId);
      return;
    }
    const [nameA, nameB] = await Promise.all([
      this.displayName(first.userId),
      this.displayName(second.userId),
    ]);
    const seats: [CEERankedSeatRuntime, CEERankedSeatRuntime] = [
      this.humanSeat(first.userId, nameA, recordA, first, now),
      this.humanSeat(second.userId, nameB, recordB, second, now),
    ];
    this.open({
      tier,
      pool,
      answers,
      seats,
      now,
      rated: true,
      unratedReason: null,
      bot: false,
      botEntry: null,
      botSpec: null,
    });
  }

  private async startBotSeries(
    userId: string,
    botEntry: Exclude<CEERankedBotEntry, null>,
    entry: CEERankedQueueEntry,
    now = this.ctx.now()
  ): Promise<void> {
    const prior = (await requireStore(this.ctx).getRating(userId)) ?? initialRatingRecord(userId);
    const rating = toRating(prior);
    const tier = ceeRankedTierFor(conservativeCEERating(rating, now));
    const pool = await requirePool(this.ctx).getRankedPool(tier.id, now);
    const answers = pickAnswers(pool.candidates, this.ctx.random);
    if (!answers) {
      this.ctx.logger?.error("排位题库不足三题", { userId, tier: tier.id });
      this.resetToIdle(userId);
      return;
    }
    const persona = pickCEERankedPersona(this.ctx.random, this.ctx.lastPersona.get(userId)?.id);
    // 爱噶的标称分就是玩家自己的分数，其余人格在 ±120 内浮动。
    const nominal =
      persona.id === "aiga" ? rating.rating : rating.rating + (this.ctx.random() * 240 - 120);
    const bias = this.ctx.handicap.bias(botGroupOf(persona.id));
    // 普通人格：按校准偏差回退后才生成强度，计分用标称分，真人对它的期望得分因此回到标称。
    // 爱噶：她有意比同分人机强，强度只跟玩家分数走；偏差加到计分用的分数上，赢她多涨、输给她少掉。
    const strengthRating = persona.id === "aiga" ? nominal : nominal - bias;
    const targetRating = persona.id === "aiga" ? nominal + bias : nominal;
    const rated = shouldRateBotSeries(prior, now);
    const name = await this.displayName(userId);
    const seats: [CEERankedSeatRuntime, CEERankedSeatRuntime] = [
      this.humanSeat(userId, name, prior, entry, now),
      {
        userId: null,
        isBot: true,
        name: persona.name,
        prior: null,
        clientType: null,
        clientVersion: null,
        queueWaitMs: null,
      },
    ];
    this.open({
      tier,
      pool,
      answers,
      seats,
      now,
      rated,
      unratedReason: rated ? null : "bot_daily_limit",
      bot: true,
      botEntry,
      botSpec: {
        persona,
        targetRating,
        strengthRating,
        strength: ceeRankedBotStrength(strengthRating, this.ctx.random),
      },
    });
    this.ctx.lastPersona.set(userId, { id: persona.id, at: this.ctx.now() });
  }

  private humanSeat(
    userId: string,
    name: string,
    prior: CEERankedRatingRecord,
    entry: CEERankedQueueEntry,
    now: number
  ): CEERankedSeatRuntime {
    const connection = connectionFor(this.ctx, userId);
    const channel = connection?.clientChannel;
    return {
      userId,
      isBot: false,
      name,
      prior,
      clientType: connection ? ceeClientTypeOf(channel) : null,
      clientVersion: channel?.clientVersion ?? null,
      queueWaitMs: now - entry.queuedAt,
    };
  }

  private async displayName(userId: string): Promise<string> {
    const found = await this.ctx.resolveName?.(userId);
    return found ?? FALLBACK_NAME;
  }

  /** 题库不足三题：两人各回空闲，等待下一场匹配。 */
  private resetToIdle(userId: string): void {
    this.queue.remove(userId);
    this.pushedWindow.delete(userId);
    this.ctx.seriesByUser.delete(userId);
    pushState(this.ctx, userId, idleState());
  }

  private open(input: {
    tier: CEERankedTier;
    pool: CEERankedPool;
    answers: CEECharacterView[];
    seats: [CEERankedSeatRuntime, CEERankedSeatRuntime];
    now: number;
    rated: boolean;
    unratedReason: string | null;
    bot: boolean;
    botEntry: CEERankedBotEntry;
    botSpec: CEERankedBotSpec | null;
  }): void {
    const series = createCEERankedSeries({
      id: crypto.randomUUID(),
      tier: input.tier.id,
      settings: input.pool.settings,
      answers: input.answers,
      seats: [
        {
          userId: input.seats[0].userId,
          name: input.seats[0].name,
          isBot: input.seats[0].isBot,
        },
        {
          userId: input.seats[1].userId,
          name: input.seats[1].name,
          isBot: input.seats[1].isBot,
        },
      ],
      now: input.now,
      random: this.ctx.random,
    });
    const runtime: CEERankedSeriesRuntime = {
      series,
      tier: input.tier,
      rated: input.rated,
      unratedReason: input.unratedReason,
      bot: input.bot,
      botEntry: input.botEntry,
      seats: input.seats,
      botSpec: input.botSpec,
      pool: input.pool,
      brain: null,
      botNextGuessAt: null,
      settlement: "pending",
      results: [null, null],
      settlementDone: false,
      settling: null,
      guessLedger: new Map(),
      timerCancel: null,
      timerWakeAt: null,
    };
    this.ctx.seriesById.set(series.id, runtime);
    for (const [index, seat] of input.seats.entries()) {
      if (seat.isBot || seat.userId === null) continue;
      this.ctx.seriesByUser.set(seat.userId, runtime);
      this.pushedWindow.delete(seat.userId);
      // 开赛是异步的：窗口里断线的人此刻没有系列赛可标，开出来后补记离线，否则永远没人给他计时。
      if (!this.ctx.attachment.has(seat.userId))
        setCEERankedSeatOnline(series, index === 0 ? 0 : 1, false, this.ctx.now());
    }
    pushSeries(this.ctx, runtime);
    this.host.scheduleTimer(runtime);
  }

  private queuedState(entry: CEERankedQueueEntry, now: number): CEERankedState {
    const window = ceeRankedWindow(entry, now);
    this.pushedWindow.set(entry.userId, window);
    return {
      status: "queued",
      queuedAt: entry.queuedAt,
      botAvailableAt: entry.queuedAt + CEE_RANKED_BOT_OPTION_MS,
      botFallbackAt: entry.queuedAt + CEE_RANKED_BOT_FALLBACK_MS,
      window,
    };
  }
}

/** 按先验权重不放回地抽题：正赛 3 道加上加赛备用，题库不够上限时有多少抽多少，不足 3 道返回 null。 */
function pickAnswers(
  candidates: readonly CEERankedCandidate[],
  random: () => number
): CEECharacterView[] | null {
  if (candidates.length < CEE_RANKED_SERIES_GAMES) return null;
  const rest = [...candidates];
  const picked: CEERankedCandidate[] = [];
  const count = Math.min(CEE_RANKED_SERIES_MAX_GAMES, candidates.length);
  while (picked.length < count) {
    const index = weightedIndex(
      rest.map((item) => Math.max(0, item.weight)),
      random
    );
    picked.push(rest[index]);
    rest.splice(index, 1);
  }
  return picked.map((item) => item.character);
}

function weightedIndex(weights: readonly number[], random: () => number): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return Math.min(weights.length - 1, Math.floor(random() * weights.length));
  let roll = random() * total;
  for (let index = 0; index < weights.length; index += 1) {
    roll -= weights[index];
    if (roll < 0) return index;
  }
  return weights.length - 1;
}

/** 校准分组：爱噶单独一组，其余人格共用一组。 */
function botGroupOf(personaId: CEERankedPersonaId): CEERankedBotGroup {
  return personaId === "aiga" ? "aiga" : "regular";
}
