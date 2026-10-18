import { LRUCache } from "lru-cache";

import { AppError } from "../domain/Errors";
import type { EventLogger } from "../infrastructure/EventLogger";
import { SlidingWindowRateLimiter } from "../infrastructure/RateLimiter";
import type { Auth } from "../infrastructure/auth/Auth";
import type { Mailer } from "../infrastructure/auth/Mailer";
import type { AvatarImage, AvatarSize, QQAvatarService } from "../infrastructure/auth/QQAvatar";
import type { QQNicknameService } from "./QQNicknameService";
import { accountAvatarUrlOf, LOGIN_CODE_RESEND_SECONDS, qqEmailOf } from "../shared/Account";
import type { AccountProfile, PublicProfile } from "../shared/ApiContract";
import type { PlayerAccount } from "../shared/Model";

/** 账号表在应用层可见的字段（Better Auth 适配器返回的原始行）。 */
interface AccountRow {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  createdAt: Date;
  role?: string | null;
  banned?: boolean | null;
  qqNumber?: string | null;
  showQq?: boolean | null;
  avatarHash?: string | null;
  avatarCheckedAt?: Date | null;
  qqName?: string | null;
  qqNameCheckedAt?: Date | null;
}

export interface AccountServiceOptions {
  auth: Auth;
  mailer: Mailer;
  avatars: QQAvatarService;
  logger: EventLogger;
  /** QQ 昵称查询号：新号发码前必须取到昵称，取不到即拒绝（停用注册）。 */
  nicknames?: QQNicknameService | null;
  now?: () => number;
}

/** 发码前取 QQ 昵称的限时：查询号慢或挂了直接拒绝注册，不让请求挂死。 */
const NICKNAME_LOOKUP_TIMEOUT_MS = 3_000;

/** 同一账号头像回源的最小间隔：用户每次访问会触发一次，短时间内反复刷新页面不重复抓。 */
const AVATAR_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 账号自助业务：发码、资料、头像。
 *
 * 用户行经 Better Auth 的 `internalAdapter` 读写，生产落 TiDB、测试落内存适配器，两边同一套逻辑。
 */
