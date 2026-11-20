// ==================== 排位撮合与开赛 ====================
// 排队、取消、选人机、匹配跳与开赛编排。「匹配中」的在途集合与排队相关的几张表都归这里，
// 与结算、门面之间只通过窄接口（是否结算中、离开结果页、重排计时器）往来，不共享可变引用。
import type { CEECharacterView } from "../shared/Index";
import {
  CEE_RANKED_BOT_FALLBACK_MS,
  CEE_RANKED_BOT_OPTION_MS,
  CEE_RANKED_PLACEMENT_SERIES,
  CEE_RANKED_SEASONS,
  CEE_RANKED_SERIES_GAMES,
  CEE_RANKED_SERIES_MAX_GAMES,
  ceeRankedTierFor,
  currentCEERankedSeason,
  nextCEERankedSeason,
  type CEERankedState,
  type CEERankedTier,
} from "../shared/CEERanked";
import { AppError } from "../domain/Errors";
import { beijingDay } from "../domain/BeijingDay";
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
/**
 * 开赛组装（读评级、取题库、解析昵称）的整体截止时间，是数据库语句截止时间之外的纵深防御。
 * 正常组装几秒内完成；单条只读语句最坏是两次语句截止时间（超时 + 换连接重试），这里再留出
 * 其余读取的余量。到点作废这次组装、玩家回空闲，题库计算照常在后台完成并进缓存，重排即可复用。
 */
export const CEE_RANKED_START_DEADLINE_MS = 30_000;
const START_TIMEOUT_CODE = "RANKED_START_TIMEOUT";
/** 缺省昵称解析失败时的显示名。 */
const FALLBACK_NAME = "玩家";

/**
 * 一次开赛组装：同一场系列赛的一到两位玩家共用。截止时间到点即作废，此后这次组装的任何
 * 迟到结果（开赛、置空闲、记人格）一律不生效——玩家此时可能已经重新排队。
 */
interface StartAttempt {
  revoked: boolean;
}

/** 「开赛中」的占位：属于哪次组装，以及出队前的排队条目（开赛期间快照仍按排队态给出）。 */
interface StartClaim {
  readonly attempt: StartAttempt;
  readonly entry: CEERankedQueueEntry;
}

export class CEERankedMatchmaker {
  private readonly ctx: CEERankedContext;
  private readonly host: CEERankedMatchHost;
  private readonly queue = new CEERankedQueue();
  /** 账号 → 最近一次推送的排队窗口：窗口没变就不重复推。 */
  private readonly pushedWindow = new Map<string, number>();
  /**
   * 正在开赛的账号：异步组装题库与昵称期间，`queue` 报忙，`cancel` 与 `playBot` 无效但不报错，
   * 快照按出队前的排队条目给排队态。释放按占位身份比对，只释放自己那次组装的占位。
   */
  private readonly starting = new Map<string, StartClaim>();
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

  /**
   * 该账号正在排队时的状态帧；正在开赛（已出队、系列赛还没开出来）也按排队态给，
   * 刷新或重连的玩家看到的是「匹配中」，不会去点「开始匹配」撞上「正在为你开赛」。
   * 既不排队也不在开赛返回 null。
   */
  queuedSnapshot(userId: string): CEERankedState | null {
    const now = this.ctx.now();
    const entry = this.queue.get(userId);
    if (entry) return this.queuedState(entry, now);
    const claim = this.starting.get(userId);
    if (claim) return queuedStateOf(claim.entry, now);
    return null;
  }

