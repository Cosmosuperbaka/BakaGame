import { AppError } from "../domain/Errors";
import { SlidingWindowRateLimiter } from "../infrastructure/RateLimiter";
import type { ConnectionRecord } from "../shared/Index";

/**
 * CEE 里会枚举角色与作品候选的三条命令。
 *
 * 外挂不需要服务端接口也能工作（自带 Bangumi dump 时角色 ID 现成），所以这里挡的是
 * 「没有本地库、从零重建候选集」那条最廉价的路径：把循环跑二十分钟并且要对抗限流。
 */
const SEARCH_COMMANDS = [
  "cee.character.search",
  "cee.subject.search",
  "cee.subject.characters",
] as const;

export type CEESearchCommand = (typeof SEARCH_COMMANDS)[number];

export const isCEESearchCommand = (type: string): type is CEESearchCommand =>
  (SEARCH_COMMANDS as readonly string[]).includes(type);

/** 统计窗口。 */
export const CEE_SEARCH_WINDOW_MS = 60_000;
/**
 * 单条连接在一个窗口内的检索次数。默认设置下每人 10 次猜测、每次 60 秒，
 * 人类一局最多十几次搜索，这里留了四倍余量。
 */
export const CEE_SEARCH_CONNECTION_MAX = 60;
/**
 * 同一来源地址合计的检索次数。连接号由服务端每次握手新发，多开连接就多份「每连接 60 次」，
 * 取十倍是因为握手配额允许同一地址开 64 条在途连接——不按地址聚合等于没限流。
 */
export const CEE_SEARCH_IP_MULTIPLIER = 10;
export const CEE_SEARCH_IP_MAX = CEE_SEARCH_CONNECTION_MAX * CEE_SEARCH_IP_MULTIPLIER;
/**
 * 点进作品看角色列表给检索一半的额度：正常玩家一次只点一两下，
 * 但它和关键词检索的成本不同量级，共用一桶会互相挤占。
 */
export const CEE_SUBJECT_CHARACTERS_RATIO = 1 / 2;
export const CEE_SUBJECT_CHARACTERS_CONNECTION_MAX =
  CEE_SEARCH_CONNECTION_MAX * CEE_SUBJECT_CHARACTERS_RATIO;

/** 三条检索命令各自的配额桶。 */
export class CEESearchQuota {
  private readonly buckets: Record<
    CEESearchCommand,
    { connection: SlidingWindowRateLimiter; ip: SlidingWindowRateLimiter }
  >;

  constructor(
    private readonly now: () => number = Date.now,
    options: { windowMs?: number; connectionMax?: number; maxKeys?: number } = {}
  ) {
    const windowMs = options.windowMs ?? CEE_SEARCH_WINDOW_MS;
    const connectionMax = options.connectionMax ?? CEE_SEARCH_CONNECTION_MAX;
    const makePair = (max: number) => ({
      connection: new SlidingWindowRateLimiter({
        windowMs,
        maxRequests: max,
        maxKeys: options.maxKeys,
      }),
      ip: new SlidingWindowRateLimiter({
        windowMs,
        maxRequests: max * CEE_SEARCH_IP_MULTIPLIER,
        maxKeys: options.maxKeys,
      }),
    });
    this.buckets = {
      "cee.character.search": makePair(connectionMax),
      "cee.subject.search": makePair(connectionMax),
      "cee.subject.characters": makePair(connectionMax * CEE_SUBJECT_CHARACTERS_RATIO),
    };
  }

  /**
   * 先扣额度再回源：把检查放到 `await` 之后，并发请求会在挂起窗口内全部穿透校验。
   * 来源地址只在握手时解析一次并随连接记录带下来，这里不反查 HTTP 头。
   */
  require(type: CEESearchCommand, connection: ConnectionRecord): void {
    const { connection: byConnection, ip: byIp } = this.buckets[type];
    if (!byConnection.allow(connection.id, this.now()))
      throw new AppError("RATE_LIMITED", "搜索过于频繁，请稍后再试");
    if (connection.clientIp && !byIp.allow(connection.clientIp, this.now()))
      throw new AppError("RATE_LIMITED", "搜索过于频繁，请稍后再试");
  }

  reset(): void {
    for (const bucket of Object.values(this.buckets)) {
      bucket.connection.reset();
      bucket.ip.reset();
    }
  }

  /** 各桶当前记账的键数量总和；容量不变量测试用，业务代码不得据此判定。 */
  get trackedKeys(): number {
    return Object.values(this.buckets).reduce(
      (sum, bucket) => sum + bucket.connection.trackedKeys + bucket.ip.trackedKeys,
      0
    );
  }
}
