import type { AntiCheatReviewStatus } from "../shared/ApiContract";
import type { ClientChannelProof } from "../shared/Model";

/**
 * P1 行为特征：只用服务端可观测数据打分，不依赖任何客户端上报。
 *
 * 输出只有「可疑度 + 复核条目」，**不自动封禁**；房间里可见的也只有「本局已记录」，
 * 不点名、不指控。采集覆盖全部增强房对局，判定与展示只发生在 `BakaAntiCheat` 房。
 */

export type CEEGuessClientType = "web" | "desktop" | "mobile";

/** 一次猜测的服务端可观测切片，随回合明细落进对局记录的时间线。 */
export interface CEEGuessSignal {
  guessId: string;
  playerId: string;
  /** 本局第几次猜测（队伍共享的次数，取提交时的值）。 */
  attempts: number;
  clientType: CEEGuessClientType;
  /** 该次猜测前同一连接最近一次角色检索的时刻；从未检索为 `null`。 */
  searchedAt: number | null;
  /** 那次检索返回的候选里是否包含本次猜的角色 ID。 */
  searchMatched: boolean;
  correct: boolean;
  createdAt: number;
}

/** 检索过的连接上限：超出后按最早记录淘汰，防止按需扩张内存。 */
export const CEE_SEARCH_PROVENANCE_MAX = 20_000;
/** 每次检索只保留有限个候选 ID；检索一页最多几十条，留足余量。 */
export const CEE_SEARCH_RESULT_IDS_MAX = 256;

/**
 * 按连接记「最近一次角色检索」的台账。
 *
 * 「无搜索直接猜」是最硬的一条特征：客户端 UI 只能从搜索下拉里选人，正常路径必然是
 * `search → select → guess`。脚本可以伪造一次 search，但要多一次往返，而且关键词与最终
 * `characterId` 常常对不上——所以这里连「结果里有没有这个 ID」一起记。
 */
export class CEESearchProvenance {
  private readonly last = new Map<string, { at: number; ids: Set<number> }>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys: number = CEE_SEARCH_PROVENANCE_MAX
  ) {}
  note(connectionId: string, ids: readonly number[]): void {
    while (this.last.size >= this.maxKeys) {
      const oldest = this.last.keys().next().value;
      if (oldest === undefined) break;
      this.last.delete(oldest);
    }
    this.last.set(connectionId, {
      at: this.now(),
      ids: new Set(ids.slice(0, CEE_SEARCH_RESULT_IDS_MAX)),
    });
  }
  /** 只读，不消费：一次检索后连猜几个候选是正常玩法，不该被当成绕过。 */
  match(connectionId: string, characterId: number): { at: number | null; matched: boolean } {
    const held = this.last.get(connectionId);
    if (!held) return { at: null, matched: false };
    return { at: held.at, matched: held.ids.has(characterId) };
  }
  forget(connectionId: string): void {
    this.last.delete(connectionId);
  }
  get trackedConnections(): number {
    return this.last.size;
  }
}

