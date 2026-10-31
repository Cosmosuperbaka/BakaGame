// ==================== 排位赛应用服务 ====================
// 纯规则与状态机都在 domain/CEERanked*，这里只管时钟、连接、题库、人机大脑与结算写库。
import type { CEECharacterView, ConnectionRecord } from "../shared/Index";
import type { ClientEnvelope } from "../shared/Protocol";
import type {
  CEERankedCommand,
  CEERankedHistoryEntry,
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
  CEE_RANKED_RULESET,
  CEE_RANKED_STATE_EVENT,
  ceeRankedTierFor,
  type CEERankedSettlement,
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
  type CEERankedSeries,
} from "../domain/CEERankedSeries";
import {
  ceeRankedGameSeatFinished,
  type CEERankedGame,
  type CEERankedSeatIndex,
} from "../domain/CEERankedGame";
import {
  conservativeCEERating,
  createCEERating,
  displayCEERating,
  rateCEEBotSeries,
  rateCEESeries,
  type CEERating,
} from "../domain/CEERankedRating";
import {
  ceeRankedBotStrength,
  ceeRankedBotThinkMs,
  ceeRankedBotEligible,
  createCEERankedBot,
  nextCEERankedBotGuess,
  pickCEERankedPersona,
  recordCEERankedBotFeedback,
  type CEERankedBotBrain,
  type CEERankedBotStrength,
  type CEERankedPersona,
  type CEERankedPersonaId,
} from "../domain/CEERankedBot";
import { filterCEECandidates, type CEERankedCandidate } from "../domain/CEERankedSolver";
import type { CEEDataProvider } from "../infrastructure/CEEData";
import type { EventLogger } from "../infrastructure/EventLogger";
import { createEvent } from "../transport/Packets";
import {
  ceeClientTypeOf,
  type CEEGuessClientType,
  type CEESearchProvenance,
} from "./CEEAntiCheatSignals";
import { requireCEEClientAdmission } from "./CEEClientAdmission";
import { CEERankedHandicap, type CEERankedBotGroup } from "./CEERankedHandicap";
import { CEERankedQueue, ceeRankedWindow, type CEERankedQueueEntry } from "./CEERankedQueue";
import type { CEERankedPool, CEERankedPoolProvider } from "./CEERankedPool";
import {
  ceeRankedSeriesView,
  type CEERankedSeatMeta,
  type CEERankedSeatResultMeta,
  type CEERankedViewMeta,
} from "./CEERankedViews";
import {
  ceeRankedBotSampleOf,
  type CEERankedGameRecord,
  type CEERankedGuessRecord,
  type CEERankedRatingRecord,
  type CEERankedSeriesPlayerRecord,
  type CEERankedSeriesRecord,
  type CEERankedSettlementRecord,
  type CEERankedStore,
} from "./CEERankedStore";

/**
 * 排位命令信封的可穷尽联合：`switch (message.type)` 在这一层就能把 payload 收窄到对应命令，
 * 泛型 `T` 做不到（`CEERankedPayload<T>` 在 T 未实例化时是全部 payload 的并集）。
 */
type CEERankedMessage = {
  [K in CEERankedCommand]: ClientEnvelope<K, CEERankedPayload<K>>;
}[CEERankedCommand];

/** 人机席位固定在 1 号席：真人对局里 0 号是发起者，人机对局里真人也排在 0 号。 */
const BOT_SEAT: CEERankedSeatIndex = 1;
/** 进入人机局的来路：定级期直接开、排队后主动选、排队超时兜底；真人局为空。 */
type CEERankedBotEntry = "manual" | "auto" | "placement" | null;
/** 匹配跳周期：1 秒一跳，只在队列非空时运行。 */
const MATCH_TICK_MS = 1_000;
/** 结算写库缺省重试等待：1 / 3 / 9 秒。 */
const DEFAULT_SETTLE_RETRY_DELAYS_MS = [1_000, 3_000, 9_000];
/** 缺省昵称解析失败时的显示名。 */
const FALLBACK_NAME = "玩家";
/** 启动时灌入的校准样本上限：两组各占 300 的窗口，多取一些才能每组都填满。 */
const HANDICAP_SEED_LIMIT = 600;
/** 每组每攒满这么多新样本打一次当前偏差，便于观察收敛。 */
const HANDICAP_LOG_EVERY = 20;
/** 这三条命令自带准入：其余命令必须已经绑定在该账号的排位连接上。 */
const ADMISSION_COMMANDS: readonly CEERankedCommand[] = [
  "cee.ranked.status",
  "cee.ranked.queue",
  "cee.ranked.playBot",
];

/** 席位运行时：赛前的评级记录整条留着，结算时的胜平负与当日额度都在它基础上加。 */
interface CEERankedSeatRuntime {
  userId: string | null;
  isBot: boolean;
  name: string;
  /** 赛前评级记录；人机席位为 null。 */
  prior: CEERankedRatingRecord | null;
  clientType: CEEGuessClientType | null;
  clientVersion: string | null;
  /** 真人开赛前的排队时长；人机没有排队来源时为 null。 */
  queueWaitMs: number | null;
}