  async enqueue(userId: string): Promise<Record<string, never>> {
    this.requireOpenSeason();
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
    // 在读评级之前就先占位：连点两次 `queue` 不会开出两场。评级还没读到，排队条目先按点下排队的时刻记。
    const provisional: CEERankedQueueEntry = {
      userId,
      rating: 0,
      queuedAt: this.ctx.now(),
      lastOpponent: this.ctx.lastOpponent.get(userId) ?? null,
    };
    const attempt = this.claim([provisional]);
    try {
      await this.runStart(attempt, [userId], async () => {
        const prior =
          (await requireStore(this.ctx).getRating(userId)) ?? initialRatingRecord(userId);
        if (attempt.revoked) return;
        const entry: CEERankedQueueEntry = { ...provisional, rating: prior.rating };
        // 定级赛只打人机：不满 5 场不进真人队列，直接开一场，推给客户端的就是系列赛。
        if (prior.seriesPlayed < CEE_RANKED_PLACEMENT_SERIES) {
          await this.startBotSeries(attempt, userId, "placement", entry);
          return;
        }
        this.queue.add(entry);
        pushState(this.ctx, userId, this.queuedState(entry, this.ctx.now()));
        if (!this.closed) this.scheduleMatchTick();
      });
      return {};
    } catch (error) {
      this.resetToIdle(userId);
      throw error;
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
    // 正在开赛：那一场（人机或刚配上的真人局）已经在开，与 `cancel` 一样直接忽略，不报「不在排队中」。
    if (this.starting.has(userId)) return {};
    this.requireOpenSeason();
    const entry = this.queue.get(userId);
    if (!entry) throw new AppError("INVALID_PHASE", "当前不在排队中");
    if (this.ctx.now() - entry.queuedAt < CEE_RANKED_BOT_OPTION_MS)
      throw new AppError("RANKED_BOT_NOT_READY", "再等一会儿才能选择人机");
    this.queue.remove(userId);
    this.pushedWindow.delete(userId);
    const attempt = this.claim([entry]);
    try {
      await this.runStart(attempt, [userId], () =>
        this.startBotSeries(attempt, userId, "manual", entry)
      );
    } catch (error) {
      this.resetToIdle(userId);
      throw error;
    }
    return {};
  }

  /** 赛季窗外拒绝新开：排队与主动打人机都过这道门，在途系列赛不受影响。 */
  private requireOpenSeason(): void {
    const now = this.ctx.now();
    if (currentCEERankedSeason(now) === null) throw seasonClosedError(now);
  }

  /** 开赛护栏的占位半边：组装是异步的，必须在出队的同一个同步段里占好。 */
  private claim(entries: readonly CEERankedQueueEntry[]): StartAttempt {
    const attempt: StartAttempt = { revoked: false };
    for (const entry of entries) this.starting.set(entry.userId, { attempt, entry });
    return attempt;
  }

  /**
   * 开赛护栏的组装与释放半边：组装受整体截止时间约束，到点作废本次组装并以超时拒绝（记错误日志，
   * 由调用方把玩家置回空闲）；无论成败，只释放属于本次组装的占位。
   */
  private async runStart(
    attempt: StartAttempt,
    userIds: readonly string[],
    assemble: () => Promise<void>
  ): Promise<void> {
    let cancelDeadline: () => void = () => {};
    const expired = new Promise<never>((_, reject) => {
      cancelDeadline = this.ctx.setTimer(() => {
        attempt.revoked = true;
        this.ctx.logger?.error("排位开赛超时", {
          userIds: [...userIds],
          deadlineMs: CEE_RANKED_START_DEADLINE_MS,
        });
        reject(new AppError(START_TIMEOUT_CODE, "开赛超时，请重新开始匹配"));
      }, CEE_RANKED_START_DEADLINE_MS);
    });
    const work = assemble();
    // 作废之后组装仍可能迟到地失败：已经没人等它的结果，吞掉以免成为未处理的拒绝。
    work.catch(() => {});
    try {
      await Promise.race([work, expired]);
    } finally {
      cancelDeadline();
      for (const userId of userIds) {
        if (this.starting.get(userId)?.attempt === attempt) this.starting.delete(userId);
      }
    }
  }

  /** 匹配跳里的一场开赛：失败只影响这一场的玩家，回空闲等下一次点排队。 */
  private async startFromTick(
    attempt: StartAttempt,
    userIds: readonly string[],
    assemble: () => Promise<void>
  ): Promise<void> {
    try {
      await this.runStart(attempt, userIds, assemble);
    } catch (error) {
      // 超时已在截止处记过日志，不重复记。
      if (!isStartTimeout(error))
        this.ctx.logger?.error("排位开赛失败", {
          userIds: [...userIds],
          error: errorMessageOf(error),
        });
      for (const userId of userIds) this.resetToIdle(userId);
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
    // 赛季结束：撮合与超时自动人机都不再开新场，还在队列里的整队移出并推回空闲。
    if (currentCEERankedSeason(now) === null) {
      for (const entry of this.queue.drain()) {
        this.pushedWindow.delete(entry.userId);
        pushState(this.ctx, entry.userId, idleState());
      }
      return;
    }
    const { pairs, fallbacks } = this.queue.tick(now);
    // 出队与占位必须在同一个同步段：组装都要 await，这期间不能让他们处于「既不在队列也不在开赛中」。
    const humanStarts = pairs.map(([first, second]) => ({
      first,
      second,
      attempt: this.claim([first, second]),
    }));
    const botStarts = fallbacks.map((entry) => ({ entry, attempt: this.claim([entry]) }));
    // 各场并行组装、各有截止时间：一场挂住不拖住同跳的其他人，也不拖住下一跳（下一跳要等这一跳结束才排）。
    // 一场开失败不能带走整跳：其余候选照常开赛，失败的玩家回队列外等下一次点排队。
    await Promise.all([
      ...humanStarts.map(({ first, second, attempt }) =>
        this.startFromTick(attempt, [first.userId, second.userId], () =>
          this.startHumanSeries(attempt, first, second, now)
        )
      ),
      ...botStarts.map(({ entry, attempt }) =>
        this.startFromTick(attempt, [entry.userId], () =>
          this.startBotSeries(attempt, entry.userId, "auto", entry, now)
        )
      ),
    ]);
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
    attempt: StartAttempt,
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
    if (attempt.revoked) return;
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
    if (attempt.revoked) return;
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
    attempt: StartAttempt,
    userId: string,
    botEntry: Exclude<CEERankedBotEntry, null>,
    entry: CEERankedQueueEntry,
    now = this.ctx.now()
  ): Promise<void> {
    const prior = (await requireStore(this.ctx).getRating(userId)) ?? initialRatingRecord(userId);
    const rating = toRating(prior);
    const tier = ceeRankedTierFor(conservativeCEERating(rating, now));
    const pool = await requirePool(this.ctx).getRankedPool(tier.id, now);
    if (attempt.revoked) return;
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
    if (attempt.revoked) return;
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

  /** 要推送的排队态：顺带记下推过的窗口，窗口不变就不重复推。 */
  private queuedState(entry: CEERankedQueueEntry, now: number): CEERankedState {
    const state = queuedStateOf(entry, now);
    this.pushedWindow.set(entry.userId, state.window);
    return state;
  }
}

/** 排队条目对应的排队态帧（纯函数）。 */
function queuedStateOf(
  entry: CEERankedQueueEntry,
  now: number
): Extract<CEERankedState, { status: "queued" }> {
  return {
    status: "queued",
    queuedAt: entry.queuedAt,
    botAvailableAt: entry.queuedAt + CEE_RANKED_BOT_OPTION_MS,
    botFallbackAt: entry.queuedAt + CEE_RANKED_BOT_FALLBACK_MS,
    window: ceeRankedWindow(entry, now),
  };
}

/** 开赛组装超时：截止处已记过错误日志。 */
function isStartTimeout(error: unknown): boolean {
  return error instanceof AppError && error.code === START_TIMEOUT_CODE;
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

/** 赛季窗外的拒绝文案：区分「还没开始」与「已结束」，有下一个赛季时带上开始日期。 */
function seasonClosedError(now: number): AppError {
  const next = nextCEERankedSeason(now);
  const startText = next === null ? null : `${beijingMonthDay(Date.parse(next.startsAt))} 开赛`;
  const anyEnded = CEE_RANKED_SEASONS.some((season) => Date.parse(season.endsAt) <= now);
  if (!anyEnded) {
    return new AppError(
      "RANKED_SEASON_CLOSED",
      startText === null ? "排位赛季暂未开放" : `排位赛季还没开始，${startText}`
    );
  }
  return new AppError(
    "RANKED_SEASON_CLOSED",
    startText === null
      ? "本赛季已结束，下个赛季开始前暂停排位"
      : `本赛季已结束，下个赛季 ${startText}，期间暂停排位`
  );
}

/** 北京时间的「M 月 D 日」：拒绝文案里的开赛日期用。 */
function beijingMonthDay(at: number): string {
  const day = beijingDay(at);
  return `${Number(day.slice(5, 7))} 月 ${Number(day.slice(8, 10))} 日`;
}
