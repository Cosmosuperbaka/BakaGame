import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { EventLogger } from "./EventLogger";
import { countServerMetric } from "./Sentry";
import { stableStringify } from "./JsonReaders";
import { randomChineseIp, type ChinaIpRange } from "./ChinaIpRanges";

/** 把凭据窄化成组合包形态；裸字符串与非对象凭据都走 `false` 分支。 */
const isCookieRecord = (cookie: unknown): cookie is Record<string, unknown> =>
  typeof cookie === "object" && cookie !== null;

/**
 * 玩家级 IP 归属。
 *
 * 匿名请求没有 cookie 可区分身份，必须按玩家分桶：全部落在同一个 `"anonymous"` scope 上
 * 就会共享伪装 IP 与限流配额，一个人打满、全服跟着 405。应用层在处理每条 WS 命令时把
 * 连接标识放进这里。用 `AsyncLocalStorage` 而不是给每个 provider 方法加参数：调用链很深，
 * 逐个透传签名会把「玩家身份」这一件事扩散到每一层。
 */
export const musicIpScope = new AsyncLocalStorage<string>();

/** 匿名（无 cookie、且不在玩家作用域内）请求的 IP 归属，主要覆盖预热与后台任务。 */
export const IP_SCOPE_ANONYMOUS = "anonymous";

/**
 * 显式声明「本次调用属于后台任务，按共享匿名出口工作」。
 *
 * 与「忘记包作用域」区分开是有意为之：后者是一条新调用链的配置错误，要靠告警暴露；
 * 前者是设计如此（预热、缓存维护没有玩家上下文），不该占用同一条告警的额度。
 */
export const runWithAnonymousMusicIpScope = <T>(task: () => Promise<T>): Promise<T> =>
  musicIpScope.run(IP_SCOPE_ANONYMOUS, task);

/**
 * 伪装出口 IP 的缓存上限。
 *
 * 每个玩家一个 scope，房间多、进出频繁时条目会持续增长；超限按插入顺序淘汰最老的。
 * 256 足以覆盖同时在线规模，被淘汰的玩家下次请求重新分配一个 IP 即可（无正确性影响）。
 */
const IP_SCOPE_MAX_ENTRIES = 256;

/**
 * 「缺少玩家作用域」这条降级的告警最小间隔。
 *
 * 满载时每条匿名请求都会命中它，逐条 warn 会把日志刷成噪声、反而盖掉真正的故障；
 * 口径与服务端采集链路的故障上报一致：每一次都计数，聚合告警按间隔限频。
 */
const IP_SCOPE_FALLBACK_WARN_INTERVAL_MS = 60_000;
/** 无域调用次数指标：告警限频之后仍然能看出「这条链路一直在降级」。 */
const IP_SCOPE_FALLBACK_METRIC = "bakagame.music.ip_scope_fallback";

/** 二维码会话的有效期：开完不扫的会话超过这个时长就丢弃，避免分桶无限堆积。 */
const QR_LOGIN_SCOPE_TTL_MS = 10 * 60_000;

interface MusicIpScopeRegistryOptions {
  now: () => number;
  /** 随机源；`nextFloat` 缺省时回落 `Math.random`。 */
  random: { nextFloat?: () => number };
  /** CN IP 段数据，由调用方读出后注入。 */
  chinaIpRanges: readonly ChinaIpRange[];
  /** 组合凭据（`{ netease, qq }` 形态）里属于本平台的键名。 */
  platformKey: string;
  /** 作用域缺失降级的告警出口。 */
  logger?: EventLogger;
}

/**
 * 音乐上游共用的伪装出口 IP 作用域登记：按玩家 / 凭证 / 登录会话分配并复用 IP，
 * 限流后按 scope 轮换。provider 持有一个实例并委托；平台差异（组合凭据里属于
 * 本平台的那份键名）通过构造参数注入，这里不出现任何平台专有概念。
 */