/** 人机席位的整场常量：目标分用于结算，抽定后不再变。 */
interface CEERankedBotSpec {
  persona: CEERankedPersona;
  /** 计分用的对手 μ。 */
  targetRating: number;
  /** 生成 `strength` 与爱噶思考节奏时真正喂进去的分数：目标分减去该组校准偏差。 */
  strengthRating: number;
  strength: CEERankedBotStrength;
}

interface CEERankedSeriesRuntime {
  series: CEERankedSeries;
  tier: CEERankedTier;
  rated: boolean;
  unratedReason: string | null;
  bot: boolean;
  botEntry: CEERankedBotEntry;
  seats: [CEERankedSeatRuntime, CEERankedSeatRuntime];
  /** 人机对局的目标分、人格与强度；真人对局为 null。 */
  botSpec: CEERankedBotSpec | null;
  pool: CEERankedPool;
  /** 当前局的人机大脑；进入新局时重建。 */
  brain: { brain: CEERankedBotBrain; gameNumber: number } | null;
  /** 人机下一次出手时刻；null 表示本局不再出手。 */
  botNextGuessAt: number | null;
  settlement: CEERankedSettlement;
  results: [CEERankedSeatResultMeta | null, CEERankedSeatResultMeta | null];
  /** 写库已经落定（成功或彻底失败），不再重复结算。 */
  settlementDone: boolean;
  /** 结算中的工作：并发进入时等同一个 Promise。 */
  settling: Promise<void> | null;
  /** 猜测 id → 该次猜测前最近一次角色检索的台账。 */
  guessLedger: Map<string, { searchedAt: number | null; searchMatched: boolean }>;
  timerCancel: (() => void) | null;
  timerWakeAt: number | null;
}

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
  private readonly store?: CEERankedStore;
  private readonly poolProvider?: CEERankedPoolProvider;
  private readonly provenance: CEESearchProvenance;
  private readonly resolveName?: (userId: string) => Promise<string | null>;
  private readonly logger?: Pick<EventLogger, "info" | "warn" | "error">;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => () => void;
  private readonly settleRetryDelaysMs: readonly number[];

  private readonly queue = new CEERankedQueue();
  private readonly connections = new Map<string, ConnectionRecord>();
  /** 账号 → 当前排位连接。 */
  private readonly attachment = new Map<string, string>();
  /** 连接 → 账号：断开时据此解绑。 */
  private readonly attachedBy = new Map<string, string>();
  /** 账号 → 系列赛（含结算后仍停在结果页的那场）。 */
  private readonly seriesByUser = new Map<string, CEERankedSeriesRuntime>();
  private readonly seriesById = new Map<string, CEERankedSeriesRuntime>();
  /** 账号 → 上一位真人与该场结束时刻：三分钟内不重复匹配。 */
  private readonly lastOpponent = new Map<string, { userId: string; at: number }>();
  /** 账号 → 上一场人机人格：抽人格时避开。 */
  private readonly lastPersona = new Map<string, CEERankedPersonaId>();
  /** 结算尚未落定的账号：期间 `queue` 回 RANKED_SETTLING。 */
  private readonly settling = new Set<string>();
  /** 同账号在途猜测：一次只允许一条。 */
  private readonly guessing = new Set<string>();
  /** 账号 → 最近一次推送的排队窗口：窗口没变就不重复推。 */
  private readonly pushedWindow = new Map<string, number>();
  /** 正在开赛的账号：异步组装题库与昵称期间，`queue` 报忙、`cancel` 无效。 */
  private readonly starting = new Set<string>();
  /** 人机强度校准：把历史人机战绩折算成每组的偏差，生成强度时扣掉。 */
  private readonly handicap = new CEERankedHandicap();
  private matchCancel: (() => void) | null = null;
  private closed = false;

  constructor(options: CEERankedServiceOptions) {
    this.data = options.data;
    this.store = options.store;
    this.poolProvider = options.pool;
    this.provenance = options.provenance;
    this.resolveName = options.resolveName;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer =
      options.setTimer ??
      ((callback, ms) => {
        const timer = setTimeout(callback, ms);
        timer.unref();
        return () => clearTimeout(timer);
      });
    this.settleRetryDelaysMs = options.settleRetryDelaysMs ?? DEFAULT_SETTLE_RETRY_DELAYS_MS;
    this.seedHandicap();
  }

  /** 启动灌入近期人机战绩作为校准种子：读不到就从零攒，不影响排位可用。 */
  private seedHandicap(): void {
    const store = this.store;
    if (store === undefined) return;
    void store
      .listRecentBotSamples(HANDICAP_SEED_LIMIT)
      .then((samples) => {
        this.handicap.seed(samples);
      })
      .catch((error: unknown) => {
        this.logger?.warn("排位人机校准种子读取失败", { error: errorMessageOf(error) });
      });
  }

  // ==================== 连接生命周期 ====================

  registerConnection(connection: ConnectionRecord): void {
    this.connections.set(connection.id, connection);
  }

  unregisterConnection(connectionId: string): void {
    this.connections.delete(connectionId);
    const userId = this.attachedBy.get(connectionId);
    if (userId === undefined) return;
    if (this.attachment.get(userId) !== connectionId) return;
    this.attachment.delete(userId);
    this.attachedBy.delete(connectionId);
    if (this.queue.remove(userId)) this.pushedWindow.delete(userId);
    const runtime = this.seriesByUser.get(userId);
    if (!runtime || runtime.series.phase === "settled") return;
    const seat = this.seatOf(runtime, userId);
    if (seat === null) return;
    setCEERankedSeatOnline(runtime.series, seat, false, this.now());
    this.scheduleTimer(runtime);
  }

  /** 关停：只推 idle 并记账作废的系列赛，计时器由 `close` 清。 */
  notifyShutdown(): void {
    for (const connectionId of this.attachment.values()) {
      const connection = this.connections.get(connectionId);
      if (connection) connection.send(createEvent(CEE_RANKED_STATE_EVENT, idleState()));
    }
    for (const runtime of this.seriesById.values()) {
      if (runtime.series.phase === "settled") continue;
      this.logger?.warn("进程关停，排位系列赛作废", { seriesId: runtime.series.id });
    }
  }

  close(): void {
    this.closed = true;
    if (this.matchCancel) {
      this.matchCancel();
      this.matchCancel = null;
    }
    for (const runtime of this.seriesById.values()) this.cancelTimer(runtime);
  }

  /** 兜底巡检：队列非空但匹配计时器断了就重排，唤醒时刻已过但计时器没动的场次补一次唤醒。 */
  runHousekeeping(): void {
    if (this.closed) return;
    if (this.queue.size > 0 && !this.matchCancel) this.scheduleMatchTick();
    const now = this.now();
    for (const runtime of [...this.seriesById.values()]) {
      if (runtime.timerWakeAt === null || runtime.timerWakeAt > now) continue;
      this.cancelTimer(runtime);
      void this.wakeSeries(runtime);
    }
  }

  // ==================== 命令入口 ====================

  async execute<T extends CEERankedCommand>(
    connection: ConnectionRecord,
    message: ClientEnvelope<T, CEERankedPayload<T>>
  ): Promise<CEERankedResponse<T>> {
    this.requireStore();
    this.requirePool();
    const needsAdmission = ADMISSION_COMMANDS.includes(message.type);
    if (needsAdmission) requireCEEClientAdmission(connection, "ranked");
    const userId = connection.account?.userId;
    if (userId === undefined) {
      // 走到这里说明不是准入命令（准入已经拦下未登录），也就是没有绑定关系。
      throw new AppError("RANKED_NOT_ATTACHED", "请重新进入排位");
    }
    if (needsAdmission) this.bind(userId, connection);
    else if (this.attachment.get(userId) !== connection.id)
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
      case "cee.ranked.characterSearch": {
        this.requireInSeries(userId);
        return { results: await this.data.searchCharacters(message.payload.keyword) };
      }
      case "cee.ranked.subjectSearch": {
        this.requireInSeries(userId);
        return { results: await this.data.searchSubjects(message.payload.keyword) };
      }
      case "cee.ranked.subjectCharacters": {
        this.requireInSeries(userId);
        return { results: await this.data.getSubjectCharacters(message.payload.subjectId) };
      }
      case "cee.ranked.characterImage": {
        this.requireInSeries(userId);
        return {
          imageUrl: await this.data.resolveCharacterImage(
            message.payload.characterId,
            message.payload.size ?? "grid"
          ),
        };
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
    const previous = this.attachment.get(userId);
    if (previous !== undefined && previous !== connection.id) {
      const old = this.connections.get(previous);
      if (old) old.send(createEvent(CEE_RANKED_STATE_EVENT, idleState()));
      this.attachedBy.delete(previous);
    }
    this.attachment.set(userId, connection.id);
    this.attachedBy.set(connection.id, userId);
    const runtime = this.seriesByUser.get(userId);
    if (!runtime || runtime.series.phase === "settled") return;
    const seat = this.seatOf(runtime, userId);
    if (seat === null) return;
    setCEERankedSeatOnline(runtime.series, seat, true, this.now());
    this.scheduleTimer(runtime);
  }

  private seatOf(runtime: CEERankedSeriesRuntime, userId: string): CEERankedSeatIndex | null {
    if (runtime.seats[0].userId === userId) return 0;
    if (runtime.seats[1].userId === userId) return 1;
    return null;
  }

  private connectionFor(userId: string): ConnectionRecord | undefined {
    const connectionId = this.attachment.get(userId);
    if (connectionId === undefined) return undefined;
    return this.connections.get(connectionId);
  }

  /** 命令要求账号正在打一场未结束的系列赛。 */
  private requireInSeries(userId: string): void {
    const runtime = this.seriesByUser.get(userId);
    if (runtime && runtime.series.phase !== "settled") return;
    throw new AppError("INVALID_PHASE", "排位搜索只在系列赛进行中可用");
  }

  private push(userId: string, state: CEERankedState): void {
    const connection = this.connectionFor(userId);
    if (!connection) return;
    connection.send(createEvent(CEE_RANKED_STATE_EVENT, state));
  }

  private pushSeries(runtime: CEERankedSeriesRuntime): void {
    for (const index of [0, 1] as const) {
      const seat = runtime.seats[index];
      if (seat.isBot || seat.userId === null) continue;
      const view = ceeRankedSeriesView(runtime.series, index, this.metaFor(runtime));
      this.push(seat.userId, { status: "series", series: view });
    }
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
    const runtime = this.seriesByUser.get(userId);
    if (runtime) {
      const seat = this.requireSeat(runtime, userId);
      return {
        status: "series",
        series: ceeRankedSeriesView(runtime.series, seat, this.metaFor(runtime)),
      };
    }
    const entry = this.queue.get(userId);
    if (entry) return this.queuedState(entry, this.now());
    return { status: "idle" };
  }

  /** 席位归属已由 `seriesByUser` 保证，取不到说明绑定关系被破坏。 */
  private requireSeat(runtime: CEERankedSeriesRuntime, userId: string): CEERankedSeatIndex {
    const seat = this.seatOf(runtime, userId);
    if (seat === null) throw new AppError("RANKED_NOT_ATTACHED", "请重新进入排位");
    return seat;
  }

  private seatMeta(runtime: CEERankedSeriesRuntime, index: CEERankedSeatIndex): CEERankedSeatMeta {
    const seat = runtime.seats[index];
    const prior = seat.prior;
    if (seat.isBot || prior === null) return { rating: null, placementPlayed: null, online: true };
    const placed = prior.seriesPlayed >= CEE_RANKED_PLACEMENT_SERIES;
    return {
      rating: placed ? displayCEERating(prior) : null,
      placementPlayed: placed ? null : prior.seriesPlayed,
      online: runtime.series.seats[index].offlineSince === null,
    };
  }

  private metaFor(runtime: CEERankedSeriesRuntime): CEERankedViewMeta {
    return {
      seats: [this.seatMeta(runtime, 0), this.seatMeta(runtime, 1)],
      rated: runtime.rated,
      settlement: runtime.settlement,
      results: runtime.results,
    };
  }

  // ==================== 排队与开赛场次 ====================

  private async handleStatus(userId: string): Promise<CEERankedState> {
    const state = this.snapshot(userId);
    this.push(userId, state);
    return state;
  }

  private async handleQueue(userId: string): Promise<Record<string, never>> {
    if (this.settling.has(userId)) throw new AppError("RANKED_SETTLING", "上一场还在结算");
    if (this.starting.has(userId)) throw new AppError("RANKED_STARTING", "正在为你开赛");
    if (this.queue.get(userId)) throw new AppError("RANKED_ALREADY_QUEUED", "已经在排队了");
    const current = this.seriesByUser.get(userId);
    if (current) {
      if (current.series.phase !== "settled")
        throw new AppError("RANKED_IN_SERIES", "请先打完当前这场");
      // 结果页还留着：重新排队前先自动离开。
      this.forgetSeries(current, userId);
      this.push(userId, idleState());
    }
    // 在读评级之前就先占位：连点两次 `queue` 不会开出两场。
    this.starting.add(userId);
    try {
      const prior = (await this.requireStore().getRating(userId)) ?? initialRatingRecord(userId);
      const entry: CEERankedQueueEntry = {
        userId,
        rating: prior.rating,
        queuedAt: this.now(),
        lastOpponent: this.lastOpponent.get(userId) ?? null,
      };
      // 定级赛只打人机：不满 5 场不进真人队列，直接开一场，推给客户端的就是系列赛。
      if (prior.seriesPlayed < CEE_RANKED_PLACEMENT_SERIES) {
        await this.startBotSeries(userId, "placement", entry);
        return {};
      }
      this.queue.add(entry);
      this.push(userId, this.queuedState(entry, this.now()));
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
    this.push(userId, idleState());
    return {};
  }

  private async handlePlayBot(userId: string): Promise<Record<string, never>> {
    const entry = this.queue.get(userId);
    if (!entry) throw new AppError("INVALID_PHASE", "当前不在排队中");
    if (this.now() - entry.queuedAt < CEE_RANKED_BOT_OPTION_MS)
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
    try {
      await open();
    } finally {
      for (const userId of userIds) this.starting.delete(userId);
    }
  }

  private scheduleMatchTick(): void {
    if (this.matchCancel !== null || this.queue.size === 0 || this.closed) return;
    this.matchCancel = this.setTimer(() => {
      this.matchCancel = null;
      void this.tickMatch()
        .catch((error: unknown) => {
          this.logger?.error("排位匹配跳异常", { error: errorMessageOf(error) });
        })
        .finally(() => {
          if (!this.closed && this.queue.size > 0 && this.matchCancel === null)
            this.scheduleMatchTick();
        });
    }, MATCH_TICK_MS);
  }

  private async tickMatch(): Promise<void> {
    const now = this.now();
    const { pairs, fallbacks } = this.queue.tick(now);
    // 一场开失败不能带走整跳：其余候选照常开赛，失败的两位回队列外等下一次点排队。
    for (const [first, second] of pairs) {
      try {
        await this.guardedStart([first.userId, second.userId], () =>
          this.startHumanSeries(first, second, now)
        );
      } catch (error) {
        this.logger?.error("排位开赛失败", {
          userIds: [first.userId, second.userId],
          error: errorMessageOf(error),
        });
        this.resetToIdle(first.userId);
        this.resetToIdle(second.userId);
      }
    }
    for (const entry of fallbacks) {
      try {
        await this.guardedStart([entry.userId], () =>
          this.startBotSeries(entry.userId, "auto", entry, now)
        );
      } catch (error) {
        this.logger?.error("排位开赛失败", {
          userIds: [entry.userId],
          error: errorMessageOf(error),
        });
        this.resetToIdle(entry.userId);
      }
    }
    // 仍在排队的人窗口可能又放宽了一档，只给变化的推一帧。
    for (const userId of this.attachment.keys()) {
      const entry = this.queue.get(userId);
      if (!entry) continue;
      if (ceeRankedWindow(entry, now) === this.pushedWindow.get(userId)) continue;
      this.push(userId, this.queuedState(entry, now));
    }
  }

  /** 排位连接都在 `attachment` 里，排队中的账号必然有一条：据此推送，队列不必暴露迭代口。 */
  private async startHumanSeries(
    first: CEERankedQueueEntry,
    second: CEERankedQueueEntry,
    now: number
  ): Promise<void> {
    const store = this.requireStore();
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
    const pool = await this.requirePool().getRankedPool(tier.id, now);
    const answers = pickAnswers(pool.candidates, this.random);
    if (!answers) {
      this.logger?.error("排位题库不足三题", {
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
    now = this.now()
  ): Promise<void> {
    const prior = (await this.requireStore().getRating(userId)) ?? initialRatingRecord(userId);
    const rating = toRating(prior);
    const tier = ceeRankedTierFor(conservativeCEERating(rating, now));
    const pool = await this.requirePool().getRankedPool(tier.id, now);
    const answers = pickAnswers(pool.candidates, this.random);
    if (!answers) {
      this.logger?.error("排位题库不足三题", { userId, tier: tier.id });
      this.resetToIdle(userId);
      return;
    }
    const persona = pickCEERankedPersona(this.random, this.lastPersona.get(userId));
    // 爱噶的目标分就是玩家自己的分数，其余人格在 ±120 内浮动。
    const targetRating =
      persona.id === "aiga" ? rating.rating : rating.rating + (this.random() * 240 - 120);
    // 按该组的校准偏差回退后才生成强度，计分仍用目标分。
    const strengthRating = targetRating - this.handicap.bias(botGroupOf(persona.id));
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
        strength: ceeRankedBotStrength(strengthRating, this.random),
      },
    });
    this.lastPersona.set(userId, persona.id);
  }

  private humanSeat(
    userId: string,
    name: string,
    prior: CEERankedRatingRecord,
    entry: CEERankedQueueEntry,
    now: number
  ): CEERankedSeatRuntime {
    const connection = this.connectionFor(userId);
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
    const found = await this.resolveName?.(userId);
    return found ?? FALLBACK_NAME;
  }

  /** 题库不足三题：两人各回空闲，等待下一场匹配。 */
  private resetToIdle(userId: string): void {
    this.queue.remove(userId);
    this.pushedWindow.delete(userId);
    this.seriesByUser.delete(userId);
    this.push(userId, idleState());
  }

  private open(input: {
    tier: CEERankedTier;
    pool: CEERankedPool;
    answers: [CEECharacterView, CEECharacterView, CEECharacterView];
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
      random: this.random,
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
    this.seriesById.set(series.id, runtime);
    for (const seat of input.seats) {
      if (seat.isBot || seat.userId === null) continue;
      this.seriesByUser.set(seat.userId, runtime);
      this.pushedWindow.delete(seat.userId);
    }
    this.pushSeries(runtime);
    this.scheduleTimer(runtime);
  }

  // ==================== 计时与推进 ====================

  private scheduleTimer(runtime: CEERankedSeriesRuntime): void {
    this.cancelTimer(runtime);
    if (this.closed) return;
    if (runtime.series.phase === "settled" && runtime.settlementDone) return;
    const wake = this.nextWakeAt(runtime);
    if (wake === null) return;
    runtime.timerWakeAt = wake;
    const cancel = this.setTimer(
      () => {
        runtime.timerCancel = null;
        runtime.timerWakeAt = null;
        void this.wakeSeries(runtime);
      },
      Math.max(1, wake - this.now())
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

  private async wakeSeries(runtime: CEERankedSeriesRuntime): Promise<void> {
    if (!this.seriesById.has(runtime.series.id)) return;
    await this.afterChange(runtime);
  }

  /** 任何改动系列赛之后的统一收尾：推进时间、驱动人机、必要时结算、推送、重排计时器。 */
  private async afterChange(runtime: CEERankedSeriesRuntime): Promise<void> {
    const now = this.now();
    tickCEERankedSeries(runtime.series, now);
    if (runtime.bot) this.driveBot(runtime, now);
    // 写库可能带重试，不能压住命令 ACK：结算自己会先推「结算中」再推结果。
    if (runtime.series.phase === "settled" && !runtime.settlementDone)
      void this.settle(runtime).catch((error: unknown) => {
        this.logger?.error("排位结算异常", {
          seriesId: runtime.series.id,
          error: errorMessageOf(error),
        });
      });
    this.pushSeries(runtime);
    this.scheduleTimer(runtime);
  }

  // ==================== 对局命令 ====================

  private async handleGuess(
    userId: string,
    connection: ConnectionRecord,
    characterId: number
  ): Promise<Record<string, never>> {
    const runtime = this.seriesByUser.get(userId);
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
      const guess = applyCEERankedSeriesGuess(runtime.series, seat, view, this.now());
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
    surrenderCEERankedSeriesGame(runtime.series, seat, this.now());
    await this.afterChange(runtime);
    return {};
  }

  private async handleExit(userId: string): Promise<Record<string, never>> {
    const runtime = this.requirePlaying(userId);
    const seat = this.requireSeat(runtime, userId);
    exitCEERankedSeries(runtime.series, seat, this.now());
    await this.afterChange(runtime);
    return {};
  }

  private handleLeave(userId: string): Record<string, never> {
    const runtime = this.seriesByUser.get(userId);
    if (!runtime || runtime.series.phase !== "settled")
      throw new AppError("INVALID_PHASE", "当前没有可离开的结果页");
    this.forgetSeries(runtime, userId);
    this.push(userId, idleState());
    return {};
  }

  private requirePlaying(userId: string): CEERankedSeriesRuntime {
    const runtime = this.seriesByUser.get(userId);
    if (runtime && runtime.series.phase !== "settled") return runtime;
    throw new AppError("INVALID_PHASE", "当前没有进行中的对局");
  }

  private async handleProfile(userId: string): Promise<CEERankedProfile> {
    const store = this.requireStore();
    const record = (await store.getRating(userId)) ?? initialRatingRecord(userId);
    const history = await store.listHistory(userId, 20);
    const placed = record.seriesPlayed >= CEE_RANKED_PLACEMENT_SERIES;
    const today = beijingDay(this.now());
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
      recent: history.map((item): CEERankedHistoryEntry => {
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
      }),
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
      random: this.random,
    });
    runtime.brain = { brain, gameNumber: game.number };
    runtime.botNextGuessAt = Math.max(game.startsAt, now) + this.thinkMs(runtime, brain);
    return brain;
  }

  private thinkMs(runtime: CEERankedSeriesRuntime, brain: CEERankedBotBrain): number {
    return ceeRankedBotThinkMs(brain, this.consistentCount(runtime, brain), this.random);
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
        this.random
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
    await work;
    runtime.settling = null;
  }

  private async doSettle(runtime: CEERankedSeriesRuntime): Promise<void> {
    const endedAt = runtime.series.endedAt ?? this.now();
    const userIds: string[] = [];
    for (const seat of runtime.seats) {
      if (seat.isBot || seat.userId === null) continue;
      userIds.push(seat.userId);
    }
    for (const userId of userIds) this.settling.add(userId);
    runtime.settlement = "pending";
    this.pushSeries(runtime);

    const outcome = await this.writeSettlement(runtime, endedAt);
    runtime.results = outcome.results;
    runtime.settlement = outcome.written ? (runtime.rated ? "rated" : "unrated") : "failed";
    runtime.settlementDone = true;
    for (const userId of userIds) this.settling.delete(userId);
    this.rememberOpponents(runtime, endedAt);
    this.pushSeries(runtime);
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
    this.handicap.add(sample);
    const samples = this.handicap.count(sample.group);
    if (samples % HANDICAP_LOG_EVERY !== 0) return;
    this.logger?.info("排位人机校准", {
      group: sample.group,
      bias: this.handicap.bias(sample.group),
      samples,
    });
  }

  private async saveWithRetry(
    record: CEERankedSettlementRecord,
    seriesId: string
  ): Promise<boolean> {
    const store = this.requireStore();
    const attempts = this.settleRetryDelaysMs.length + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await store.saveSettlement(record);
        return true;
      } catch (error) {
        if (attempt + 1 >= attempts) {
          this.logger?.error("排位结算写库失败", {
            seriesId,
            record,
            error: errorMessageOf(error),
          });
          return false;
        }
        await this.wait(this.settleRetryDelaysMs[attempt] ?? 0);
      }
    }
    return false;
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (ms <= 0) {
        resolve();
        return;
      }
      let cancel: (() => void) | null = null;
      cancel = this.setTimer(() => {
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
        if (spec !== null) this.lastPersona.set(self.userId, spec.persona.id);
      } else if (other.userId !== null)
        this.lastOpponent.set(self.userId, { userId: other.userId, at });
    }
  }

  /** 结果页离开：两位玩家都不再看这场时才彻底丢弃运行时。 */
  private forgetSeries(runtime: CEERankedSeriesRuntime, userId: string): void {
    this.seriesByUser.delete(userId);
    for (const seat of runtime.seats) {
      if (seat.userId !== null) this.seriesByUser.delete(seat.userId);
    }
    const stillWatched = [...this.seriesByUser.values()].includes(runtime);
    if (stillWatched) return;
    this.cancelTimer(runtime);
    this.seriesById.delete(runtime.series.id);
  }

  private requireStore(): CEERankedStore {
    const store = this.store;
    if (store === undefined) throw new AppError("RANKED_UNAVAILABLE", "排位赛暂不可用");
    return store;
  }

  private requirePool(): CEERankedPoolProvider {
    const pool = this.poolProvider;
    if (pool === undefined) throw new AppError("RANKED_UNAVAILABLE", "排位赛暂不可用");
    return pool;
  }
}

