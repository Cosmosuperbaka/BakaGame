// ==================== 排位赛共享契约 ====================
// 规则常量与难度档住在 CEERankedValues.ts（纯值，客户端可取）；对 ./CEE 一律 import type，避免共享层内部成环。
import { Type as t, type Static } from "@sinclair/typebox";
import type { CEERankedTierId } from "./CEERankedValues";
import type {
  CEECharacterSummary,
  CEECharacterView,
  CEEComparison,
  CEEGuess,
  CEESubjectSummary,
} from "./CEE";

export * from "./CEERankedValues";

export type CEERankedGamePhase = "countdown" | "playing" | "overtime" | "settled";
export type CEERankedSeriesPhase =
  "countdown" | "playing" | "overtime" | "intermission" | "settled";
export type CEERankedGameEndReason = "solved" | "surrender" | "draw";
/** completed：正常打完；exit：一方主动退出；offline：一方连续离线超时。 */
export type CEERankedSeriesEndReason = "completed" | "exit" | "offline";
export type CEERankedOutcome = "won" | "lost" | "drawn";
/** pending：结算写库未完成；rated：已计分；unrated：本场本就不计分（如人机额度用完）；failed：写库失败未计分。 */
export type CEERankedSettlement = "pending" | "rated" | "unrated" | "failed";

/** 对手某次猜测的脱敏反馈：只有比较符号与计数，不含数值、角色名、作品名或标签文字。 */
export interface CEERankedMaskedFeedback {
  gender: CEEComparison;
  popularity: CEEComparison;
  rating: CEEComparison;
  appearancesCount: CEEComparison;
  earliestAppearance: CEEComparison;
  latestAppearance: CEEComparison;
  /** 是否命中共同作品；不给作品名与数量。 */
  sharedAppearance: boolean;
  /** 展示出的标签里命中几个、一共几个（含作品标签、角色标签、声优）。 */
  tagMatched: number;
  tagTotal: number;
}
export interface CEERankedMaskedGuess {
  /** 第几次猜测，从 1 开始。 */
  index: number;
  correct: boolean;
  createdAt: number;
  feedback: CEERankedMaskedFeedback;
}
export interface CEERankedSeatView {
  /** 人机即人格名。 */
  name: string;
  isBot: boolean;
  /** 展示分（整数）；人机或定级中为 null。 */
  rating: number | null;
  /** 定级中为已完成的定级场数；已定级或人机为 null。 */
  placementPlayed: number | null;
  /** 本场系列赛得分（可为 0.5 的倍数）。 */
  points: number;
  /** 当前局已用次数与可用总次数；局间为上一局的数值。 */
  attempts: number;
  allowance: number;
  finished: boolean;
  online: boolean;
}
export interface CEERankedGameView {
  number: number;
  phase: CEERankedGamePhase;
  startsAt: number;
  deadlineAt: number | null;
  /** 本人完整猜测。 */
  guesses: CEEGuess[];
  /** 对方猜测的脱敏版。 */
  opponentGuesses: CEERankedMaskedGuess[];
  /** 加时阶段双方相同的系统提示。 */
  hints: string[];
}
/** 已结束的一局：双方猜测与答案完整公开。 */
export interface CEERankedGameSummary {
  number: number;
  answer: CEECharacterView;
  winner: "self" | "opponent" | null;
  reason: CEERankedGameEndReason;
  overtime: boolean;
  guesses: CEEGuess[];
  opponentGuesses: CEEGuess[];
}
export interface CEERankedSeriesResult {
  outcome: CEERankedOutcome;
  reason: CEERankedSeriesEndReason;
  settlement: CEERankedSettlement;
  /** 只有已计分且赛前已定级时有值。 */
  ratingBefore: number | null;
  /** 只有已计分且赛后已定级时有值（第 5 场定级赛打完时 before 为 null、after 有值，即「定级完成」）。 */
  ratingAfter: number | null;
  /** 本场结束后的定级进度；赛前已定级为 null。 */
  placementPlayed: number | null;
}
export interface CEERankedSeriesView {
  seriesId: string;
  tier: { id: CEERankedTierId; name: string };
  phase: CEERankedSeriesPhase;
  rated: boolean;
  self: CEERankedSeatView;
  opponent: CEERankedSeatView;
  /** 进行中的这一局；局间与结算后为 null。 */
  game: CEERankedGameView | null;
  /** 局间阶段下一局开始的时刻，其余为 null。 */
  nextGameAt: number | null;
  games: CEERankedGameSummary[];
  result: CEERankedSeriesResult | null;
}
/** 每条连接一份的排位状态，经状态同步事件推送。 */
export type CEERankedState =
  | { status: "idle" }
  | {
      status: "queued";
      queuedAt: number;
      botAvailableAt: number;
      botFallbackAt: number;
      window: number;
    }
  | { status: "series"; series: CEERankedSeriesView };