export class MusicIpScopeRegistry {
  private readonly ipByScope = new Map<string, string>();
  private readonly chinaIpRanges: readonly ChinaIpRange[];
  // 扫码登录是一次多条请求的会话：创建、轮询、设备上报、状态校验必须共用同一个出口 IP，
  // 中途换 IP 会让刚拿到的凭证失效。必须按「二维码 unikey」分桶，不能是单个字段：
  // 两个房主在相近时间扫码时，单值会被后发起者覆盖，先完成的那位永久错绑到别人的会话 IP。
  private readonly qrLoginScopes = new Map<string, { scope: string; createdAt: number }>();
  private readonly now: () => number;
  private readonly random: { nextFloat?: () => number };
  private readonly platformKey: string;
  private readonly logger?: EventLogger;
  // 首条「缺少玩家作用域」告警必须在第一次降级时就发出，所以初值设为「早就过期的间隔之前」。
  private lastIpScopeFallbackWarnAt = Number.NEGATIVE_INFINITY;

  constructor(options: MusicIpScopeRegistryOptions) {
    this.now = options.now;
    this.random = options.random;
    this.chinaIpRanges = options.chinaIpRanges;
    this.platformKey = options.platformKey;
    this.logger = options.logger;
  }

  /**
   * 解析一次请求应当使用的 IP 归属，优先级从高到低：
   *
   * 1. `loginScope` —— 扫码登录会话。整条链路（创建二维码 → 轮询 → 设备上报 → 状态校验）
   *    必须共用同一个 IP，否则登录态一建立就漂移。只有**显式属于某个扫码会话**的请求才走它：
   *    若无条件优先，任意一人处于扫码等待期时，全进程所有房间、所有凭证的请求都会被带上
   *    那个会话的 IP，凭证与出口 IP 的绑定被整体破坏。
   * 2. `host:<cookie 摘要>` —— 带房主凭证的请求，沿用登录时固化的那个 IP。
   * 3. `player:<连接标识>` —— 匿名请求按玩家分桶，互不占用对方的限流配额。
   * 4. `anonymous` —— 没有玩家上下文的兜底。走到这一层说明整条调用链没被 `musicIpScope.run`
   *    包住，按降级上报（见 `reportMissingIpScope`），不再静默。
   */
  resolveIpScope(
    cookie?: string | Record<string, unknown>,
    loginScope?: string,
    endpoints?: readonly string[]
  ) {
    if (loginScope) return loginScope;
    if (this.hasCookie(cookie)) return this.cookieScope(cookie);
    const scope = musicIpScope.getStore();
    if (scope) return scope;
    this.reportMissingIpScope(endpoints);
    return IP_SCOPE_ANONYMOUS;
  }

  /**
   * 「作用域外调用」必须看得见：它和后台预热的显式共享出口不同，漏包作用域是配置错误，
   * 现场只会看到全服 405，看不到「匿名请求又挤回同一个出口」这层原因。
   * 每次降级都计数，聚合告警按固定间隔最多一条；上下文只带接口名这类无凭据字段。
   */
  private reportMissingIpScope(endpoints?: readonly string[]) {
    countServerMetric(IP_SCOPE_FALLBACK_METRIC, 1);
    const at = this.now();
    if (at - this.lastIpScopeFallbackWarnAt < IP_SCOPE_FALLBACK_WARN_INTERVAL_MS) return;
    this.lastIpScopeFallbackWarnAt = at;
    this.logger?.warn("音乐请求缺少玩家 IP 作用域，已回落共享匿名出口", {
      fallbackScope: IP_SCOPE_ANONYMOUS,
      ...(endpoints?.length ? { endpoints: [...endpoints] } : {}),
    });
  }

  /** cookie 参数是否真的带了凭证；空串与空对象一律按匿名处理，避免落进房主那一桶。 */
  private hasCookie(cookie?: string | Record<string, unknown>) {
    if (typeof cookie === "string") return cookie.trim().length > 0;
    if (cookie && typeof cookie === "object") {
      const platformCookie = cookie[this.platformKey];
      if (typeof platformCookie === "string") return platformCookie.trim().length > 0;
      return Object.keys(cookie).length > 0;
    }
    return false;
  }

