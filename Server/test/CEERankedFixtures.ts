// ==================== 排位应用服务测试夹具 ====================
// 假时钟 + 手动计时器：所有时间驱动的规则（读秒、局间、人机出手、离线判负、写库重试）
// 都由 `advance` 推进，测试里不出现真实的 sleep。
import { CEESearchProvenance, ceeCharacterIdsOf } from "../src/application/CEEAntiCheatSignals";
import { CEERankedService } from "../src/application/CEERankedService";
import type { CEERankedBotSample } from "../src/application/CEERankedHandicap";
import {
  InMemoryCEERankedStore,
  type CEERankedHistoryRecord,
  type CEERankedRatingRecord,
  type CEERankedSeriesAudit,
  type CEERankedSeriesRecord,
  type CEERankedSettlementRecord,
  type CEERankedStore,
} from "../src/application/CEERankedStore";
import type { CEERankedPool, CEERankedPoolProvider } from "../src/application/CEERankedPool";
import { AppError } from "../src/domain/Errors";
import type { CEEDataProvider } from "../src/infrastructure/CEEData";
import {
  CEE_RANKED_PLACEMENT_SERIES,
  CEE_RANKED_STATE_EVENT,
  createCEERankedSettings,
  ceeRankedTier,
  type CEERankedCommand,
  type CEERankedPayload,
  type CEERankedResponse,
  type CEERankedSeriesView,
  type CEERankedState,
  type CEERankedTierId,
  type CEECharacterSummary,
  type CEECharacterView,
  type CEESubjectSummary,
  type ClientChannelProof,
  type ConnectionRecord,
  type PlayerAccount,
} from "../src/shared/Index";
import { character } from "./CEENativeFixtures";

/** 爱噶每局固定的第一手（本地数据集里丰川祥子的编号）。 */
export const AIGA_ID = 132476;
/** 起始时钟：北京 2026-10-20 中午，跨日测试只要加一天即可。 */
export const RANKED_START_MS = Date.UTC(2026, 9, 20, 4, 0, 0);
/** 题库默认候选：抽答案时按权重顺序取前三个（随机源恒为 0）。 */
export const RANKED_CANDIDATE_IDS = [11, 12, 13, 14, 15, 16];

const poolSettings = createCEERankedSettings(ceeRankedTier("d1"), 2024);

/**
 * 手写题库：候选按 id 升序、权重递减，`openings` 沿用同一顺序。开局全标为解题型、
 * 不标知名：普通人格第一手照旧落在题库角色上，服务测试不必关心开局谱。
 */
export function rankedPool(
  candidateIds: readonly number[] = RANKED_CANDIDATE_IDS,
  extras: readonly CEECharacterView[] = []
): CEERankedPool {
  const candidates = candidateIds.map((id, index) => ({
    character: character(id),
    weight: 10 - index,
  }));
  return {
    tier: "d1",
    settings: poolSettings,
    day: "2026-10-20",
    candidates,
    openings: candidates.map((item, index) => ({
      id: item.character.id,
      expectedRemaining: candidates.length - index,
      worstClass: 0,
      solver: true,
      famous: false,
      popularity: item.character.popularity,
    })),
    extras: [...extras],
  };
}

/** 爱噶首猜用的题库外角色。 */
export const aigaView = (): CEECharacterView => character(AIGA_ID);

const summaryOf = (view: CEECharacterView): CEECharacterSummary => ({
  id: view.id,
  name: view.name,
  nameCn: view.nameCn,
  imageUrl: view.imageUrl,
});

const subject = (id: number): CEESubjectSummary => ({
  id,
  name: `Subject ${id}`,
  nameCn: `作品 ${id}`,
  type: 2,
  year: 2020,
  rating: 7,
  heat: 100,
});

/** 假数据提供者：`getCharacter` 与题库共用同一组视图，搜索固定返回全部候选。 */
export function rankedData(
  pool: CEERankedPool,
  overrides: Partial<CEEDataProvider> = {}
): CEEDataProvider {
  const byId = new Map<number, CEECharacterView>();
  for (const candidate of pool.candidates) byId.set(candidate.character.id, candidate.character);
  for (const extra of pool.extras) byId.set(extra.id, extra);
  const summaries = pool.candidates.map((candidate) => summaryOf(candidate.character));
  return {
    searchCharacters: async () => summaries,
    searchSubjects: async () => [subject(100)],
    getSubjectCharacters: async () => summaries.slice(0, 1),
    getSubjects: async (ids) => ids.map(subject),
    getRawCharacter: async (id) => {
      void id;
      throw new AppError("UNUSED", "测试不读取原始资料");
    },
    getCharacter: async (id) => byId.get(id) ?? character(id),
    chooseRandomCharacter: async () => pool.candidates[0].character,
    importDirectory: async (id) => ({
      id,
      subjectIds: [100],
      missingSubjectIds: [],
      importedAt: RANKED_START_MS,
    }),
    resolveCharacterImage: async (id) => `https://images.invalid/${id}.jpg`,
    resolveSubjectImage: async (id) => `https://images.invalid/s${id}.jpg`,
    close: () => {},
    ...overrides,
  };
}

