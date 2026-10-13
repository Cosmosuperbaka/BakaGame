import { LRUCache } from "lru-cache";

import { AppError } from "../domain/Errors";
import type { EventLogger } from "../infrastructure/EventLogger";
import { SlidingWindowRateLimiter } from "../infrastructure/RateLimiter";
import type { Auth } from "../infrastructure/auth/Auth";
import { NICKNAME_BATCH_SIZE, type QQWebLoginClient } from "../infrastructure/auth/QQWebLogin";
import type { SettingCipher } from "../infrastructure/auth/SettingCipher";
import type { SiteConfigRepository } from "../infrastructure/db/SiteConfigRepository";
import { normalizeAccountName } from "../shared/Account";
import type { QQLookupStatus, QQLoginPollResult } from "../shared/ApiContract";

/** 查询号登录态在站点配置里的键；密文附加数据用固定的站点作用域，不会与用户 ID 冲突。 */
const SESSION_KEY = "qq.lookupSession";
const CIPHER_SCOPE = "site:";
/** 同一账号 QQ 昵称的刷新间隔：昵称不常改，降低查询号的请求量。 */
export const QQ_NAME_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 二维码约 2 分钟失效；待确认的登录多留一会儿再丢。 */
const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000;
/** 后台「全部刷新」单次最多处理的账号数，其余由下一次点击继续。 */
const REFRESH_ALL_LIMIT = 200;

interface LookupSession {
  uin: string;
  nickname: string;
  cookies: Record<string, string>;
  loggedInAt: string;
  /** 昵称接口报登录失效的时刻；失效后不再请求，等管理员重新扫码。 */
  expiredAt: string | null;
}

interface UserRow {
  id: string;
  name?: string | null;
  qqNumber?: string | null;
  qqName?: string | null;
  qqNameCheckedAt?: Date | null;
}

export interface QQNicknameServiceOptions {
  auth: Auth;
  client: QQWebLoginClient;
  config: SiteConfigRepository;
  cipher: SettingCipher;
  logger: EventLogger;
  now?: () => number;
  /** 批量刷新的批间隔；测试置 0。 */
  batchDelayMs?: number;
}

/**
 * 用后台扫码登录的一个 QQ 号查注册用户的 QQ 昵称（见 Agents/Account.md §4）。
 *
 * 账号昵称强制使用 QQ 昵称：注册时经 `resolveNickname` 取昵称，之后刷新到新昵称即同步账号昵称。
 * 查询号未登录、登录失效或接口失败时一律返回空，调用方据此停用注册或保留旧昵称。
 */
export class QQNicknameService {
  private readonly now: () => number;
  /** 全站查询配额：保护查询号不被风控；超出时本次跳过，不排队。 */
  private readonly limiter = new SlidingWindowRateLimiter({ windowMs: 60_000, maxRequests: 30 });
  private readonly pending: LRUCache<string, { qrsig: string }>;
  /** 刚查到的昵称：注册预填后紧接着的首次访问刷新不再重复请求。 */
  private readonly recent: LRUCache<string, string>;
  private session: Promise<LookupSession | null> | null = null;
  private refreshing = false;

  constructor(private readonly options: QQNicknameServiceOptions) {
    this.now = options.now ?? Date.now;
    // 缓存过期跟随注入的时钟，测试可以快进。
    const perf = { now: () => this.now() };
    this.pending = new LRUCache({ max: 16, ttl: PENDING_LOGIN_TTL_MS, perf });
    this.recent = new LRUCache({ max: 512, ttl: 10 * 60 * 1000, perf });
  }

  private loadSession(): Promise<LookupSession | null> {
    this.session ??= this.options.config.get(SESSION_KEY).then((stored) => {
      if (typeof stored !== "string") return null;
      const plain = this.options.cipher.decrypt(stored, CIPHER_SCOPE, SESSION_KEY);
      if (!plain) {
        this.options.logger.warn("QQ 查询号登录态无法解密，视为未登录");
        return null;
      }
      return JSON.parse(plain) as LookupSession;
    }).catch((error: unknown) => {
      this.session = null;
      throw error;
    });
    return this.session;
  }

  private async saveSession(session: LookupSession | null): Promise<void> {
    if (session) {
      const token = this.options.cipher.encrypt(JSON.stringify(session), CIPHER_SCOPE, SESSION_KEY);
      await this.options.config.put(SESSION_KEY, token, new Date(this.now()));
    } else {
      await this.options.config.remove(SESSION_KEY);
    }
    this.session = Promise.resolve(session);
  }

  async status(): Promise<QQLookupStatus> {
    const session = await this.loadSession();
    if (!session) return { state: "signedOut", uin: null, nickname: null, loggedInAt: null, expiredAt: null };
    return {
      state: session.expiredAt ? "expired" : "active",
      uin: session.uin,
      nickname: session.nickname || null,
      loggedInAt: session.loggedInAt,
      expiredAt: session.expiredAt,
    };
  }

  async startLogin(): Promise<{ loginId: string; image: string }> {
    const { image, qrsig } = await this.options.client.createQrCode();
    const loginId = crypto.randomUUID();
    this.pending.set(loginId, { qrsig });
    return { loginId, image };
  }

  /** `beforeSave` 在登录态落库前调用（写审计）；它失败则不保存。 */
  async pollLogin(loginId: string, beforeSave: (uin: string) => Promise<void>): Promise<QQLoginPollResult> {
    const entry = this.pending.get(loginId);
    if (!entry) return { state: "expired" };
    const result = await this.options.client.poll(entry.qrsig);
    if (result.state === "waiting" || result.state === "scanned") return { state: result.state };
    this.pending.delete(loginId);
    if (result.state === "expired") return { state: "expired" };
    if (result.state === "failed") return { state: "failed", message: result.message };
    await beforeSave(result.uin);
    await this.saveSession({
      uin: result.uin,
      nickname: result.nickname,
      cookies: result.cookies,
      loggedInAt: new Date(this.now()).toISOString(),
      expiredAt: null,
    });
    this.options.logger.info("QQ 查询号已登录", { uin: result.uin });
    return { state: "success", status: await this.status() };
  }

