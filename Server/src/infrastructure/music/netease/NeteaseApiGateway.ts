import { AppError } from "../../../domain/Errors";
import { describeError, type EventLogger } from "../../EventLogger";
import { readChinaIpRanges } from "../ChinaIpRanges";
import { IP_SCOPE_ANONYMOUS, MusicIpScopeRegistry } from "../MusicIpScope";
import type { UpstreamRequestQueue } from "../UpstreamRequestQueue";
import { createMusicQueue } from "../UpstreamQueueFactory";
import { asRecord, readNumber } from "../../JsonReaders";
import { responseBody, responseCode, responseCookie, responseMessage } from "./NeteaseResponse";
import type {
  ApiFunction,
  ApiModule,
  ApiResponse,
  NeteaseMusicProviderOptions,
} from "./NeteaseTypes";

/**
 * 网易云「操作频繁」的响应码集合。
 *
 * - `405` 歌曲类接口的通用限流；
 * - `406` **登录链路限流**，文案与 405 完全一致，只认 405 会漏判整条扫码链路 ——
 *   表现为房主扫码时一直撞墙、既不退避也不提示；
 * - `429` / `503` 同一语义的其它表现形式。
 *
 * 判定必须同时覆盖 `body.code` 与 HTTP status：Enhanced API 的不同端点可能 resolve 一个
 * 带 code 的 body，也可能 reject 一个带 status 的错误。
 */
export const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([405, 406, 429, 503]);

export const isRateLimitCode = (code: number | undefined) =>
  code !== undefined && RATE_LIMIT_CODES.has(code);

/**
 * 不该继续尝试后备端点的「全局性失败」。
 *
 * 这两种错误与具体端点无关：换一个兼容接口再排一次队，要么同样被上游拒绝，
 * 要么只是把本地队列堵得更久。只有其余失败（端点缺失、参数不被接受等）才值得换端点重试。
 */
export const NON_RETRYABLE_API_ERROR_CODES: ReadonlySet<string> = new Set([
  "MUSIC_API_RATE_LIMITED",
  "MUSIC_API_BUSY",
]);

/**
 * 网易云上游请求网关：独占接口包加载、匿名令牌、出口作用域与请求队列这几份可变状态。
 * 登录、解灰与业务 provider 都经它出站，保证限流退避与出口归属只有一处裁决。
 */
export class NeteaseApiGateway {
  private apiPromise?: Promise<ApiModule>;
  readonly randomCNIP: boolean;
  private anonymousCookie?: string;
  readonly ipScopes: MusicIpScopeRegistry;
  private readonly requestQueue: UpstreamRequestQueue;
  private readonly logger?: EventLogger;
  private readonly random: { nextFloat?: () => number };

  constructor(
    private readonly options: NeteaseMusicProviderOptions,
    private readonly now: () => number,
    random: { nextFloat?: () => number }
  ) {
    this.logger = options.logger;
    this.random = random;
    this.randomCNIP = options.randomCNIP ?? true;
    this.ipScopes = new MusicIpScopeRegistry({
      now: this.now,
      random: this.random,
      chinaIpRanges: readChinaIpRanges(),
      platformKey: "netease",
      logger: this.logger,
    });
    this.requestQueue = createMusicQueue({
      now: this.now,
      random: this.random,
      tuning: options,
      messages: {
        queueFull: "网易云请求排队过多，请稍后重试",
        queueTimeout: "网易云请求等待超时，请稍后重试",
        requestTimeout: "网易云请求超时，请稍后重试",
        rateLimitFallback: "操作频繁，请稍候再试",
      },
      isRateLimitError: (error) => this.isRateLimitError(error),
      readRateLimitMessage: (error, fallback) => responseMessage(responseBody(error), fallback),
      onRateLimitCooldown: ({
        scope,
        strikes,
        cooldownDurationMs,
        cooldownUntil,
        droppedQueuedRequests,
        reason,
      }) => {
        // 限流后顺手刷新该 scope 的伪装 IP，退避结束的请求换一个出口（见 Registry.rotateScopeIp）。
        this.ipScopes.rotateScopeIp(scope);
        this.logger?.warn("网易云接口触发限流退避", {
          strikes,
          cooldownDurationMs,
          cooldownUntil: new Date(cooldownUntil).toISOString(),
          droppedQueuedRequests,
          rotatedScope: scope,
          reason,
        });
      },
      rateLimitUpstreamCode: 405,
    });
  }

  /** 队列正在冷却或有请求在排队：缓存据此推迟后台预刷新。 */
  isBusy(): boolean {
    return this.requestQueue.isCoolingDown() || this.requestQueue.queuedCount > 0;
  }