export const CEE_RANKED_STATE_EVENT = "cee.ranked.state";

export interface CEERankedHistoryEntry {
  seriesId: string;
  endedAt: number;
  tierId: CEERankedTierId;
  opponentName: string;
  opponentIsBot: boolean;
  outcome: CEERankedOutcome;
  selfPoints: number;
  opponentPoints: number;
  /** 未计分或定级赛为 null。 */
  ratingDelta: number | null;
  placement: boolean;
}
export interface CEERankedProfile {
  /** 定级中为 null。 */
  rating: number | null;
  placementPlayed: number;
  placementTotal: number;
  seriesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  botRatedToday: number;
  botRatedLimit: number;
  recent: CEERankedHistoryEntry[];
}

const strict = { additionalProperties: false } as const;
const integer = (minimum: number, maximum: number) => t.Integer({ minimum, maximum });
const empty = t.Object({}, strict);
const id = integer(1, 2147483647);

export const CEERankedPayloadSchemas = {
  /** 读取并订阅本账号的排位状态；页面加载与断线重连都先调它。 */
  "cee.ranked.status": empty,
  "cee.ranked.queue": empty,
  "cee.ranked.cancel": empty,
  /** 排队满 10 秒后主动进人机局。 */
  "cee.ranked.playBot": empty,
  "cee.ranked.guess": t.Object({ characterId: id }, strict),
  /** 认输当前这一局。 */
  "cee.ranked.surrender": empty,
  /** 退出整场，判负。 */
  "cee.ranked.exit": empty,
  /** 结算后离开结果页回到空闲态。 */
  "cee.ranked.leave": empty,
  "cee.ranked.profile": empty,
  "cee.ranked.characterSearch": t.Object(
    { keyword: t.String({ minLength: 1, maxLength: 80 }) },
    strict
  ),
  "cee.ranked.subjectSearch": t.Object(
    { keyword: t.String({ minLength: 1, maxLength: 80 }) },
    strict
  ),
  "cee.ranked.subjectCharacters": t.Object({ subjectId: id }, strict),
  "cee.ranked.characterImage": t.Object(
    { characterId: id, size: t.Optional(t.Union([t.Literal("grid"), t.Literal("large")])) },
    strict
  ),
} as const;
export type CEERankedCommand = keyof typeof CEERankedPayloadSchemas;
export type CEERankedPayload<T extends CEERankedCommand> = Static<
  (typeof CEERankedPayloadSchemas)[T]
>;
export type CEERankedResponse<T extends CEERankedCommand> = T extends "cee.ranked.status"
  ? CEERankedState
  : T extends "cee.ranked.profile"
    ? CEERankedProfile
    : T extends "cee.ranked.characterSearch" | "cee.ranked.subjectCharacters"
      ? { results: CEECharacterSummary[] }
      : T extends "cee.ranked.subjectSearch"
        ? { results: CEESubjectSummary[] }
        : T extends "cee.ranked.characterImage"
          ? { imageUrl?: string }
          : Record<string, never>;