const idleState = (): CEERankedState => ({ status: "idle" });

/** 写日志用的错误摘要：Error 取 message，其余原样转字符串。 */
function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 校准分组：爱噶单独一组，其余人格共用一组。 */
function botGroupOf(personaId: CEERankedPersonaId): CEERankedBotGroup {
  return personaId === "aiga" ? "aiga" : "regular";
}

/** 审计表里的角色名：中文名优先，没有中文名的旧数据回落到原名。 */
function auditNameOf(character: { name: string; nameCn: string }): string {
  return character.nameCn || character.name;
}

/** 从审计记录取回评级三参数。 */
function toRating(record: CEERankedRatingRecord): CEERating {
  return { rating: record.rating, rd: record.rd, lastPlayedAt: record.lastPlayedAt };
}

/** 没有评级记录时的初值：与 `createCEERating` 同一口径。 */
function initialRatingRecord(userId: string): CEERankedRatingRecord {
  const base = createCEERating();
  return {
    userId,
    rating: base.rating,
    rd: base.rd,
    seriesPlayed: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    botRatedDay: null,
    botRatedCount: 0,
    lastPlayedAt: base.lastPlayedAt,
  };
}

/** 按先验权重无放回抽 3 个答案；题库不足 3 个返回 null。 */
function pickAnswers(
  candidates: readonly CEERankedCandidate[],
  random: () => number
): [CEECharacterView, CEECharacterView, CEECharacterView] | null {
  if (candidates.length < 3) return null;
  const rest = [...candidates];
  const picked: CEERankedCandidate[] = [];
  while (picked.length < 3) {
    const index = weightedIndex(
      rest.map((item) => Math.max(0, item.weight)),
      random
    );
    picked.push(rest[index]);
    rest.splice(index, 1);
  }
  return [picked[0].character, picked[1].character, picked[2].character];
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

/** 人机系列赛是否计分：定级中恒计分，已定级看当日额度。 */
function shouldRateBotSeries(record: CEERankedRatingRecord, now: number): boolean {
  if (record.seriesPlayed < CEE_RANKED_PLACEMENT_SERIES) return true;
  if (record.botRatedDay !== beijingDay(now)) return true;
  return record.botRatedCount < CEE_RANKED_BOT_DAILY_RATED;
}

/** 结算后的评级行：计分才换 μ/φ，场数与胜平负无论计分与否都进账。 */
function nextRatingRecord(
  prior: CEERankedRatingRecord,
  after: CEERating,
  score: 0 | 0.5 | 1,
  runtime: CEERankedSeriesRuntime,
  endedAt: number
): CEERankedRatingRecord {
  const rated = runtime.rated;
  const today = beijingDay(endedAt);
  const usesDailyQuota = runtime.bot && rated && prior.seriesPlayed >= CEE_RANKED_PLACEMENT_SERIES;
  return {
    userId: prior.userId,
    rating: rated ? after.rating : prior.rating,
    rd: rated ? after.rd : prior.rd,
    seriesPlayed: prior.seriesPlayed + 1,
    wins: prior.wins + (score === 1 ? 1 : 0),
    losses: prior.losses + (score === 0 ? 1 : 0),
    draws: prior.draws + (score === 0.5 ? 1 : 0),
    botRatedDay: usesDailyQuota ? today : prior.botRatedDay,
    botRatedCount: usesDailyQuota
      ? prior.botRatedDay === today
        ? prior.botRatedCount + 1
        : 1
      : prior.botRatedCount,
    lastPlayedAt: rated ? after.lastPlayedAt : prior.lastPlayedAt,
  };
}

/** 赛前与赛后的评级：不计分时原样带回，人机按固定最大不确定度结算。 */
function resolveRatings(
  runtime: CEERankedSeriesRuntime,
  scores: [0 | 0.5 | 1, 0 | 0.5 | 1],
  endedAt: number
): { before: [CEERating, CEERating]; after: [CEERating, CEERating] } {
  const before: [CEERating, CEERating] = [
    runtime.seats[0].prior ? toRating(runtime.seats[0].prior) : createCEERating(),
    runtime.seats[1].prior ? toRating(runtime.seats[1].prior) : createCEERating(),
  ];
  const after: [CEERating, CEERating] = [before[0], before[1]];
  if (!runtime.rated) return { before, after };
  const spec = runtime.botSpec;
  if (spec === null) {
    const pair = rateCEESeries(before[0], before[1], scores[0], endedAt);
    after[0] = pair[0];
    after[1] = pair[1];
  } else {
    // 人机一律按最大不确定度参与计算：它的真实强度只知道「围绕目标分」。
    after[0] = rateCEEBotSeries(before[0], spec.targetRating, scores[0], endedAt);
  }
  return { before, after };
}

/** 需要写回的真人评级行：人机席位没有评级，跳过。 */
function seatRatingRecords(
  runtime: CEERankedSeriesRuntime,
  after: [CEERating, CEERating],
  scores: [0 | 0.5 | 1, 0 | 0.5 | 1],
  endedAt: number
): CEERankedRatingRecord[] {
  const rows: CEERankedRatingRecord[] = [];
  for (const index of [0, 1] as const) {
    const prior = runtime.seats[index].prior;
    if (prior === null) continue;
    rows.push(nextRatingRecord(prior, after[index], scores[index], runtime, endedAt));
  }
  return rows;
}

/** 结果页要展示的赛前/赛后展示分：定级中不显示分数，不计分也不显示。 */
function settlementResults(
  runtime: CEERankedSeriesRuntime,
  rating: { before: [CEERating, CEERating]; after: [CEERating, CEERating] }
): [CEERankedSeatResultMeta | null, CEERankedSeatResultMeta | null] {
  const results: [CEERankedSeatResultMeta | null, CEERankedSeatResultMeta | null] = [null, null];
  for (const index of [0, 1] as const) {
    const prior = runtime.seats[index].prior;
    if (prior === null) continue;
    const playedAfter = prior.seriesPlayed + 1;
    const placed = prior.seriesPlayed >= CEE_RANKED_PLACEMENT_SERIES;
    results[index] = {
      ratingBefore: runtime.rated && placed ? displayCEERating(rating.before[index]) : null,
      ratingAfter:
        runtime.rated && playedAfter >= CEE_RANKED_PLACEMENT_SERIES
          ? displayCEERating(rating.after[index])
          : null,
      placementPlayed: placed ? null : playedAfter,
    };
  }
  return results;
}

function seriesRecord(runtime: CEERankedSeriesRuntime, endedAt: number): CEERankedSeriesRecord {
  const series = runtime.series;
  return {
    id: series.id,
    ruleset: CEE_RANKED_RULESET,
    tier: series.tier,
    answerIds: series.answers.map((answer) => answer.id),
    startedAt: series.createdAt,
    endedAt: series.endedAt ?? endedAt,
    endReason: series.endReason ?? "completed",
    rated: runtime.rated,
    unratedReason: runtime.unratedReason,
    bot: runtime.bot,
    botEntry: runtime.botEntry,
  };
}

function playerRecord(
  runtime: CEERankedSeriesRuntime,
  index: CEERankedSeatIndex,
  score: 0 | 0.5 | 1,
  before: CEERating,
  after: CEERating
): CEERankedSeriesPlayerRecord {
  const seat = runtime.seats[index];
  const prior = seat.prior;
  const rated = runtime.rated;
  const spec = seat.isBot ? runtime.botSpec : null;
  return {
    seat: index,
    userId: seat.userId,
    name: seat.name,
    clientType: seat.isBot ? null : seat.clientType,
    clientVersion: seat.isBot ? null : seat.clientVersion,
    botPersona: spec === null ? null : spec.persona.id,
    botTargetRating: spec === null ? null : spec.targetRating,
    botStrengthRating: spec === null ? null : spec.strengthRating,
    queueWaitMs: seat.queueWaitMs,
    points: runtime.series.seats[index].points,
    score,
    placement: prior !== null && prior.seriesPlayed < CEE_RANKED_PLACEMENT_SERIES,
    ratingBefore: prior === null ? null : before.rating,
    ratingAfter: prior === null ? null : rated ? after.rating : before.rating,
    rdBefore: prior === null ? null : before.rd,
    rdAfter: prior === null ? null : rated ? after.rd : before.rd,
  };
}

function gameRecords(runtime: CEERankedSeriesRuntime, endedAt: number): CEERankedGameRecord[] {
  return runtime.series.games.map((game): CEERankedGameRecord => ({
    number: game.number,
    answerCharacterId: game.answer.id,
    answerName: auditNameOf(game.answer),
    winnerSeat: game.winner,
    endReason: game.endReason ?? "draw",
    attempts: [game.seats[0].attempts, game.seats[1].attempts],
    overtime: game.overtime,
    startedAt: game.startsAt,
    endedAt: game.endedAt ?? endedAt,
  }));
}

function guessRecords(runtime: CEERankedSeriesRuntime): CEERankedGuessRecord[] {
  const rows: CEERankedGuessRecord[] = [];
  for (const game of runtime.series.games) {
    for (const index of [0, 1] as const) {
      const seat = runtime.seats[index];
      game.seats[index].guesses.forEach((guess, position) => {
        const ledger = seat.isBot ? undefined : runtime.guessLedger.get(guess.id);
        rows.push({
          gameNumber: game.number,
          seat: index,
          attempt: position + 1,
          characterId: guess.character.id,
          characterName: auditNameOf(guess.character),
          correct: guess.correct,
          createdAt: guess.createdAt,
          clientType: seat.isBot ? null : seat.clientType,
          searchedAt: ledger?.searchedAt ?? null,
          searchMatched: ledger?.searchMatched ?? null,
        });
      });
    }
  }
  return rows;
}