  /**
   * 预热音乐上游：在进程启动阶段就加载 API 模块并注册匿名令牌。
   *
   * 冷进程第一次触碰音乐链路要顺序支付「动态导入接口包 + 注册匿名令牌 + 首个上游请求的
   * DNS/TCP 建连」，不预热会让第一位进房玩家替整个进程垫付，房间徽标长时间停在「本机已登录」。
   * 预热失败不阻断业务：只记告警，调用方照旧走惰性加载并重试。
   */
  async warmUp(): Promise<void> {
    try {
      await this.loadApi();
    } catch (error) {
      this.logger?.warn("网易云上游预热失败，将在首次请求时重试", describeError(error));
    }
  }

  private loadApi(): Promise<ApiModule> {
    if (!this.apiPromise) {
      this.apiPromise = (async () => {
        const api = this.options.loadApi
          ? await this.options.loadApi()
          : ((await import("@neteasecloudmusicapienhanced/api")) as ApiModule);
        await this.prepareAnonymousSession(api);
        return api;
      })().catch((error: unknown) => {
        // 拒绝的 Promise 绝不能留在字段上：预热期的一次抖动会把整个进程的音乐链路永久钉死。
        this.apiPromise = undefined;
        throw error;
      });
    }
    return this.apiPromise;
  }

  private async prepareAnonymousSession(api: ApiModule) {
    if (this.anonymousCookie || typeof api.register_anonimous !== "function") return;
    try {
      // 匿名令牌是全进程共享的匿名身份，固定挂在匿名 scope 上，不落进任何玩家的桶。
      const response = await this.requestQueue.scheduleRequest(
        () =>
          (api.register_anonimous as ApiFunction)({
            crypto: "weapi",
            cookie: {},
            randomCNIP: this.randomCNIP,
            ...(this.randomCNIP ? { realIP: this.ipScopes.ensureScopeIp(IP_SCOPE_ANONYMOUS) } : {}),
          }),
        IP_SCOPE_ANONYMOUS
      );
      this.anonymousCookie = responseCookie(response);
    } catch (error) {
      this.logger?.warn("注册网易云匿名令牌未成功，继续以无凭据模式运行", describeError(error));
    }
  }

  async call(
    names: string[],
    params: Record<string, unknown>,
    cookie?: string | Record<string, unknown>,
    randomCNIP = this.randomCNIP,
    preserveErrorResponse = false,
    includeAnonymousCookie = true,
    loginScope?: string
  ): Promise<ApiResponse> {
    const api = await this.loadApi();
    // 在调度前定好 IP 归属：限流发生时要按同一个 scope 刷新 IP，两处必须一致。
    const ipScope = this.ipScopes.resolveIpScope(cookie, loginScope, names);
    let hasEndpoint = false;
    let lastErrorResponse: ApiResponse | undefined;
    let lastError: unknown;
    for (const name of names) {
      const fn = api[name];
      if (typeof fn !== "function") continue;
      hasEndpoint = true;
      try {
        return await this.invokeApiEndpoint(
          fn as ApiFunction,
          params,
          cookie,
          randomCNIP,
          includeAnonymousCookie,
          loginScope,
          ipScope
        );
      } catch (error) {
        lastError = error;
        // 同一能力可能有多个兼容端点；当前端点运行失败时继续尝试后备实现。
        const preserved = this.classifyEndpointFailure(error);
        if (preserved !== undefined) lastErrorResponse = preserved;
      }
    }
    if (!hasEndpoint) {
      throw new AppError("MUSIC_API_UNAVAILABLE", `音乐 API 缺少接口：${names.join(" / ")}`);
    }
    if (preserveErrorResponse && lastErrorResponse) return lastErrorResponse;
    throw this.upstreamError(lastErrorResponse ?? lastError);
  }

  /** 调用单个端点：正常 resolve 的 405 body 同样转成业务异常。 */
  private async invokeApiEndpoint(
    fn: ApiFunction,
    params: Record<string, unknown>,
    cookie: string | Record<string, unknown> | undefined,
    randomCNIP: boolean,
    includeAnonymousCookie: boolean,
    loginScope: string | undefined,
    ipScope: string | undefined
  ): Promise<ApiResponse> {
    const response = await this.requestQueue.scheduleRequest(
      () =>
        fn(
          this.withCookie(params, cookie, randomCNIP, includeAnonymousCookie, loginScope, ipScope)
        ),
      ipScope
    );
    // Enhanced API 的不同端点可能选择 reject，也可能正常 resolve 一个 405 body。
    // scheduleRequest 内部已统一触发 enterRateLimitCooldown，此处将 405 body 转为业务异常。
    if (this.isRateLimitError(response)) {
      throw this.upstreamError(response);
    }
    return response;
  }

