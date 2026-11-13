// ==================== 排位赛应用服务 ====================
// 纯规则与状态机都在 domain/CEERanked*，这里只管时钟、连接、题库、人机大脑与结算写库。
import type { CEECharacterView, ConnectionRecord } from "../shared/Index";
import type { ClientEnvelope } from "../shared/Protocol";
import type {
  CEERankedCommand,
  CEERankedHistoryEntry,
  CEERankedHistoryPage,
  CEERankedLeaderboard,
  CEERankedOutcome,
  CEERankedPayload,
  CEERankedProfile,
  CEERankedResponse,
  CEERankedState,
  CEERankedTierId,
} from "../shared/CEERanked";
import {
  CEE_RANKED_BOT_DAILY_RATED,
  CEE_RANKED_BOT_FALLBACK_MS,
  CEE_RANKED_BOT_OPTION_MS,
  CEE_RANKED_OFFLINE_FORFEIT_MS,
  CEE_RANKED_PLACEMENT_SERIES,
  CEE_RANKED_SERIES_GAMES,
  CEE_RANKED_SERIES_MAX_GAMES,
  CEE_RANKED_STATE_EVENT,
  ceeRankedTierFor,
  type CEERankedTier,
} from "../shared/CEERanked";
import { AppError } from "../domain/Errors";
import { beijingDay } from "../domain/BeijingDay";
import {
  applyCEERankedSeriesGuess,
  ceeRankedSeriesScore,
  createCEERankedSeries,
  exitCEERankedSeries,
  setCEERankedSeatOnline,
  surrenderCEERankedSeriesGame,
  tickCEERankedSeries,
} from "../domain/CEERankedSeries";
import {
  ceeRankedGameSeatFinished,
  type CEERankedGame,
  type CEERankedSeatIndex,
} from "../domain/CEERankedGame";
import {
  conservativeCEERating,
  displayCEERating,
} from "../domain/CEERankedRating";
import {
  ceeRankedBotStrength,
  pickCEERankedPersona,
  type CEERankedPersonaId,
} from "../domain/CEERankedBotProfile";
import { ceeRankedBotThinkMs } from "../domain/CEERankedBotTiming";
import {
  ceeRankedBotEligible,
  createCEERankedBot,
  nextCEERankedBotGuess,
  recordCEERankedBotFeedback,
  type CEERankedBotBrain,
} from "../domain/CEERankedBot";
import { filterCEECandidates, type CEERankedCandidate } from "../domain/CEERankedSolver";
import type { CEEDataProvider } from "../infrastructure/CEEData";
import type { EventLogger } from "../infrastructure/EventLogger";
import { createEvent } from "../transport/Packets";
import {
  ceeClientTypeOf,
  type CEESearchProvenance,
} from "./CEEAntiCheatSignals";
import { requireCEEClientAdmission } from "./CEEClientAdmission";
import { CEERankedHandicap, type CEERankedBotGroup } from "./CEERankedHandicap";
import {
  CEE_RANKED_REMATCH_COOLDOWN_MS,
  CEERankedQueue,
  ceeRankedWindow,
  type CEERankedQueueEntry,
} from "./CEERankedQueue";
import type { CEERankedPool, CEERankedPoolProvider } from "./CEERankedPool";
import { runCEEDataCommand } from "./CEEDataCommands";
import {
  ceeRankedSeriesView,
  type CEERankedSeatResultMeta,
} from "./CEERankedViews";
import {
  ceeRankedBotSampleOf,
  type CEERankedHistoryRecord,
  type CEERankedLeaderboardRecord,
  type CEERankedRatingRecord,
  type CEERankedSeriesPlayerRecord,
  type CEERankedSettlementRecord,
  type CEERankedStore,
} from "./CEERankedStore";

