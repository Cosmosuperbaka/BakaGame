// ==================== 排位赛运行时 ====================
// 系列赛的运行时结构、各模块共享的上下文，以及向玩家推送状态的公共动作。
// 上下文里的几张表是同一实例的引用，不是拷贝：门面与各模块读写的是同一份。
import type { ConnectionRecord } from "../shared/Index";
import {
  CEE_RANKED_PLACEMENT_SERIES,
  CEE_RANKED_STATE_EVENT,
  type CEERankedSettlement,
  type CEERankedState,
  type CEERankedTier,
} from "../shared/CEERanked";
import { AppError } from "../domain/Errors";
import type { CEERankedSeries } from "../domain/CEERankedSeries";
import type { CEERankedSeatIndex } from "../domain/CEERankedGame";
import { displayCEERating } from "../domain/CEERankedRating";
import type {
  CEERankedBotStrength,
  CEERankedPersona,
  CEERankedPersonaId,
} from "../domain/CEERankedBotProfile";
import type { CEERankedBotBrain } from "../domain/CEERankedBot";
import type { EventLogger } from "../infrastructure/EventLogger";
import { createEvent } from "../transport/Packets";
import type { CEEGuessClientType } from "./CEEAntiCheatSignals";
import type { CEERankedHandicap } from "./CEERankedHandicap";
import type { CEERankedPool, CEERankedPoolProvider } from "./CEERankedPool";
import {
  ceeRankedSeriesView,
  type CEERankedSeatMeta,
  type CEERankedSeatResultMeta,
  type CEERankedViewMeta,
} from "./CEERankedViews";
import type { CEERankedRatingRecord, CEERankedStore } from "./CEERankedStore";

/** 进入人机局的来路：定级期直接开、排队后主动选、排队超时兜底；真人局为空。 */
export type CEERankedBotEntry = "manual" | "auto" | "placement" | null;
/** 席位运行时：赛前的评级记录整条留着，结算时的胜平负与当日额度都在它基础上加。 */
export interface CEERankedSeatRuntime {
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
export interface CEERankedBotSpec {
  persona: CEERankedPersona;
  /** 计分用的对手 μ：普通人格为标称分，爱噶为标称分加该组校准偏差。 */
  targetRating: number;
  /** 生成 `strength` 与爱噶思考节奏时真正喂进去的分数：普通人格为标称分减偏差，爱噶为标称分。 */
  strengthRating: number;
  strength: CEERankedBotStrength;
}

export interface CEERankedSeriesRuntime {
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

/** 各模块共享的上下文：时钟、随机、计时器接缝、依赖与几张跨模块读写的表（全是同一实例的引用）。 */
export interface CEERankedContext {
  /** 审计仓储；未注入（没配数据库）时排位整体不可用。 */
  readonly store?: CEERankedStore;
  /** 题库；未注入时排位整体不可用。 */
  readonly poolProvider?: CEERankedPoolProvider;
  /** 取账号昵称作为排位显示名；取不到时用「玩家」。 */
  readonly resolveName?: (userId: string) => Promise<string | null>;
  readonly logger?: Pick<EventLogger, "info" | "warn" | "error">;
  readonly now: () => number;
  readonly random: () => number;
  readonly setTimer: (callback: () => void, ms: number) => () => void;
  readonly settleRetryDelaysMs: readonly number[];
  /** 人机强度校准：把历史人机战绩折算成每组的偏差，生成强度时扣掉。 */
  readonly handicap: CEERankedHandicap;
  readonly connections: Map<string, ConnectionRecord>;
  /** 账号 → 当前排位连接。 */
  readonly attachment: Map<string, string>;
  /** 账号 → 系列赛（含结算后仍停在结果页的那场）。 */
  readonly seriesByUser: Map<string, CEERankedSeriesRuntime>;
  readonly seriesById: Map<string, CEERankedSeriesRuntime>;
  /** 账号 → 上一位真人与该场结束时刻：三分钟内不重复匹配。 */
  readonly lastOpponent: Map<string, { userId: string; at: number }>;
  /** 账号 → 上一场人机人格：抽人格时避开。 */
  readonly lastPersona: Map<string, { id: CEERankedPersonaId; at: number }>;
}

export const idleState = (): CEERankedState => ({ status: "idle" });

/** 写日志用的错误摘要：Error 取 message，其余原样转字符串。 */
export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function requireStore(ctx: CEERankedContext): CEERankedStore {
  const store = ctx.store;
  if (store === undefined) throw new AppError("RANKED_UNAVAILABLE", "排位赛暂不可用");
  return store;
}


export function requirePool(ctx: CEERankedContext): CEERankedPoolProvider {
  const pool = ctx.poolProvider;
  if (pool === undefined) throw new AppError("RANKED_UNAVAILABLE", "排位赛暂不可用");
  return pool;
}


export function connectionFor(
  ctx: CEERankedContext,
  userId: string
): ConnectionRecord | undefined {
  const connectionId = ctx.attachment.get(userId);
  if (connectionId === undefined) return undefined;
  return ctx.connections.get(connectionId);
}


export function pushState(ctx: CEERankedContext, userId: string, state: CEERankedState): void {
  const connection = connectionFor(ctx, userId);
  if (!connection) return;
  connection.send(createEvent(CEE_RANKED_STATE_EVENT, state));
}


export function pushSeries(ctx: CEERankedContext, runtime: CEERankedSeriesRuntime): void {
  for (const index of [0, 1] as const) {
    const seat = runtime.seats[index];
    if (seat.isBot || seat.userId === null) continue;
    const view = ceeRankedSeriesView(runtime.series, index, metaFor(runtime));
    pushState(ctx, seat.userId, { status: "series", series: view });
  }
}


function seatMeta(runtime: CEERankedSeriesRuntime, index: CEERankedSeatIndex): CEERankedSeatMeta {
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


export function metaFor(runtime: CEERankedSeriesRuntime): CEERankedViewMeta {
  return {
    seats: [seatMeta(runtime, 0), seatMeta(runtime, 1)],
    rated: runtime.rated,
    settlement: runtime.settlement,
    results: runtime.results,
  };
}