  async logout(): Promise<void> {
    await this.saveSession(null);
  }

  /**
   * 查一批昵称；返回 `null` 表示这次没查成（未登录、失效、超配额或接口失败），与「查了但没有昵称」区分。
   * 登录失效会被记下，直到重新扫码。
   */
  private async lookup(qqNumbers: readonly string[]): Promise<Map<string, string> | null> {
    const session = await this.loadSession().catch(() => null);
    if (!session || session.expiredAt || !qqNumbers.length) return null;
    if (!this.limiter.allow("global", this.now())) return null;
    try {
      const names = await this.options.client.nicknames(qqNumbers, session.cookies);
      const normalized = new Map([...names].map(([uin, name]) => [uin, normalizeAccountName(name)] as const).filter(([, name]) => name));
      for (const [uin, name] of normalized) this.recent.set(uin, name);
      return normalized;
    } catch (error) {
      if (error instanceof AppError && error.code === "QQ_SESSION_EXPIRED") {
        this.options.logger.warn("QQ 查询号登录已失效，等待管理员重新扫码", { uin: session.uin });
        await this.saveSession({ ...session, expiredAt: new Date(this.now()).toISOString() }).catch(() => {});
      } else {
        this.options.logger.warn("QQ 昵称查询失败", { error: String(error) });
      }
      return null;
    }
  }

  /** 注册预填：查不到返回 `null`。 */
  async nicknameOf(qqNumber: string): Promise<string | null> {
    return (await this.lookup([qqNumber]))?.get(qqNumber) ?? null;
  }

  /**
   * 建号钩子解析账号昵称：发码阶段已查过并进缓存，优先命中；缓存不在（如进程重启）时补一次实时查询。
   * 返回 `null` 表示这次拿不到昵称，调用方拒绝注册。
   */
  async resolveNickname(qqNumber: string): Promise<string | null> {
    return this.recent.get(qqNumber) ?? this.nicknameOf(qqNumber);
  }

  private async adapter() {
    return (await this.options.auth.$context).internalAdapter;
  }

  /** 每次访问时按间隔刷新本人的 QQ 昵称，查到时同步账号昵称；查不到时只记检查时刻，保留旧值。 */
  async refreshUser(row: UserRow): Promise<void> {
    if (!row.qqNumber) return;
    const checkedAt = row.qqNameCheckedAt ? new Date(row.qqNameCheckedAt).getTime() : 0;
    if (this.now() - checkedAt < QQ_NAME_REFRESH_INTERVAL_MS) return;
    const cached = this.recent.get(row.qqNumber);
    const names = cached ? new Map([[row.qqNumber, cached]]) : await this.lookup([row.qqNumber]);
    if (!names) return;
    const name = names.get(row.qqNumber);
    await (await this.adapter()).updateUser(row.id, name ? { qqName: name, name, qqNameCheckedAt: new Date(this.now()) } : { qqNameCheckedAt: new Date(this.now()) });
  }

  /**
   * 后台手动刷新：优先处理从没查过与最久未查的账号。
   * 单次最多 `REFRESH_ALL_LIMIT` 个；同一时刻只跑一轮。
   */
  async refreshAll(): Promise<{ checked: number; updated: number; remaining: number }> {
    const status = await this.status();
    if (status.state !== "active") throw new AppError("QQ_SESSION_REQUIRED", "请先在后台扫码登录查询用的 QQ 号");
    if (this.refreshing) throw new AppError("RATE_LIMITED", "正在刷新，请稍后再试");
    this.refreshing = true;
    try {
      const { adapter } = await this.options.auth.$context;
      const stale = new Date(this.now() - QQ_NAME_REFRESH_INTERVAL_MS);
      const candidates = (await adapter.findMany<UserRow>({ model: "user", limit: 100_000 }))
        .filter((row) => row.qqNumber && (!row.qqNameCheckedAt || new Date(row.qqNameCheckedAt) < stale))
        .sort((a, b) => (a.qqNameCheckedAt ? new Date(a.qqNameCheckedAt).getTime() : 0) - (b.qqNameCheckedAt ? new Date(b.qqNameCheckedAt).getTime() : 0));
      const batch = candidates.slice(0, REFRESH_ALL_LIMIT);
      const internal = await this.adapter();
      let checked = 0;
      let updated = 0;
      for (let index = 0; index < batch.length; index += NICKNAME_BATCH_SIZE) {
        if (index > 0 && this.options.batchDelayMs !== 0) await Bun.sleep(this.options.batchDelayMs ?? 1_000);
        const chunk = batch.slice(index, index + NICKNAME_BATCH_SIZE);
        const names = await this.lookup(chunk.map((row) => row.qqNumber!));
        // 没查成（失效、超配额、接口失败）就停下，不把这批账号标成已查。
        if (!names) break;
        const checkedAt = new Date(this.now());
        for (const row of chunk) {
          const name = names.get(row.qqNumber!);
          await internal.updateUser(row.id, name ? { qqName: name, name, qqNameCheckedAt: checkedAt } : { qqNameCheckedAt: checkedAt });
          checked += 1;
          if (name && name !== row.name) updated += 1;
        }
      }
      return { checked, updated, remaining: candidates.length - checked };
    } finally {
      this.refreshing = false;
    }
  }
}