import {
  errorMessageOf,
  idleState,
  connectionFor,
  metaFor,
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

import {
  initialRatingRecord,
  gameRecords,
  guessRecords,
  resolveRatings,
  seatRatingRecords,
  seriesRecord,
  playerRecord,
  settlementResults,
  shouldRateBotSeries,
  toRating,
} from "./CEERankedSettlement";

/**
 * 排位命令信封的可穷尽联合：`switch (message.type)` 在这一层就能把 payload 收窄到对应命令，
 * 泛型 `T` 做不到（`CEERankedPayload<T>` 在 T 未实例化时是全部 payload 的并集）。
 */
type CEERankedMessage = {
  [K in CEERankedCommand]: ClientEnvelope<K, CEERankedPayload<K>>;
}[CEERankedCommand];

/** 人机席位固定在 1 号席：真人对局里 0 号是发起者，人机对局里真人也排在 0 号。 */
const BOT_SEAT: CEERankedSeatIndex = 1;
/** 匹配跳周期：1 秒一跳，只在队列非空时运行。 */
const MATCH_TICK_MS = 1_000;
/** 唤醒抛错后的重排退避：同一异常不会让计时器贴着 1ms 空转。 */
const WAKE_RETRY_BACKOFF_MS = 5_000;
/** 结算写库缺省重试等待：1 / 3 / 9 秒。 */
const DEFAULT_SETTLE_RETRY_DELAYS_MS = [1_000, 3_000, 9_000];
/** 缺省昵称解析失败时的显示名。 */
const FALLBACK_NAME = "玩家";
/** 启动时灌入的校准样本上限：两组各占 300 的窗口，多取一些才能每组都填满。 */
const HANDICAP_SEED_LIMIT = 600;
/** 每组每攒满这么多新样本打一次当前偏差，便于观察收敛。 */
const HANDICAP_LOG_EVERY = 20;
/** 结算后结果页最长保留时长：超过就替还挂着的玩家离开，运行时不常驻内存。 */
export const SETTLED_RETENTION_MS = 30 * 60_000;
/** 战绩每页条数（首页资料带第一页，往前翻页同一口径）。 */
const HISTORY_PAGE = 20;
/** 排行榜条数与缓存时长：榜单人人都看，结算写库成功时立即作废。 */
const LEADERBOARD_SIZE = 50;
const LEADERBOARD_TTL_MS = 30_000;
/** 这三条命令自带准入：其余命令必须已经绑定在该账号的排位连接上。 */
const ADMISSION_COMMANDS: readonly CEERankedCommand[] = [
  "cee.ranked.status",
  "cee.ranked.queue",
  "cee.ranked.playBot",
];

export interface CEERankedServiceOptions {
  data: CEEDataProvider;
  /** 审计仓储；未注入（没配数据库）时排位整体不可用。 */
  store?: CEERankedStore;
  /** 题库；未注入时排位整体不可用。 */
  pool?: CEERankedPoolProvider;
  provenance: CEESearchProvenance;
  /** 取账号昵称作为排位显示名；取不到时用「玩家」。 */
  resolveName?: (userId: string) => Promise<string | null>;
  logger?: Pick<EventLogger, "info" | "warn" | "error">;
  now?: () => number;
  random?: () => number;
  /** 计时器接缝：测试注入假时钟。缺省 setTimeout / clearTimeout（定时器 unref，不拖住进程）。 */
  setTimer?: (callback: () => void, ms: number) => () => void;
  /** 结算写库重试的等待；缺省 1 / 3 / 9 秒。 */
  settleRetryDelaysMs?: readonly number[];
}

/**
 * 排位赛编排：准入 → 排队匹配 → 系列赛生命周期 → 人机驱动 → 结算写库 → 状态推送。
 *
 * 每个账号同时只有一条排位连接；系列赛每场一个计时器，唤醒时刻取「下一个必然要动的事件」，
 * 所以读秒、截止、局间、人机出手与离线判负都复用同一条时间轴。
 */
export class CEERankedService {
  private readonly data: CEEDataProvider;
  private readonly provenance: CEESearchProvenance;
  private readonly ctx: CEERankedContext;

  private readonly queue = new CEERankedQueue();
  /** 连接 → 账号：断开时据此解绑。 */
  private readonly attachedBy = new Map<string, string>();
  /** 排行榜头部缓存；本人名次每次单独算，不进缓存。 */
  private leaderboardCache: {
    rows: CEERankedLeaderboardRecord[];
    total: number;
    at: number;
  } | null = null;
  /** 结算尚未落定的账号：期间 `queue` 回 RANKED_SETTLING。 */
  private readonly settling = new Set<string>();
  /** 同账号在途猜测：一次只允许一条。 */
  private readonly guessing = new Set<string>();
  /** 账号 → 最近一次推送的排队窗口：窗口没变就不重复推。 */
  private readonly pushedWindow = new Map<string, number>();
  /** 正在开赛的账号：异步组装题库与昵称期间，`queue` 报忙、`cancel` 无效。 */
  private readonly starting = new Set<string>();
  private matchCancel: (() => void) | null = null;
  private closed = false;

  constructor(options: CEERankedServiceOptions) {
    this.data = options.data;
    this.provenance = options.provenance;
    this.ctx = {
      store: options.store,
      poolProvider: options.pool,
      resolveName: options.resolveName,
      logger: options.logger,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
      setTimer:
        options.setTimer ??
        ((callback, ms) => {
          const timer = setTimeout(callback, ms);
          timer.unref();
          return () => clearTimeout(timer);
        }),
      settleRetryDelaysMs: options.settleRetryDelaysMs ?? DEFAULT_SETTLE_RETRY_DELAYS_MS,
      handicap: new CEERankedHandicap(),
      connections: new Map(),
      attachment: new Map(),
      seriesByUser: new Map(),
      seriesById: new Map(),
      lastOpponent: new Map(),
      lastPersona: new Map(),
    };
    this.seedHandicap();
  }

  /** 启动灌入近期人机战绩作为校准种子：读不到就从零攒，不影响排位可用。 */
  private seedHandicap(): void {
    const store = this.ctx.store;
    if (store === undefined) return;
    void store
      .listRecentBotSamples(HANDICAP_SEED_LIMIT)
      .then((samples) => {
        this.ctx.handicap.seed(samples);
      })
      .catch((error: unknown) => {
        this.ctx.logger?.warn("排位人机校准种子读取失败", { error: errorMessageOf(error) });
      });
  }

  // ==================== 连接生命周期 ====================

  registerConnection(connection: ConnectionRecord): void {
    this.ctx.connections.set(connection.id, connection);
  }

  unregisterConnection(connectionId: string): void {
    this.ctx.connections.delete(connectionId);
    const userId = this.attachedBy.get(connectionId);
    if (userId === undefined) return;
    if (this.ctx.attachment.get(userId) !== connectionId) return;
    this.ctx.attachment.delete(userId);
    this.attachedBy.delete(connectionId);
    if (this.queue.remove(userId)) this.pushedWindow.delete(userId);
    const runtime = this.ctx.seriesByUser.get(userId);
    if (!runtime || runtime.series.phase === "settled") return;
    const seat = this.seatOf(runtime, userId);
    if (seat === null) return;
    setCEERankedSeatOnline(runtime.series, seat, false, this.ctx.now());
    // 对手要立刻看到「离线」：安静期里可能几分钟都没有别的状态变化顺带把它推出去。
    pushSeries(this.ctx, runtime);
    this.scheduleTimer(runtime);
  }

  /** 关停：只推 idle 并记账作废的系列赛，计时器由 `close` 清。 */
  notifyShutdown(): void {
    for (const connectionId of this.ctx.attachment.values()) {
      const connection = this.ctx.connections.get(connectionId);
      if (connection) connection.send(createEvent(CEE_RANKED_STATE_EVENT, idleState()));
    }
    for (const runtime of this.ctx.seriesById.values()) {
      if (runtime.series.phase === "settled") continue;
      this.ctx.logger?.warn("进程关停，排位系列赛作废", { seriesId: runtime.series.id });
    }
  }

  close(): void {
    this.closed = true;
    if (this.matchCancel) {
      this.matchCancel();
      this.matchCancel = null;
    }
    for (const runtime of this.ctx.seriesById.values()) this.cancelTimer(runtime);
  }

  /** 兜底巡检：队列非空但匹配计时器断了就重排，唤醒时刻已过但计时器没动的场次补一次唤醒。 */
  runHousekeeping(): void {
    if (this.closed) return;
    if (this.queue.size > 0 && !this.matchCancel) this.scheduleMatchTick();
    const now = this.ctx.now();
    this.sweepSettled(now);
    this.sweepRecentOpponents(now);
    for (const runtime of [...this.ctx.seriesById.values()]) {
      if (runtime.timerWakeAt === null || runtime.timerWakeAt > now) continue;
      this.cancelTimer(runtime);
      this.fireWake(runtime);
    }
  }

  // ==================== 命令入口 ====================

  async execute<T extends CEERankedCommand>(
    connection: ConnectionRecord,
    message: ClientEnvelope<T, CEERankedPayload<T>>
  ): Promise<CEERankedResponse<T>> {
    requireStore(this.ctx);
    requirePool(this.ctx);
    const needsAdmission = ADMISSION_COMMANDS.includes(message.type);
    if (needsAdmission) requireCEEClientAdmission(connection, "ranked");
    const userId = connection.account?.userId;
    if (userId === undefined) {
      // 走到这里说明不是准入命令（准入已经拦下未登录），也就是没有绑定关系。
      throw new AppError("RANKED_NOT_ATTACHED", "请重新进入排位");
    }
    if (needsAdmission) this.bind(userId, connection);
    else if (this.ctx.attachment.get(userId) !== connection.id)
      throw new AppError("RANKED_NOT_ATTACHED", "请重新进入排位");
    // 泛型 `T` 在函数体内不可解析，逐命令收窄只能在 `CEERankedMessage` 这一层做；
    // 两个方向都是「同一条命令的信封」，转换不改变运行时形状。
    const command = message as CEERankedMessage;
    return (await this.dispatch(userId, connection, command)) as CEERankedResponse<T>;
  }

  private async dispatch(
    userId: string,
    connection: ConnectionRecord,
    message: CEERankedMessage
  ): Promise<unknown> {
    switch (message.type) {
      case "cee.ranked.status":
        // 客户端要的是一份能当基线的全量：清掉这条连接的差量基线，随后推的那一帧带修订号。
        connection.resetStateSync?.();
        return this.handleStatus(userId);
      case "cee.ranked.queue":
        return this.handleQueue(userId);
      case "cee.ranked.cancel":
        return this.handleCancel(userId);
      case "cee.ranked.playBot":
        return this.handlePlayBot(userId);
      case "cee.ranked.guess":
        return this.handleGuess(userId, connection, message.payload.characterId);
      case "cee.ranked.surrender":
        return this.handleSurrender(userId);
      case "cee.ranked.exit":
        return this.handleExit(userId);
      case "cee.ranked.leave":
        return this.handleLeave(userId);
      case "cee.ranked.profile":
        return this.handleProfile(userId);
      case "cee.ranked.history":
        return this.handleHistory(userId, message.payload.before);
      case "cee.ranked.leaderboard":
        return this.handleLeaderboard(userId);
      case "cee.ranked.characterSearch": {
        this.requireInSeries(userId);
        return runCEEDataCommand(this.data, "cee.character.search", message.payload);
      }
      case "cee.ranked.subjectSearch": {
        this.requireInSeries(userId);
        return runCEEDataCommand(this.data, "cee.subject.search", message.payload);
      }
      case "cee.ranked.subjectCharacters": {
        this.requireInSeries(userId);
        return runCEEDataCommand(this.data, "cee.subject.characters", message.payload);
      }
      case "cee.ranked.characterImage": {
        // 结果页逐局回看答案与双方猜测也要取图：结算后的那场仍算在内，检索命令则不放行。
        this.requireSeriesView(userId);
        return runCEEDataCommand(this.data, "cee.character.image", message.payload);
      }
      default: {
        const unhandled: never = message;
        throw new AppError(
          "UNKNOWN_MESSAGE_TYPE",
          `未处理的指令：${(unhandled as { type: string }).type}`
        );
      }
    }
  }

  // ==================== 绑定与视图 ====================

  /** 设定该账号的排位连接；旧连接收一帧 idle 后不再收推送，重连则恢复在线。 */
  private bind(userId: string, connection: ConnectionRecord): void {
    const previous = this.ctx.attachment.get(userId);
    if (previous !== undefined && previous !== connection.id) {
      const old = this.ctx.connections.get(previous);
      if (old) old.send(createEvent(CEE_RANKED_STATE_EVENT, idleState()));
      this.attachedBy.delete(previous);
    }
    this.ctx.attachment.set(userId, connection.id);
    this.attachedBy.set(connection.id, userId);
    const runtime = this.ctx.seriesByUser.get(userId);
    if (!runtime || runtime.series.phase === "settled") return;
    const seat = this.seatOf(runtime, userId);
    if (seat === null) return;
    const wasOffline = runtime.series.seats[seat].offlineSince !== null;
    setCEERankedSeatOnline(runtime.series, seat, true, this.ctx.now());
    // 重连回来同样要让对手立刻看到恢复在线；本人这一帧由随后的状态回包负责。
    if (wasOffline) pushSeries(this.ctx, runtime);
    this.scheduleTimer(runtime);
  }

  private seatOf(runtime: CEERankedSeriesRuntime, userId: string): CEERankedSeatIndex | null {
    if (runtime.seats[0].userId === userId) return 0;
    if (runtime.seats[1].userId === userId) return 1;
    return null;
  }

  /** 命令要求账号正在打一场未结束的系列赛。 */
  private requireInSeries(userId: string): void {
    const runtime = this.ctx.seriesByUser.get(userId);
    if (runtime && runtime.series.phase !== "settled") return;
    throw new AppError("INVALID_PHASE", "排位搜索只在系列赛进行中可用");
  }

  /** 命令要求账号正看着一场系列赛：进行中或停在结果页都算。 */
  private requireSeriesView(userId: string): void {
    if (this.ctx.seriesByUser.has(userId)) return;
    throw new AppError("INVALID_PHASE", "当前没有排位对局");
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

  private snapshot(userId: string): CEERankedState {
    const runtime = this.ctx.seriesByUser.get(userId);
    if (runtime) {
      const seat = this.requireSeat(runtime, userId);
      return {
        status: "series",
        series: ceeRankedSeriesView(runtime.series, seat, metaFor(runtime)),
      };
    }
    const entry = this.queue.get(userId);
    if (entry) return this.queuedState(entry, this.ctx.now());
    return { status: "idle" };
  }

  /** 席位归属已由 `seriesByUser` 保证，取不到说明绑定关系被破坏。 */
  private requireSeat(runtime: CEERankedSeriesRuntime, userId: string): CEERankedSeatIndex {
    const seat = this.seatOf(runtime, userId);
    if (seat === null) throw new AppError("RANKED_NOT_ATTACHED", "请重新进入排位");
    return seat;
  }

  // ==================== 排队与开赛场次 ====================

  private async handleStatus(userId: string): Promise<CEERankedState> {
    const state = this.snapshot(userId);
    pushState(this.ctx, userId, state);
    return state;
  }

  private async handleQueue(userId: string): Promise<Record<string, never>> {
    if (this.settling.has(userId)) throw new AppError("RANKED_SETTLING", "上一场还在结算");
    if (this.starting.has(userId)) throw new AppError("RANKED_STARTING", "正在为你开赛");
    if (this.queue.get(userId)) throw new AppError("RANKED_ALREADY_QUEUED", "已经在排队了");
    const current = this.ctx.seriesByUser.get(userId);
    if (current) {
      if (current.series.phase !== "settled")
        throw new AppError("RANKED_IN_SERIES", "请先打完当前这场");
      // 结果页还留着：重新排队前先自动离开。
      this.forgetSeries(current, userId);
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

  private handleCancel(userId: string): Record<string, never> {
    // 正在开赛：此时取消不会收回已经在开的那场，直接忽略。
    if (this.starting.has(userId)) return {};
    this.queue.remove(userId);
    this.pushedWindow.delete(userId);
    pushState(this.ctx, userId, idleState());
    return {};
  }

  private async handlePlayBot(userId: string): Promise<Record<string, never>> {
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
    this.scheduleTimer(runtime);
  }

  // ==================== 计时与推进 ====================

  private scheduleTimer(runtime: CEERankedSeriesRuntime, minDelayMs = 0): void {
    this.cancelTimer(runtime);
    if (this.closed) return;
    if (runtime.series.phase === "settled" && runtime.settlementDone) return;
    const nextWake = this.nextWakeAt(runtime);
    if (nextWake === null) return;
    const wake = Math.max(nextWake, this.ctx.now() + minDelayMs);
    runtime.timerWakeAt = wake;
    const cancel = this.ctx.setTimer(
      () => {
        runtime.timerCancel = null;
        runtime.timerWakeAt = null;
        this.fireWake(runtime);
      },
      Math.max(1, wake - this.ctx.now())
    );
    runtime.timerCancel = () => {
      cancel();
      runtime.timerCancel = null;
      runtime.timerWakeAt = null;
    };
  }

  private cancelTimer(runtime: CEERankedSeriesRuntime): void {
    if (runtime.timerCancel) runtime.timerCancel();
    runtime.timerCancel = null;
    runtime.timerWakeAt = null;
  }

  /** 下一件必然要发生的事：读秒、截止、局间开局、人机出手、离线判负里最早的时刻。 */
  private nextWakeAt(runtime: CEERankedSeriesRuntime): number | null {
    const times: number[] = [];
    const game = runtime.series.current;
    if (game) {
      if (game.phase === "countdown") times.push(game.startsAt);
      if (game.deadlineAt !== null) times.push(game.deadlineAt);
    }
    if (runtime.series.nextGameAt !== null) times.push(runtime.series.nextGameAt);
    if (runtime.bot && runtime.botNextGuessAt !== null) times.push(runtime.botNextGuessAt);
    for (const seat of runtime.series.seats) {
      if (seat.isBot || seat.offlineSince === null) continue;
      times.push(seat.offlineSince + CEE_RANKED_OFFLINE_FORFEIT_MS);
    }
    if (times.length === 0) return null;
    return Math.min(...times);
  }

  /** 计时器与巡检的统一唤醒入口：唤醒是时间轴上唯一的驱动，抛错不能变成未处理拒绝并丢掉计时器。 */
  private fireWake(runtime: CEERankedSeriesRuntime): void {
    this.wakeSeries(runtime).catch((error: unknown) => {
      this.ctx.logger?.error("排位唤醒异常", {
        seriesId: runtime.series.id,
        error: errorMessageOf(error),
      });
      if (this.ctx.seriesById.has(runtime.series.id))
        this.scheduleTimer(runtime, WAKE_RETRY_BACKOFF_MS);
    });
  }

  private async wakeSeries(runtime: CEERankedSeriesRuntime): Promise<void> {
    if (!this.ctx.seriesById.has(runtime.series.id)) return;
    await this.afterChange(runtime);
  }

  /** 任何改动系列赛之后的统一收尾：推进时间、驱动人机、必要时结算、推送、重排计时器。 */
  private async afterChange(runtime: CEERankedSeriesRuntime): Promise<void> {
    const now = this.ctx.now();
    tickCEERankedSeries(runtime.series, now);
    if (runtime.bot) this.driveBot(runtime, now);
    // 写库可能带重试，不能压住命令 ACK：结算自己会先推「结算中」再推结果。
    if (runtime.series.phase === "settled" && !runtime.settlementDone)
      void this.settle(runtime).catch((error: unknown) => {
        this.ctx.logger?.error("排位结算异常", {
          seriesId: runtime.series.id,
          error: errorMessageOf(error),
        });
      });
    pushSeries(this.ctx, runtime);
    this.scheduleTimer(runtime);
  }

  // ==================== 对局命令 ====================

  private async handleGuess(
    userId: string,
    connection: ConnectionRecord,
    characterId: number
  ): Promise<Record<string, never>> {
    const runtime = this.ctx.seriesByUser.get(userId);
    if (!runtime || runtime.series.phase === "settled")
      throw new AppError("INVALID_PHASE", "当前没有进行中的对局");
    const seat = this.requireSeat(runtime, userId);
    if (this.guessing.has(userId)) throw new AppError("ACTION_PENDING", "上一次猜测还在提交");
    this.guessing.add(userId);
    const game = runtime.series.current;
    const seriesId = runtime.series.id;
    const attempts = game ? game.seats[seat].attempts : -1;
    try {
      const view = await this.data.getCharacter(characterId, runtime.series.settings);
      const current = runtime.series.current;
      // 取角色的这几百毫秒里可能换局、结算或被别的连接抢先出手，一律作废这次猜测。
      if (
        runtime.series.id !== seriesId ||
        current === null ||
        current !== game ||
        current.phase === "settled" ||
        current.seats[seat].attempts !== attempts
      )
        throw new AppError("ROUND_CANCELLED", "本次行动已超时，请重新猜测");
      const guess = applyCEERankedSeriesGuess(runtime.series, seat, view, this.ctx.now());
      const ledger = this.provenance.match(connection.id, characterId);
      runtime.guessLedger.set(guess.id, { searchedAt: ledger.at, searchMatched: ledger.matched });
      await this.afterChange(runtime);
      return {};
    } finally {
      this.guessing.delete(userId);
    }
  }

  private async handleSurrender(userId: string): Promise<Record<string, never>> {
    const runtime = this.requirePlaying(userId);
    const seat = this.requireSeat(runtime, userId);
    surrenderCEERankedSeriesGame(runtime.series, seat, this.ctx.now());
    await this.afterChange(runtime);
    return {};
  }

  private async handleExit(userId: string): Promise<Record<string, never>> {
    const runtime = this.requirePlaying(userId);
    const seat = this.requireSeat(runtime, userId);
    exitCEERankedSeries(runtime.series, seat, this.ctx.now());
    await this.afterChange(runtime);
    return {};
  }

  private handleLeave(userId: string): Record<string, never> {
    const runtime = this.ctx.seriesByUser.get(userId);
    if (!runtime || runtime.series.phase !== "settled")
      throw new AppError("INVALID_PHASE", "当前没有可离开的结果页");
    this.forgetSeries(runtime, userId);
    pushState(this.ctx, userId, idleState());
    return {};
  }

  private requirePlaying(userId: string): CEERankedSeriesRuntime {
    const runtime = this.ctx.seriesByUser.get(userId);
    if (runtime && runtime.series.phase !== "settled") return runtime;
    throw new AppError("INVALID_PHASE", "当前没有进行中的对局");
  }

  private async handleProfile(userId: string): Promise<CEERankedProfile> {
    const store = requireStore(this.ctx);
    const record = (await store.getRating(userId)) ?? initialRatingRecord(userId);
    const page = await this.historyPage(userId);
    const placed = record.seriesPlayed >= CEE_RANKED_PLACEMENT_SERIES;
    const today = beijingDay(this.ctx.now());
    return {
      rating: placed ? displayCEERating(record) : null,
      placementPlayed: Math.min(record.seriesPlayed, CEE_RANKED_PLACEMENT_SERIES),
      placementTotal: CEE_RANKED_PLACEMENT_SERIES,
      seriesPlayed: record.seriesPlayed,
      wins: record.wins,
      losses: record.losses,
      draws: record.draws,
      botRatedToday: record.botRatedDay === today ? record.botRatedCount : 0,
      botRatedLimit: CEE_RANKED_BOT_DAILY_RATED,
      recent: page.entries,
      recentHasMore: page.hasMore,
    };
  }

  private handleHistory(userId: string, before: number): Promise<CEERankedHistoryPage> {
    return this.historyPage(userId, before);
  }

  /** 多取一条判断是否还有更早的战绩，不另发计数查询。 */
  private async historyPage(userId: string, before?: number): Promise<CEERankedHistoryPage> {
    const rows = await requireStore(this.ctx).listHistory(userId, HISTORY_PAGE + 1, before);
    return {
      entries: rows.slice(0, HISTORY_PAGE).map(historyEntryOf),
      hasMore: rows.length > HISTORY_PAGE,
    };
  }

  private async handleLeaderboard(userId: string): Promise<CEERankedLeaderboard> {
    const store = requireStore(this.ctx);
    const now = this.ctx.now();
    let cache = this.leaderboardCache;
    if (!cache || now - cache.at >= LEADERBOARD_TTL_MS) {
      const [rows, counted] = await Promise.all([
        store.listLeaderboard(CEE_RANKED_PLACEMENT_SERIES, LEADERBOARD_SIZE),
        store.countLeaderboard(CEE_RANKED_PLACEMENT_SERIES),
      ]);
      cache = { rows, total: counted.total, at: now };
      this.leaderboardCache = cache;
    }
    const entries = cache.rows.map((row, index) => ({
      rank: index + 1,
      name: row.name,
      rating: displayCEERating(row),
      wins: row.wins,
      losses: row.losses,
      seriesPlayed: row.seriesPlayed,
      self: row.userId === userId,
    }));
    const listed = entries.find((entry) => entry.self);
    if (listed)
      return { entries, self: { rank: listed.rank, rating: listed.rating }, total: cache.total };
    // 榜外的本人现查名次：定级中或没打过不进榜。
    const record = await store.getRating(userId);
    if (!record || record.seriesPlayed < CEE_RANKED_PLACEMENT_SERIES)
      return { entries, self: null, total: cache.total };
    const { above, total } = await store.countLeaderboard(
      CEE_RANKED_PLACEMENT_SERIES,
      record.rating
    );
    return {
      entries,
      self: { rank: above + 1, rating: displayCEERating(record) },
      total: Math.max(total, cache.total),
    };
  }

  // ==================== 人机驱动 ====================

  /** 到点就出手；取不到视图的固定首猜只跳过、不占次数。 */
  private driveBot(runtime: CEERankedSeriesRuntime, now: number): void {
    const game = runtime.series.current;
    if (!game || game.phase === "settled") {
      runtime.botNextGuessAt = null;
      runtime.brain = null;
      return;
    }
    if (game.phase === "countdown") return;
    const brain = this.ensureBrain(runtime, game, now);
    // 加时或补回次数后重新排一手。
    if (runtime.botNextGuessAt === null && !ceeRankedGameSeatFinished(game.seats[BOT_SEAT]))
      runtime.botNextGuessAt = now + this.thinkMs(runtime, brain);
    for (let guard = 0; guard < 64; guard += 1) {
      const at = runtime.botNextGuessAt;
      if (at === null || at > now) return;
      this.botMove(runtime, brain, game, now);
    }
  }

  private ensureBrain(
    runtime: CEERankedSeriesRuntime,
    game: CEERankedGame,
    now: number
  ): CEERankedBotBrain {
    const existing = runtime.brain;
    if (existing && existing.gameNumber === game.number) return existing.brain;
    const spec = runtime.botSpec;
    if (spec === null) throw new AppError("RANKED_UNAVAILABLE", "排位人机状态不完整");
    const brain = createCEERankedBot({
      persona: spec.persona,
      strength: spec.strength,
      // 爱噶的思考节奏按开赛时定下的强度分（已扣校准偏差），整场不变，与审计记录一致。
      opponentRating: spec.strengthRating,
      pool: runtime.pool.candidates,
      random: this.ctx.random,
    });
    runtime.brain = { brain, gameNumber: game.number };
    runtime.botNextGuessAt = Math.max(game.startsAt, now) + this.thinkMs(runtime, brain);
    return brain;
  }

  private thinkMs(runtime: CEERankedSeriesRuntime, brain: CEERankedBotBrain): number {
    return ceeRankedBotThinkMs(brain, this.consistentCount(runtime, brain), this.ctx.random);
  }

  /** 一致候选数：人机「知道自己还没排除掉多少个」，影响它的犹豫程度。 */
  private consistentCount(runtime: CEERankedSeriesRuntime, brain: CEERankedBotBrain): number {
    const eligible = ceeRankedBotEligible(brain, runtime.pool.candidates);
    return filterCEECandidates(
      eligible,
      brain.observations,
      brain.strength.dims,
      runtime.series.settings
    ).length;
  }

  private botMove(
    runtime: CEERankedSeriesRuntime,
    brain: CEERankedBotBrain,
    game: CEERankedGame,
    now: number
  ): void {
    const settings = runtime.series.settings;
    let id: number;
    try {
      id = nextCEERankedBotGuess(
        brain,
        runtime.pool.candidates,
        runtime.pool.openings,
        settings,
        this.ctx.random
      );
    } catch (error) {
      // 没有可猜的已知角色：本局不再出手，交给截止与加时规则收口。
      if (error instanceof AppError && error.code === "RANKED_NO_CANDIDATE") {
        runtime.botNextGuessAt = null;
        return;
      }
      throw error;
    }
    const view = this.botView(runtime, id);
    if (view === null) {
      // 数据集里没有这个角色的视图：记进已猜、推进步数，立刻再要下一手，不占对局次数。
      brain.guessed.add(id);
      brain.step += 1;
      return;
    }
    const guess = applyCEERankedSeriesGuess(runtime.series, BOT_SEAT, view, now);
    recordCEERankedBotFeedback(brain, view, guess.feedback);
    const current = runtime.series.current;
    if (current !== game || current === null) {
      runtime.botNextGuessAt = null;
      return;
    }
    runtime.botNextGuessAt = ceeRankedGameSeatFinished(current.seats[BOT_SEAT])
      ? null
      : now + this.thinkMs(runtime, brain);
  }

  private botView(runtime: CEERankedSeriesRuntime, id: number): CEECharacterView | null {
    const candidate = runtime.pool.candidates.find((item) => item.character.id === id);
    if (candidate) return candidate.character;
    return runtime.pool.extras.find((item) => item.id === id) ?? null;
  }

  // ==================== 结算 ====================

  private async settle(runtime: CEERankedSeriesRuntime): Promise<void> {
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
        this.leaderboardCache = null;
        return true;
      } catch (error) {
        // 事务可能已提交而响应丢了：重试会撞主键。先确认这场是否已落库，已落库就当作成功。
        if (await this.alreadySaved(seriesId)) {
          this.leaderboardCache = null;
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

  /**
   * 结果页离开：只解开离开的这一方，两位玩家都不再看这场时才彻底丢弃运行时。
   * 另一方可能还停在结果页上，替他解绑会让他的「返回」报「没有可离开的结果页」。
   */
  private forgetSeries(runtime: CEERankedSeriesRuntime, userId: string): void {
    if (this.ctx.seriesByUser.get(userId) === runtime) this.ctx.seriesByUser.delete(userId);
    const stillWatched = runtime.seats.some(
      (seat) => seat.userId !== null && this.ctx.seriesByUser.get(seat.userId) === runtime
    );
    if (stillWatched) return;
    this.cancelTimer(runtime);
    this.ctx.seriesById.delete(runtime.series.id);
  }

  /**
   * 结果页停留过久的场次：结算落定且超过保留时长就替还挂着的玩家离开并推 idle。
   * 一方关掉客户端不再回来时，运行时不能一直留在内存里。
   */
  /** 上一位对手与人格只在各自的避让窗口内有意义，过期即清，账号数再多也不会无界增长。 */
  private sweepRecentOpponents(now: number): void {
    for (const [userId, last] of this.ctx.lastOpponent)
      if (now - last.at >= CEE_RANKED_REMATCH_COOLDOWN_MS) this.ctx.lastOpponent.delete(userId);
    for (const [userId, last] of this.ctx.lastPersona)
      if (now - last.at >= SETTLED_RETENTION_MS) this.ctx.lastPersona.delete(userId);
  }

  private sweepSettled(now: number): void {
    for (const runtime of [...this.ctx.seriesById.values()]) {
      const { series } = runtime;
      if (series.phase !== "settled" || !runtime.settlementDone) continue;
      if ((series.endedAt ?? now) + SETTLED_RETENTION_MS > now) continue;
      for (const seat of runtime.seats) {
        if (seat.userId === null || this.ctx.seriesByUser.get(seat.userId) !== runtime) continue;
        this.forgetSeries(runtime, seat.userId);
        pushState(this.ctx, seat.userId, idleState());
      }
      // 没有任何人挂着（理论上不会出现）也照样丢掉。
      this.cancelTimer(runtime);
      this.ctx.seriesById.delete(series.id);
    }
  }

}

/** 校准分组：爱噶单独一组，其余人格共用一组。 */
function botGroupOf(personaId: CEERankedPersonaId): CEERankedBotGroup {
  return personaId === "aiga" ? "aiga" : "regular";
}

/** 战绩列表的一条：由结算记录换算结果与分差。 */
function historyEntryOf(item: CEERankedHistoryRecord): CEERankedHistoryEntry {
  const outcome: CEERankedOutcome =
    item.score === 1 ? "won" : item.score === 0.5 ? "drawn" : "lost";
  const delta =
    item.rated && item.ratingBefore !== null && item.ratingAfter !== null
      ? Math.round(item.ratingAfter) - Math.round(item.ratingBefore)
      : null;
  return {
    seriesId: item.seriesId,
    endedAt: item.endedAt,
    tierId: item.tier as CEERankedTierId,
    opponentName: item.opponentName,
    opponentIsBot: item.opponentIsBot,
    outcome,
    selfPoints: item.selfPoints,
    opponentPoints: item.opponentPoints,
    ratingDelta: delta,
    placement: item.placement,
  };
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