export interface RankedClient {
  record: ConnectionRecord;
  userId: string;
  sent: Array<{ event?: string; payload?: unknown }>;
}

/** 已定级的预置评级：分数与初值相同，只差「打满五场」这个门槛。 */
export const ratedSeedOf = (
  userId: string,
  overrides: Partial<CEERankedRatingRecord> = {}
): CEERankedRatingRecord => ({
  userId,
  rating: 1500,
  rd: 350,
  seriesPlayed: CEE_RANKED_PLACEMENT_SERIES,
  wins: 0,
  losses: 0,
  draws: 0,
  botRatedDay: null,
  botRatedCount: 0,
  lastPlayedAt: null,
  ...overrides,
});

/**
 * 给任意仓储垫一行评级。
 *
 * 定级期排队直开人机，很多用例要的是「已定级」之后的排队行为，逐场打满五场既慢又把
 * 匹配逻辑淹在定级流水里。没写过的账号读垫进去的行，写过之后以落库行为准。
 */
class SeedingStore implements CEERankedStore {
  private readonly seeds = new Map<string, CEERankedRatingRecord>();

  constructor(private readonly inner: CEERankedStore) {}

  seed(record: CEERankedRatingRecord): void {
    this.seeds.set(record.userId, record);
  }

  async getRating(userId: string): Promise<CEERankedRatingRecord | null> {
    const saved = await this.inner.getRating(userId);
    if (saved) return saved;
    const seed = this.seeds.get(userId);
    return seed ? { ...seed } : null;
  }

  saveSettlement(record: CEERankedSettlementRecord): Promise<void> {
    return this.inner.saveSettlement(record);
  }

  listHistory(userId: string, limit: number): Promise<CEERankedHistoryRecord[]> {
    return this.inner.listHistory(userId, limit);
  }

  listSeriesByUser(
    userId: string,
    limit: number,
    before?: number
  ): Promise<CEERankedSeriesRecord[]> {
    return this.inner.listSeriesByUser(userId, limit, before);
  }

  getSeriesAudit(seriesId: string): Promise<CEERankedSeriesAudit | null> {
    return this.inner.getSeriesAudit(seriesId);
  }

  listRecentBotSamples(limit: number): Promise<CEERankedBotSample[]> {
    return this.inner.listRecentBotSamples(limit);
  }
}

export interface RankedClientIdentity {
  account?: PlayerAccount;
  clientChannel?: ClientChannelProof;
  isAgent?: boolean;
}

interface TimerTask {
  id: number;
  due: number;
  callback: () => void;
}

export interface RankedHarnessOptions {
  candidateIds?: readonly number[];
  extras?: readonly CEECharacterView[];
  /** 固定随机值；缺省 0——人格取列表首位，抽答案按权重顺序取前三。 */
  randomValue?: number;
  store?: CEERankedStore;
  pool?: CEERankedPool;
  /** 这一档的题库读取直接抛错：用来验证一场开失败不会带走整跳。 */
  failingTier?: CEERankedTierId;
  settleRetryDelaysMs?: readonly number[];
  data?: Partial<CEEDataProvider>;
  startAt?: number;
  resolveName?: (userId: string) => Promise<string | null>;
}