  /**
   * 端点失败分类：不可重试与限流直接中止整次调用，其余只回传可保留的 405 响应。
   * 返回 undefined 表示调用方只需记住 lastError 并继续下一个端点。
   */
  private classifyEndpointFailure(error: unknown): ApiResponse | undefined {
    if (error instanceof AppError && NON_RETRYABLE_API_ERROR_CODES.has(error.code)) throw error;
    if (this.isRateLimitError(error)) throw this.upstreamError(error);
    return "body" in asRecord(error) ? (error as ApiResponse) : undefined;
  }

  /**
   * 调用「可能不存在」的端点：只有接口包确实没有该能力时才返回 undefined（可当作「上游没有」缓存），
   * 其余失败一律抛出，调用方放在缓存加载器里时失败不会落缓存。
   */
  async callIfAvailable(
    names: string[],
    params: Record<string, unknown>,
    cookie?: string | Record<string, unknown>
  ): Promise<ApiResponse | undefined> {
    try {
      return await this.call(names, params, cookie);
    } catch (error) {
      if (error instanceof AppError && error.code === "MUSIC_API_UNAVAILABLE") return undefined;
      throw error;
    }
  }

  async callOptional(
    names: string[],
    params: Record<string, unknown>,
    cookie?: string | Record<string, unknown>,
    randomCNIP = this.randomCNIP,
    includeAnonymousCookie = true,
    loginScope?: string
  ): Promise<ApiResponse | undefined> {
    try {
      return await this.call(
        names,
        params,
        cookie,
        randomCNIP,
        false,
        includeAnonymousCookie,
        loginScope
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "MUSIC_API_UNAVAILABLE") return undefined;
      if (error instanceof AppError && NON_RETRYABLE_API_ERROR_CODES.has(error.code)) throw error;
      this.logger?.warn("网易云可选接口调用降级", {
        endpoints: names,
        error: describeError(error),
      });
      return undefined;
    }
  }

  cacheKey(namespace: string, cookie: unknown, ...parts: unknown[]) {
    // 同一份 cookie 原文映射到同一个缓存 scope（sha256 前 16 位），与 IP scope 的口径一致。
    const scope = this.ipScopes.cookieFingerprint(cookie) || "anonymous";
    return [namespace, scope, ...parts].map(String).join(":");
  }

  private upstreamError(error: unknown) {
    if (error instanceof AppError) return error;
    const body = responseBody(error);
    const code = responseCode(body) ?? readNumber(asRecord(error).status);
    const message = responseMessage(
      body,
      error instanceof Error && error.message ? error.message : "网易云音乐接口请求失败，请稍后重试"
    );
    return new AppError(
      isRateLimitCode(code) ? "MUSIC_API_RATE_LIMITED" : "MUSIC_API_FAILED",
      message,
      { upstreamCode: code }
    );
  }

  private isRateLimitError(error: unknown) {
    const body = responseBody(error);
    return (
      isRateLimitCode(responseCode(body)) || isRateLimitCode(readNumber(asRecord(error).status))
    );
  }

  private withCookie(
    params: Record<string, unknown>,
    cookie?: string | Record<string, unknown>,
    randomCNIP = this.randomCNIP,
    includeAnonymousCookie = true,
    loginScope?: string,
    ipScope?: string
  ): Record<string, unknown> {
    const rawCookie =
      typeof cookie === "object" && cookie !== null && "netease" in cookie
        ? cookie.netease
        : cookie;
    const requestCookie = rawCookie ?? (includeAnonymousCookie ? this.anonymousCookie : undefined);
    // scope 由调用方在调度前算好并透传：限流发生时要按同一个 scope 刷新 IP，两处必须一致。
    const scope = ipScope ?? this.ipScopes.resolveIpScope(cookie, loginScope);
    return {
      ...params,
      // 始终显式传入 cookie，阻止 Enhanced API 从进程环境变量 NETEASE_COOKIE 偷读旧凭据。
      cookie: requestCookie ?? {},
      // 伪装 IP 按 scope 稳定：同一玩家、同一凭证在各自作用域内复用同一个 IP，不同玩家各持一个，
      // 避免全部请求把配额挤在同一个出口上。
      ...(randomCNIP ? { realIP: this.ipScopes.ensureScopeIp(scope) } : {}),
      randomCNIP,
    };
  }
}