/** 从检索命令的返回值里取角色 ID；形状不符即视为没有候选，不参与判定。 */
export function ceeCharacterIdsOf(result: unknown): number[] {
  const results = (result as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((item) => (item as { id?: unknown } | undefined)?.id)
    .filter((id): id is number => typeof id === "number");
}

/** 通道证明换算成采集用的客户端类型：没有证明即网页接入。 */
export const ceeClientTypeOf = (proof?: ClientChannelProof): CEEGuessClientType =>
  proof?.clientType ?? "web";

// ==================== 特征与打分 ====================

/** 相邻猜测间隔的变异系数低于该值即视为「机器节奏」。人类手速长尾，CV 远大于 0.3。 */
export const CEE_CV_SUSPICIOUS = 0.1;
/** 至少几条猜测才谈得上节奏；两条以下的 CV 没有统计意义。 */
export const CEE_CV_MIN_SAMPLES = 4;
/** 无检索猜测占比达到该值即加分（正常玩家必然是先搜再猜）。 */
export const CEE_NO_SEARCH_RATIO_SUSPICIOUS = 0.8;
/** 至少几条猜测才谈得上「全部落空」；一两次可能只是翻了上一页的结果。 */
export const CEE_UNMATCHED_MIN_GUESSES = 3;

export interface CEEUnitFeatures {
  /** 相邻猜测间隔（毫秒）。 */
  intervals: number[];
  /** 间隔变异系数，样本不足为 `null`。 */
  cv: number | null;
  noSearchGuesses: number;
  /** 检索过、但那次检索的候选里没有本次角色 ID 的次数（伪造检索）。 */
  unmatchedSearches: number;
  guesses: number;
  /** 首猜即中：人类极低，跨局偏高的脚本会命中这一条。 */
  firstGuessCorrect: boolean;
}

export interface CEESuspicion {
  score: number;
  reasons: string[];
  features: CEEUnitFeatures;
}

/** 按提交顺序的同一玩家（同一单位）猜测算特征。 */
export function ceeUnitFeatures(ordered: readonly CEEGuessSignal[]): CEEUnitFeatures {
  const intervals: number[] = [];
  for (let i = 1; i < ordered.length; i++)
    intervals.push(Math.max(0, ordered[i].createdAt - ordered[i - 1].createdAt));
  const mean = intervals.reduce((sum, value) => sum + value, 0) / (intervals.length || 1);
  let cv: number | null = null;
  if (intervals.length >= CEE_CV_MIN_SAMPLES - 1 && mean > 0) {
    const variance =
      intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length;
    cv = Math.sqrt(variance) / mean;
  }
  return {
    intervals,
    cv,
    guesses: ordered.length,
    noSearchGuesses: ordered.filter((signal) => signal.searchedAt === null).length,
    unmatchedSearches: ordered.filter(
      (signal) => signal.searchedAt !== null && !signal.searchMatched
    ).length,
    firstGuessCorrect: ordered.length > 0 && ordered[0].correct,
  };
}

/**
 * 规则打分：可解释优先，不做机器学习（样本量不够，也无法向被复核的人说明为什么）。
 * 分值只决定「进不进复核队列」，不决定任何处罚。
 */
export function scoreCEEAntiCheat(ordered: readonly CEEGuessSignal[]): CEESuspicion {
  const features = ceeUnitFeatures(ordered);
  const reasons: string[] = [];
  let score = 0;
  if (features.cv !== null && features.cv < CEE_CV_SUSPICIOUS) {
    score += 2;
    reasons.push(`节奏恒定（间隔变异系数 ${features.cv.toFixed(3)}）`);
  }
  if (
    features.guesses >= 3 &&
    features.noSearchGuesses / features.guesses >= CEE_NO_SEARCH_RATIO_SUSPICIOUS
  ) {
    score += 2;
    reasons.push(`未检索直接猜（${features.noSearchGuesses}/${features.guesses} 次）`);
  }
  if (features.firstGuessCorrect && ordered.length > 0 && ordered[0].attempts === 1) {
    score += 1;
    reasons.push("首次猜测即命中");
  }
  if (
    features.guesses >= CEE_UNMATCHED_MIN_GUESSES &&
    features.unmatchedSearches === features.guesses
  ) {
    score += 2;
    reasons.push(`检索全部落空（候选里没有本次角色 ${features.unmatchedSearches} 次）`);
  }
  return { score, reasons, features };
}

/** 达到该分值进入人工复核队列。 */
export const CEE_REVIEW_SCORE_THRESHOLD = 3;
/** 一条猜测都没有的回合不产生复核条目。 */
export const CEE_REVIEW_MIN_GUESSES = 2;

export interface CEEAntiCheatReviewInput {
  roomId: string;
  roomCreatedAt: number;
  roundNumber: number;
  playerId: string;
  playerName: string;
  userId: string | null;
  clientType: CEEGuessClientType;
  recordedAt: number;
}

export interface CEEAntiCheatReview extends CEEAntiCheatReviewInput {
  score: number;
  reasons: string[];
  features: CEEUnitFeatures;
}

/**
 * 复核队列端口：写入即排队，任何处罚都由人在队列里决定。
 * 与对局记录同口径——落库失败只记日志，绝不影响对局本身。
 */
export interface CEEAntiCheatReviewQueue {
  add(review: CEEAntiCheatReview): void;
}

/** 复核条目状态：只有人能在后台改，任何代码路径都只写 `open`。词表与后台契约同一份。 */
export type CEEAntiCheatReviewStatus = AntiCheatReviewStatus;

/** 落库之后的一条条目：`id` 由存储产生，`status` 是人在后台给的处置结果。 */
export interface CEEAntiCheatReviewItem extends CEEAntiCheatReview {
  id: string;
  status: CEEAntiCheatReviewStatus;
}

/** 队列的查询条件：按处置状态与产生时间过滤，分页给后台用。 */
export interface CEEAntiCheatReviewQuery {
  status?: CEEAntiCheatReviewStatus;
  since?: number;
  limit?: number;
  offset?: number;
}

/**
 * 后台读队列的最小端口：分页查 + 按身份展开 + 改状态。与写端口分开，是因为除人在后台点之外，
 * 没有任何一条自动路径允许改状态。展开只接受队列里已有的条目 id，不提供「按昵称批量拉人」的查询口。
 */
export interface CEEAntiCheatReviewBoard {
  list(options?: CEEAntiCheatReviewQuery): Promise<{
    items: CEEAntiCheatReviewItem[];
    total: number;
  }>;
  /** 同身份近期条目的原始条目，供 `aggregateCEEAntiCheatReviews` 算均值。 */
  aggregateFor(itemId: string, since: number): Promise<CEEAntiCheatReviewItem[]>;
  setStatus(id: string, status: CEEAntiCheatReviewStatus): Promise<void>;
  /** 改状态前先确认条目真在：后台不接受「改了一个不存在的 id 也回成功」。 */
  exists(id: string): Promise<boolean>;
}

/**
 * 跨局聚合的身份口径：登录玩家认 `userId`（改昵称不换人），
 * 游客只能认昵称，且只与其它同昵称的游客条目比——不把昵称撞上登录账号的条目混进来。
 */
export interface CEEAntiCheatReviewIdentity {
  userId: string | null;
  playerName: string;
}

/** 判定两条条目是否同一身份；内存与 MySQL 两套实现共用，避免口径分叉。 */
export const ceeReviewIdentityMatches = (
  item: CEEAntiCheatReviewIdentity,
  identity: CEEAntiCheatReviewIdentity
): boolean =>
  identity.userId !== null
    ? item.userId === identity.userId
    : item.userId === null && item.playerName === identity.playerName;

/** 跨局聚合只回看这个窗口：一个月前的行为不该替今天说话。 */
export const CEE_ANTI_CHEAT_AGGREGATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** 聚合最多读这么多条：一个人的条目本就少，封顶是防极端数据把后台查询拖长。 */
export const CEE_ANTI_CHEAT_AGGREGATE_MAX_ITEMS = 200;

export interface CEEAntiCheatReviewAggregate {
  /** 参与聚合的条目数（含正在看这一条）。 */
  rounds: number;
  /** 每个被记录回合的平均猜测次数，一位小数。 */
  avgGuesses: number;
  /** 首猜即中的回合数；与 `rounds` 一起读才是命中率。 */
  firstGuessHits: number;
  /** 平均间隔变异系数；一条都算不出时为 `null`。 */
  avgCv: number | null;
  /** 窗口内的最高分：看的是「有没有越来越像」，不是结论。 */
  maxScore: number;
}

/**
 * 同身份近期条目的均值口径。只做算术，不判定、不打分、不产任何动作，
 * 结论留给读这些数字的人。
 */
export const aggregateCEEAntiCheatReviews = (
  items: readonly CEEAntiCheatReviewItem[]
): CEEAntiCheatReviewAggregate => {
  const mean = (values: readonly number[]) =>
    values.reduce((total, value) => total + value, 0) / values.length;
  const cvs = items.map((item) => item.features.cv).filter((cv): cv is number => cv !== null);
  if (!items.length)
    return { rounds: 0, avgGuesses: 0, firstGuessHits: 0, avgCv: null, maxScore: 0 };
  return {
    rounds: items.length,
    avgGuesses: Math.round(mean(items.map((item) => item.features.guesses)) * 10) / 10,
    firstGuessHits: items.filter((item) => item.features.firstGuessCorrect).length,
    avgCv: cvs.length ? Math.round(mean(cvs) * 1000) / 1000 : null,
    maxScore: items.reduce((highest, item) => Math.max(highest, item.score), 0),
  };
};

export const NOOP_ANTI_CHEAT_REVIEW_QUEUE: CEEAntiCheatReviewQueue = { add() {} };

/** 本地与隔离测试用：留在内存里，写入与后台读断言打的是同一个数组（新条目在前，与队列口径一致）。 */
export class InMemoryAntiCheatReviewQueue
  implements CEEAntiCheatReviewQueue, CEEAntiCheatReviewBoard
{
  readonly reviews: CEEAntiCheatReviewItem[] = [];
  private counter = 0;
  add(review: CEEAntiCheatReview): void {
    this.counter += 1;
    this.reviews.unshift({ ...review, id: `mem_${this.counter}`, status: "open" });
  }
  async list(options: CEEAntiCheatReviewQuery = {}) {
    const filtered = this.reviews.filter(
      (item) =>
        (options.status === undefined || item.status === options.status) &&
        (options.since === undefined || item.recordedAt >= options.since)
    );
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    return { items: filtered.slice(offset, offset + limit), total: filtered.length };
  }
  async aggregateFor(itemId: string, since: number): Promise<CEEAntiCheatReviewItem[]> {
    const base = this.reviews.find((item) => item.id === itemId);
    if (!base) return [];
    return this.reviews
      .filter((item) => item.recordedAt >= since && ceeReviewIdentityMatches(item, base))
      .slice(0, CEE_ANTI_CHEAT_AGGREGATE_MAX_ITEMS);
  }
  async setStatus(id: string, status: CEEAntiCheatReviewStatus): Promise<void> {
    const item = this.reviews.find((review) => review.id === id);
    if (item) item.status = status;
  }
  async exists(id: string): Promise<boolean> {
    return this.reviews.some((item) => item.id === id);
  }
}

/**
 * 回合结算时按玩家逐条打分，只有反作弊房产生条目。
 * 返回的条目已经带上展示与复核所需的最小信息，调用方只管落库。
 */
export function ceeAntiCheatReviews(
  context: Omit<
    CEEAntiCheatReviewInput,
    "playerId" | "playerName" | "userId" | "clientType" | "recordedAt"
  > & { recordedAt: number },
  signalsByPlayer: ReadonlyMap<string, CEEGuessSignal[]>,
  identityOf: (playerId: string) => { name: string; userId: string | null }
): CEEAntiCheatReview[] {
  const reviews: CEEAntiCheatReview[] = [];
  for (const [playerId, ordered] of signalsByPlayer) {
    if (ordered.length < CEE_REVIEW_MIN_GUESSES) continue;
    const { score, reasons, features } = scoreCEEAntiCheat(ordered);
    if (score < CEE_REVIEW_SCORE_THRESHOLD) continue;
    const identity = identityOf(playerId);
    reviews.push({
      ...context,
      playerId,
      playerName: identity.name,
      userId: identity.userId,
      clientType: ordered[ordered.length - 1].clientType,
      score,
      reasons,
      features,
    });
  }
  return reviews;
}
