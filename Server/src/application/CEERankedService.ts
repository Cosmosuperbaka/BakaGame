// ==================== 排位赛应用服务 ====================
// 纯规则与状态机都在 domain/CEERanked*，这里只管时钟、连接、题库、人机大脑与结算写库。
import type { ConnectionRecord } from "../shared/Index";
import type { ClientEnvelope } from "../shared/Protocol";
import type {
  CEERankedCommand,
  CEERankedPayload,
  CEERankedResponse,
  CEERankedState,
} from "../shared/CEERanked";
import { CEE_RANKED_OFFLINE_FORFEIT_MS, CEE_RANKED_STATE_EVENT } from "../shared/CEERanked";
import { AppError } from "../domain/Errors";
import {
  applyCEERankedSeriesGuess,
  exitCEERankedSeries,
  setCEERankedSeatOnline,
  surrenderCEERankedSeriesGame,
  tickCEERankedSeries,
} from "../domain/CEERankedSeries";
import { type CEERankedSeatIndex } from "../domain/CEERankedGame";
import type { CEEDataProvider } from "../infrastructure/CEEData";
import type { EventLogger } from "../infrastructure/EventLogger";
import { createEvent } from "../transport/Packets";
import { type CEESearchProvenance } from "./CEEAntiCheatSignals";
import { requireCEEClientAdmission } from "./CEEClientAdmission";
import { CEERankedHandicap } from "./CEERankedHandicap";
import { CEE_RANKED_REMATCH_COOLDOWN_MS } from "./CEERankedQueue";
import type { CEERankedPoolProvider } from "./CEERankedPool";
import { runCEEDataCommand } from "./CEEDataCommands";
import { driveBot } from "./CEERankedBotDriver";
import { CEERankedMatchmaker } from "./CEERankedMatchmaker";
import { CEERankedProfileQueries } from "./CEERankedProfileQueries";
import { CEERankedSettler } from "./CEERankedSettler";
import { ceeRankedSeriesView } from "./CEERankedViews";
import { type CEERankedStore } from "./CEERankedStore";

import {
  errorMessageOf,
  idleState,
  metaFor,
  pushSeries,
  pushState,
  requirePool,
  requireStore,
  type CEERankedContext,
  type CEERankedSeriesRuntime,
} from "./CEERankedRuntime";

/**
 * 排位命令信封的可穷尽联合：`switch (message.type)` 在这一层就能把 payload 收窄到对应命令，
 * 泛型 `T` 做不到（`CEERankedPayload<T>` 在 T 未实例化时是全部 payload 的并集）。
 */
type CEERankedMessage = {
  [K in CEERankedCommand]: ClientEnvelope<K, CEERankedPayload<K>>;
}[CEERankedCommand];

/** 唤醒抛错后的重排退避：同一异常不会让计时器贴着 1ms 空转。 */
const WAKE_RETRY_BACKOFF_MS = 5_000;
/** 结算写库缺省重试等待：1 / 3 / 9 秒。 */
const DEFAULT_SETTLE_RETRY_DELAYS_MS = [1_000, 3_000, 9_000];
/** 启动时灌入的校准样本上限：两组各占 300 的窗口，多取一些才能每组都填满。 */
const HANDICAP_SEED_LIMIT = 600;
/** 结算后结果页最长保留时长：超过就替还挂着的玩家离开，运行时不常驻内存。 */
export const SETTLED_RETENTION_MS = 30 * 60_000;
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
  private readonly profiles: CEERankedProfileQueries;
  private readonly settler: CEERankedSettler;
  private readonly matchmaker: CEERankedMatchmaker;

  /** 连接 → 账号：断开时据此解绑。 */
  private readonly attachedBy = new Map<string, string>();
  /** 同账号在途猜测：一次只允许一条。 */
  private readonly guessing = new Set<string>();
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
    this.profiles = new CEERankedProfileQueries(this.ctx);
    this.settler = new CEERankedSettler(this.ctx, this.profiles);
    this.matchmaker = new CEERankedMatchmaker(this.ctx, {
      isSettling: (userId) => this.settler.isSettling(userId),
      forgetSeries: (runtime, userId) => this.forgetSeries(runtime, userId),
      scheduleTimer: (runtime) => this.scheduleTimer(runtime),
    });
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
    this.matchmaker.dropFromQueue(userId);
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
    this.matchmaker.close();
    for (const runtime of this.ctx.seriesById.values()) this.cancelTimer(runtime);
  }

  /** 兜底巡检：队列非空但匹配计时器断了就重排，唤醒时刻已过但计时器没动的场次补一次唤醒。 */
  runHousekeeping(): void {
    if (this.closed) return;
    this.matchmaker.ensureTick();
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
        return this.matchmaker.enqueue(userId);
      case "cee.ranked.cancel":
        return this.matchmaker.cancel(userId);
      case "cee.ranked.playBot":
        return this.matchmaker.playBot(userId);
      case "cee.ranked.guess":
        return this.handleGuess(userId, connection, message.payload.characterId);
      case "cee.ranked.surrender":
        return this.handleSurrender(userId);
      case "cee.ranked.exit":
        return this.handleExit(userId);
      case "cee.ranked.leave":
        return this.handleLeave(userId);
      case "cee.ranked.profile":
        return this.profiles.profile(userId);
      case "cee.ranked.history":
        return this.profiles.history(userId, message.payload.before);
      case "cee.ranked.leaderboard":
        return this.profiles.leaderboard(userId);
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

  private snapshot(userId: string): CEERankedState {
    const runtime = this.ctx.seriesByUser.get(userId);
    if (runtime) {
      const seat = this.requireSeat(runtime, userId);
      return {
        status: "series",
        series: ceeRankedSeriesView(runtime.series, seat, metaFor(runtime)),
      };
    }
    const queued = this.matchmaker.queuedSnapshot(userId);
    if (queued) return queued;
    return { status: "idle" };
  }

  /** 席位归属已由 `seriesByUser` 保证，取不到说明绑定关系被破坏。 */
  private requireSeat(runtime: CEERankedSeriesRuntime, userId: string): CEERankedSeatIndex {
    const seat = this.seatOf(runtime, userId);
    if (seat === null) throw new AppError("RANKED_NOT_ATTACHED", "请重新进入排位");
    return seat;
  }

  // ==================== 状态查询 ====================

  private async handleStatus(userId: string): Promise<CEERankedState> {
    const state = this.snapshot(userId);
    pushState(this.ctx, userId, state);
    return state;
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
    if (runtime.bot) driveBot(this.ctx, runtime, now);
    // 写库可能带重试，不能压住命令 ACK：结算自己会先推「结算中」再推结果。
    if (runtime.series.phase === "settled" && !runtime.settlementDone)
      void this.settler.settle(runtime).catch((error: unknown) => {
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