export class AccountService {
  private readonly now: () => number;
  /** 同一邮箱的发码冷却与小时配额；全局配额保护 SMTP 发信额度。 */
  private readonly resendLimiter = new SlidingWindowRateLimiter({
    windowMs: LOGIN_CODE_RESEND_SECONDS * 1000,
    maxRequests: 1,
  });
  private readonly hourlyLimiter = new SlidingWindowRateLimiter({
    windowMs: 60 * 60 * 1000,
    maxRequests: 6,
  });
  private readonly globalLimiter = new SlidingWindowRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 30,
  });
  /** 头像路由的「用户 ID → QQ 号 / 当前版本」短缓存，避免每张图都查库。 */
  private readonly avatarOwners = new LRUCache<string, { qqNumber: string; hash: string | null }>({
    max: 4096,
    ttl: 60_000,
  });

  constructor(private readonly options: AccountServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  private async adapter() {
    return (await this.options.auth.$context).internalAdapter;
  }

  private async findUser(userId: string): Promise<AccountRow | null> {
    return (await (await this.adapter()).findUserById(userId)) as AccountRow | null;
  }

  /** 把指定 QQ 号对应的已注册账号提升为管理员；尚未注册的在建号钩子里按同一名单处理。 */
  async promoteAdmins(qqNumbers: readonly string[]): Promise<void> {
    if (!qqNumbers.length) return;
    const { adapter } = await this.options.auth.$context;
    await adapter.updateMany({
      model: "user",
      where: [
        { field: "qqNumber", operator: "in", value: [...qqNumbers] },
        { field: "role", operator: "ne", value: "admin" },
      ],
      update: { role: "admin" },
    });
  }

  async requestLoginCode(
    qqNumber: string
  ): Promise<{ registered: boolean; resendAfterSeconds: number; qqName: string | null }> {
    const email = qqEmailOf(qqNumber);
    const now = this.now();
    if (!this.globalLimiter.allow("global", now)) {
      throw new AppError("RATE_LIMITED", "验证码发送繁忙，请稍后再试");
    }
    if (!this.resendLimiter.allow(email, now)) {
      throw new AppError("RATE_LIMITED", `请 ${LOGIN_CODE_RESEND_SECONDS} 秒后再获取验证码`);
    }
    if (!this.hourlyLimiter.allow(email, now)) {
      throw new AppError("RATE_LIMITED", "验证码获取过于频繁，请一小时后再试");
    }
    const existing = (await (await this.adapter()).findUserByEmail(email))?.user as
      | {
          banned?: boolean | null;
          banExpires?: Date | null;
          name?: string | null;
          qqName?: string | null;
        }
      | undefined;
    // 封禁中的账号登录必然被拒，不为它消耗发信额度；到期的封禁由 Better Auth 在登录时自动解除。
    if (
      existing?.banned &&
      (!existing.banExpires || new Date(existing.banExpires).getTime() > now)
    ) {
      throw new AppError("ACCOUNT_BANNED", "账号已被封禁");
    }
    // 账号昵称强制使用 QQ 昵称：新号发码前必须取到昵称，取不到即拒绝（停用注册）；
    // 老号回传库里最近一次同步的昵称供登录弹窗展示身份，不为此打扰查询号。
    const qqName = existing
      ? (existing.qqName ?? existing.name ?? null)
      : await this.requireNickname(qqNumber);
    const code = await this.options.auth.api.createVerificationOTP({
      body: { email, type: "sign-in" },
    });
    try {
      await this.options.mailer.sendLoginCode({ to: email, code });
    } catch (error) {
      if (error instanceof AppError) throw error;
      this.options.logger.error("登录验证码投递失败", { error: String(error) });
      throw new AppError("MAIL_UNAVAILABLE", "验证码邮件发送失败，请稍后重试");
    }
    return { registered: Boolean(existing), resendAfterSeconds: LOGIN_CODE_RESEND_SECONDS, qqName };
  }

  /** 新号发码的硬前提：QQ 昵称必须可用；查询未登录、失效、超配额、失败或超时都拒绝注册。 */
  private async requireNickname(qqNumber: string): Promise<string> {
    const nicknames = this.options.nicknames;
    const timeout = new Promise<null>((resolve) =>
      setTimeout(resolve, NICKNAME_LOOKUP_TIMEOUT_MS, null)
    );
    const name = nicknames
      ? await Promise.race([nicknames.nicknameOf(qqNumber).catch(() => null), timeout])
      : null;
    if (!name)
      throw new AppError(
        "QQ_NICKNAME_UNAVAILABLE",
        "暂时无法获取你的 QQ 昵称，新账号注册暂时不可用，请稍后再试"
      );
    return name;
  }

  /**
   * 当前会话的账号 ID；未登录返回 `null`。
   * 跳过会话 Cookie 缓存：封禁与吊销会删库内会话，缓存会让被封账号继续通过最长 5 分钟。
   * 资料本身由调用方按 ID 读库，不取会话里的旧值。
   */
  async currentUserId(headers: Headers): Promise<string | null> {
    const session = await this.options.auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    });
    return session?.user.id ?? null;
  }

  /**
   * WebSocket 握手用：会话对应的房间内公开身份。
   * 头像按 ID 读库：会话 Cookie 缓存最长 5 分钟，新号首个头像与刷新后的头像都不在缓存里。
   */
  async socketAccount(headers: Headers): Promise<PlayerAccount | undefined> {
    const userId = await this.currentUserId(headers);
    const row = userId ? await this.findUser(userId) : null;
    return row ? { userId: row.id, image: row.image ?? null } : undefined;
  }

  async me(userId: string): Promise<AccountProfile | null> {
    const row = await this.findUser(userId);
    if (!row) return null;
    // QQ 昵称刷新在后台跑，不拖慢本次请求；刷新到新昵称时会同步账号昵称。
    void this.options.nicknames
      ?.refreshUser(row)
      .catch((error: unknown) =>
        this.options.logger.warn("QQ 昵称刷新失败", { userId: row.id, error: String(error) })
      );
    return toProfile(await this.refreshAvatar(row));
  }

  /** 账号当前昵称（读库，不取会话缓存）；账号已注销返回 `null`。 */
  async nameOf(userId: string): Promise<string | null> {
    return (await this.findUser(userId))?.name ?? null;
  }

  /** 账号昵称强制取自 QQ 昵称（见 Agents/Account.md §4），不可修改；这里只接受 QQ 号公开开关。 */
  async updateProfile(userId: string, input: { showQq?: boolean }): Promise<AccountProfile> {
    const patch: Record<string, unknown> = {};
    if (input.showQq !== undefined) patch.showQq = input.showQq;
    const adapter = await this.adapter();
    const row = Object.keys(patch).length
      ? ((await adapter.updateUser(userId, patch)) as AccountRow | null)
      : await this.findUser(userId);
    if (!row) throw new AppError("UNAUTHORIZED", "请先登录");
    return toProfile(row);
  }

  async publicProfile(userId: string): Promise<PublicProfile> {
    const row = await this.findUser(userId);
    if (!row) throw new AppError("NOT_FOUND", "该玩家未登录账号或账号已注销");
    return {
      id: row.id,
      name: row.name,
      image: row.image ?? null,
      qqNumber: row.showQq ? (row.qqNumber ?? null) : null,
    };
  }

  /**
   * 按节流重新抓 QQ 头像；字节摘要变了才改 `image`（站内 URL 随之换版本）。
   * 回源失败保留旧头像，只记告警：头像是装饰，不能挡住登录后的任何功能。
   */
  private async refreshAvatar(row: AccountRow): Promise<AccountRow> {
    const qqNumber = row.qqNumber;
    if (!qqNumber) return row;
    const checkedAt = row.avatarCheckedAt ? new Date(row.avatarCheckedAt).getTime() : 0;
    if (row.image && this.now() - checkedAt < AVATAR_REFRESH_INTERVAL_MS) return row;
    let image: AvatarImage;
    try {
      image = await this.options.avatars.get(qqNumber, 640, true);
    } catch (error) {
      this.options.logger.warn("QQ 头像刷新失败，沿用旧头像", {
        userId: row.id,
        error: String(error),
      });
      return row;
    }
    const patch: Record<string, unknown> = { avatarCheckedAt: new Date(this.now()) };
    if (image.hash !== row.avatarHash || !row.image) {
      this.options.avatars.invalidate(qqNumber);
      patch.avatarHash = image.hash;
      patch.image = accountAvatarUrlOf(row.id, image.hash);
    }
    this.avatarOwners.delete(row.id);
    const updated = (await (await this.adapter()).updateUser(row.id, patch)) as AccountRow | null;
    return updated ?? { ...row, ...patch };
  }

  /** 头像路由：返回图片与「请求的版本是否为当前版本」（决定能否永久缓存）。 */
  async avatar(
    userId: string,
    size: AvatarSize,
    version: string | undefined
  ): Promise<{ image: AvatarImage; current: boolean }> {
    let owner = this.avatarOwners.get(userId);
    if (!owner) {
      const row = await this.findUser(userId);
      if (!row?.qqNumber) throw new AppError("NOT_FOUND", "头像不存在");
      owner = { qqNumber: row.qqNumber, hash: row.avatarHash ?? null };
      this.avatarOwners.set(userId, owner);
    }
    const image = await this.options.avatars.get(owner.qqNumber, size);
    return { image, current: version !== undefined && version === owner.hash };
  }
}

const toProfile = (row: AccountRow): AccountProfile => ({
  id: row.id,
  name: row.name,
  qqNumber: row.qqNumber ?? "",
  image: row.image ?? null,
  showQq: Boolean(row.showQq),
  role: row.role === "admin" ? "admin" : "user",
  createdAt: new Date(row.createdAt).toISOString(),
});