/** 让出事件循环并把已排队的微任务全部跑完：`await` 链在假时钟里靠它继续。 */
const drain = async (): Promise<void> => {
  for (let round = 0; round < 32; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

export function rankedHarness(options: RankedHarnessOptions = {}) {
  const pool =
    options.pool ?? rankedPool(options.candidateIds ?? RANKED_CANDIDATE_IDS, options.extras ?? []);
  let clock = options.startAt ?? RANKED_START_MS;
  let timerId = 0;
  const timers = new Map<number, TimerTask>();
  const logs = {
    info: [] as Array<{ message: string; detail: unknown }>,
    warn: [] as Array<{ message: string; detail: unknown }>,
    error: [] as Array<{ message: string; detail: unknown }>,
  };
  const poolCalls: Array<{ tier: CEERankedTierId; now: number }> = [];
  const setTimer = (callback: () => void, ms: number): (() => void) => {
    const task: TimerTask = { id: (timerId += 1), due: clock + Math.max(0, ms), callback };
    timers.set(task.id, task);
    return () => timers.delete(task.id);
  };
  const provider: CEERankedPoolProvider = {
    getRankedPool: async (tier, at) => {
      poolCalls.push({ tier, now: at });
      if (options.failingTier === tier)
        throw new AppError("RANKED_POOL_UNAVAILABLE", "测试用题库读取失败");
      return pool;
    },
  };
  const provenance = new CEESearchProvenance(() => clock);
  const store = new SeedingStore(options.store ?? new InMemoryCEERankedStore());
  const service = new CEERankedService({
    data: rankedData(pool, options.data),
    store,
    pool: provider,
    provenance,
    resolveName: options.resolveName,
    logger: {
      info: (message, detail) => logs.info.push({ message, detail }),
      warn: (message, detail) => logs.warn.push({ message, detail }),
      error: (message, detail) => logs.error.push({ message, detail }),
    },
    now: () => clock,
    random: () => options.randomValue ?? 0,
    setTimer,
    settleRetryDelaysMs: options.settleRetryDelaysMs,
  });

  /** 推进假时钟：期间到点的计时器按 due 顺序触发，嵌套注册的新计时器一并处理。 */
  const advance = async (milliseconds: number): Promise<void> => {
    const target = clock + milliseconds;
    for (;;) {
      let next: TimerTask | null = null;
      for (const task of timers.values()) {
        if (task.due > target) continue;
        if (!next || task.due < next.due || (task.due === next.due && task.id < next.id))
          next = task;
      }
      if (next === null) break;
      timers.delete(next.id);
      clock = Math.max(clock, next.due);
      next.callback();
      await drain();
    }
    clock = target;
    service.runHousekeeping();
    await drain();
  };

  const connect = (name: string, identity: RankedClientIdentity = {}): RankedClient => {
    const userId = identity.account?.userId ?? `u-${name}`;
    const sent: RankedClient["sent"] = [];
    const record: ConnectionRecord = {
      id: `${name}-${crypto.randomUUID()}`,
      account: identity.account ?? { userId, image: null },
      clientIp: "127.0.0.1",
      clientChannel: identity.clientChannel ?? {
        clientId: `client-${name}`,
        clientType: "desktop",
        clientVersion: "9.9.9",
        keyProtection: "hardware",
      },
      isAgent: identity.isAgent,
      lobbySubscribed: false,
      send: (payload) => sent.push(structuredClone(payload) as RankedClient["sent"][number]),
      close: () => {
        service.unregisterConnection(record.id);
      },
    };
    service.registerConnection(record);
    return { record, userId, sent };
  };

  const send = async <T extends CEERankedCommand>(
    client: RankedClient,
    type: T,
    payload: CEERankedPayload<T>
  ): Promise<CEERankedResponse<T>> => {
    const result = await service.execute(client.record, {
      id: crypto.randomUUID(),
      type,
      payload,
    });
    // 与统一入口同构：排位检索的结果由入口层记进台账，猜测时据此判断「有没有先搜再猜」。
    if (type === "cee.ranked.characterSearch")
      provenance.note(client.record.id, ceeCharacterIdsOf(result));
    return result;
  };

  const states = (client: RankedClient): CEERankedState[] =>
    client.sent
      .filter((packet) => packet.event === CEE_RANKED_STATE_EVENT)
      .map((packet) => packet.payload as CEERankedState);

  const latest = (client: RankedClient): CEERankedState => {
    const frames = states(client);
    const last = frames.at(-1);
    if (!last) throw new Error("该连接还没收到排位状态帧");
    return last;
  };

  const seriesView = (client: RankedClient): CEERankedSeriesView => {
    const state = latest(client);
    if (state.status !== "series") throw new Error(`当前状态是 ${state.status}，不是系列赛`);
    return state.series;
  };

  return {
    service,
    store,
    pool,
    poolCalls,
    provenance,
    logs,
    connect,
    send,
    states,
    latest,
    seriesView,
    advance,
    clock: () => clock,
    /** 把账号当成已定级：排队才会进人池，否则定级期排队直开人机。 */
    seedRated: (userId: string, overrides: Partial<CEERankedRatingRecord> = {}) =>
      store.seed(ratedSeedOf(userId, overrides)),
  };
}

export type RankedHarness = ReturnType<typeof rankedHarness>;

/** 取被拒绝的 `AppError`：断言错误码比断言「抛错了」更有判别力。 */
export async function appErrorOf(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("预期抛出 AppError，但调用成功了");
}

/**
 * 进入一场人机局：已定级账号排队等 30 秒兜底，定级期账号排队即开。
 *
 * 已经在对局里时不再推进时钟——多走的 30 秒会让爱噶先出手，改掉用例想看的局面。
 */
export async function startBotSeries(harness: RankedHarness, client: RankedClient): Promise<void> {
  await harness.send(client, "cee.ranked.queue", {});
  if (harness.latest(client).status !== "series") await harness.advance(30_000);
}

/** 把当前这一局推到「进行中」：开赛后前 5 秒是读秒，读秒里不能猜。 */
export async function openPlay(harness: RankedHarness): Promise<void> {
  await harness.advance(5_000);
}

/** 认输整场并读出结算后的审计：`exit` 命令内部会等写库落定。 */
export async function exitAndAudit(
  harness: RankedHarness,
  client: RankedClient
): Promise<CEERankedSeriesAudit> {
  const seriesId = harness.seriesView(client).seriesId;
  await harness.send(client, "cee.ranked.exit", {});
  const audit = await harness.store.getSeriesAudit(seriesId);
  if (!audit) throw new Error(`结算后读不到系列赛 ${seriesId} 的审计`);
  return audit;
}