  /**
   * 刷新一个 scope 的伪装 IP。
   *
   * 只删缓存、不在这里生成新 IP：下一次请求会按 scope 重新分配，退避期间就不必空转，
   * 没被再次用到的 scope 也不会留下无效条目。
   *
   * 注意这里**不做房主/玩家的区分**：刷新只发生在限流之后，此时该 scope 的配额已经被计满，
   * 继续用同一个 IP 只会持续 405。房主凭证的 IP 由 `bindSessionIp` 固化的语义在限流兜底时
   * 让位给可用性（变更缘由见 `Server/docs/NeteaseMusicApi.md`）。
   */
  rotateScopeIp(scope?: string) {
    if (!scope) return;
    this.ipByScope.delete(scope);
  }

  // 同一份 cookie 原文必须映射到同一个 IP：Enhanced API 会把 cookie 对象补上随机的
  // _ntes_nuid / NMTID，因此这里对字符串做哈希、对对象做稳定序列化，避免逐请求漂移。
  cookieScope(cookie?: string | Record<string, unknown>) {
    const fingerprint = this.cookieFingerprint(cookie);
    return fingerprint ? `host:${fingerprint}` : IP_SCOPE_ANONYMOUS;
  }

  /** 凭据原文的稳定指纹（sha256 前 16 位）；无凭据时返回空串，供缓存键等场景复用。 */
  cookieFingerprint(cookie: unknown): string {
    const cookieStr = this.platformCookieString(cookie);
    return cookieStr ? createHash("sha256").update(cookieStr).digest("hex").slice(0, 16) : "";
  }

  private platformCookieString(cookie: unknown): string {
    if (typeof cookie === "string") return cookie.trim();
    if (isCookieRecord(cookie)) {
      const platformCookie = cookie[this.platformKey];
      return typeof platformCookie === "string" ? platformCookie.trim() : stableStringify(cookie);
    }
    return "";
  }

  // 每个 scope 只分配一次 IP、之后持续复用；超限按插入顺序淘汰最老的。
  // IP 被替换的唯一入口是 `rotateScopeIp`（限流兜底），正常路径下同一 scope 不会漂移。
  ensureScopeIp(scope: string) {
    const existing = this.ipByScope.get(scope);
    if (existing) return existing;
    const ip = randomChineseIp(this.chinaIpRanges, this.random);
    this.ipByScope.set(scope, ip);
    if (this.ipByScope.size > IP_SCOPE_MAX_ENTRIES) {
      const oldest = this.ipByScope.keys().next().value;
      if (oldest !== undefined) this.ipByScope.delete(oldest);
    }
    return ip;
  }

  // 将登录会话使用的 IP 固化到登录后凭证的 scope 上，随后同一凭证稳定复用该 IP。
  bindSessionIp(cookieValue: string, scope?: string) {
    if (!scope) return;
    const ip = this.ipByScope.get(scope);
    const cookie = cookieValue.trim();
    if (ip && cookie) this.ipByScope.set(this.cookieScope(cookie), ip);
  }

  /** 登记一个扫码登录会话的出口归属（先清理过期会话，避免分桶无限堆积）。 */
  setLoginScope(key: string, scope: string) {
    this.pruneLoginScopes();
    this.qrLoginScopes.set(key, { scope, createdAt: this.now() });
  }

  /** 读取二维码会话对应的出口归属；会话不存在或已过期返回 undefined。 */
  getLoginScope(key: string): string | undefined {
    return this.qrLoginScopes.get(key)?.scope;
  }

  /** 会话结束（授权成功或失败）后丢弃对应分桶。 */
  deleteLoginScope(key: string) {
    this.qrLoginScopes.delete(key);
  }

  /** 丢弃开完二维码却长时间不扫的会话，避免条目无限堆积。 */
  pruneLoginScopes() {
    const deadline = this.now() - QR_LOGIN_SCOPE_TTL_MS;
    for (const [key, entry] of this.qrLoginScopes) {
      if (entry.createdAt < deadline) this.qrLoginScopes.delete(key);
    }
  }
}
