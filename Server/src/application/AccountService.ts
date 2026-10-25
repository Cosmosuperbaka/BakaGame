import { LRUCache } from "lru-cache";

import { AppError } from "../domain/Errors";
import type { BadgeRepository } from "../infrastructure/db/BadgeRepository";
import type { RegistrationRepository } from "../infrastructure/db/RegistrationRepository";
import type { EventLogger } from "../infrastructure/EventLogger";
import { SlidingWindowRateLimiter } from "../infrastructure/RateLimiter";
import type { Auth } from "../infrastructure/auth/Auth";
import type { Mailer } from "../infrastructure/auth/Mailer";
import type { AvatarImage, AvatarSize, QQAvatarService } from "../infrastructure/auth/QQAvatar";
import type { QQNicknameService } from "./QQNicknameService";
import { accountAvatarUrlOf, LOGIN_CODE_RESEND_SECONDS, qqEmailOf } from "../shared/Account";
import type { AccountProfile, PublicProfile } from "../shared/ApiContract";
import { PIONEER_BADGE_LIMIT, type AccountBadge, type BadgeKind } from "../shared/Badges";
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
  equippedBadge?: string | null;
}

export interface AccountServiceOptions {
  auth: Auth;
  mailer: Mailer;
  avatars: QQAvatarService;
  /** 身份徽章只随资料返回，不进房间快照。 */
  badges: BadgeRepository;
  /** 建号序号：先行者按它自动授予。 */
  registrations: RegistrationRepository;
  /** 最高管理员 QQ 号：主理人只授予这个账号。 */
  ownerQqNumber?: string | null;
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
 * 用户行经 Better Auth 的 `internalAdapter` 读写，生产落数据库适配器、测试落内存适配器，两边同一套逻辑。
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
  /**
   * 登录弹窗按 QQ 号回显昵称的配额：按客户端地址分桶。
   * 这个接口不必发信就能拿到昵称，不限住就成了按号枚举昵称的入口（见 Server/docs/Account.md §4）。
   */
  private readonly nicknameLimiter = new SlidingWindowRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 12,
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

  /**
   * 启动时补齐自动徽章：给存量账号分配注册序号，前 1000 位补发先行者，
   * 最高管理员独占主理人。管理员账号可能尚未注册，此时先清空其他人的主理人。
   */
  async ensureAutomaticBadges(): Promise<void> {
    await this.options.registrations.ensureAll();
    const ownerQqNumber = this.options.ownerQqNumber;
    const owner = ownerQqNumber ? await this.findUserByQq(ownerQqNumber) : null;
    await this.options.badges.resetExclusive("owner", owner?.id ?? null);
    if (owner) {
      const owned = await this.options.badges.badgesOf(owner.id);
      if (!owned.some((badge) => badge.kind === "owner"))
        await this.options.badges.grant(owner.id, "owner", null, new Date(this.now()));
    }

    const early = await this.options.registrations.earlyAdopters(PIONEER_BADGE_LIMIT);
    const existing = await this.options.badges.badgesOfMany(early.map((entry) => entry.userId));
    for (const { userId } of early) {
      if (existing.get(userId)?.some((badge) => badge.kind === "pioneer")) continue;
      await this.options.badges.grant(userId, "pioneer", null, new Date(this.now()));
    }
  }

  /** 建号钩子：分配注册序号并补上系统徽章；失败由调用方记录，不回滚建号。 */
  async afterRegistration(user: { id: string; qqNumber?: string | null }): Promise<void> {
    const serial = await this.options.registrations.register(user.id);
    const now = new Date(this.now());
    if (this.options.ownerQqNumber && user.qqNumber === this.options.ownerQqNumber)
      await this.options.badges.grant(user.id, "owner", null, now);
    if (serial <= PIONEER_BADGE_LIMIT)
      await this.options.badges.grant(user.id, "pioneer", null, now);
  }

  private async findUserByQq(qqNumber: string): Promise<AccountRow | null> {
    const result = await (await this.adapter()).findUserByEmail(qqEmailOf(qqNumber));
    return (result?.user as AccountRow | undefined) ?? null;
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

  /**
   * 登录弹窗的身份回显：QQ 号输入后立刻告诉访客「这个号是谁」。
   * 已注册只回库里最近一次同步的昵称，不为一个输入框去打查询号；未注册现查一次即将用作账号昵称的值。
   * 查不到就返回 `null`（空着），不挡住发码；配额按客户端地址计，防止按号枚举昵称。
   */
  async qqNickname(qqNumber: string, clientKey: string): Promise<string | null> {
    if (!this.nicknameLimiter.allow(clientKey, this.now()))
      throw new AppError("RATE_LIMITED", "昵称查询过于频繁，请稍后再试");
    // 查询号没配就等于「新号一律注册不了」：这时只回库里那份昵称，本接口不再需要发信也不再需要
    // 打上游，非空与空的差别直接读成「这个号在本站注册过」，白送一个可批量用的注册状态答案。
    const nicknames = this.options.nicknames;
    if (!nicknames) return null;
    const existing = (await (await this.adapter()).findUserByEmail(qqEmailOf(qqNumber)))?.user as
      { name?: string | null; qqName?: string | null } | undefined;
    if (existing) return existing.qqName ?? existing.name ?? null;
    const timeout = new Promise<null>((resolve) =>
      setTimeout(resolve, NICKNAME_LOOKUP_TIMEOUT_MS, null)
    );
    // 命中发码阶段的查询缓存时不打上游；查询号慢或挂了都只等 `NICKNAME_LOOKUP_TIMEOUT_MS`。
    return (
      (await Promise.race([nicknames.resolveNickname(qqNumber).catch(() => null), timeout])) ?? null
    );
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
    const [refreshed, badges] = await Promise.all([
      this.refreshAvatar(row),
      this.options.badges.badgesOf(row.id),
    ]);
    return toProfile(refreshed, badges);
  }

  /** 账号当前昵称（读库，不取会话缓存）；账号已注销返回 `null`。 */
  async nameOf(userId: string): Promise<string | null> {
    return (await this.findUser(userId))?.name ?? null;
  }

  /** 账号昵称强制取自 QQ 昵称（见 Server/docs/Account.md §4），不可修改；这里只接受 QQ 号公开开关。 */
  async updateProfile(userId: string, input: { showQq?: boolean }): Promise<AccountProfile> {
    const patch: Record<string, unknown> = {};
    if (input.showQq !== undefined) patch.showQq = input.showQq;
    const adapter = await this.adapter();
    const row = Object.keys(patch).length
      ? ((await adapter.updateUser(userId, patch)) as AccountRow | null)
      : await this.findUser(userId);
    if (!row) throw new AppError("UNAUTHORIZED", "请先登录");
    return toProfile(row, await this.options.badges.badgesOf(row.id));
  }

  /** 玩家自行切换佩戴的徽章；`null` 表示不佩戴。只能佩戴自己已获得的那一枚。 */
  async updateEquippedBadge(userId: string, badge: BadgeKind | null): Promise<AccountProfile> {
    const row = await this.findUser(userId);
    if (!row) throw new AppError("UNAUTHORIZED", "请先登录");
    const badges = await this.options.badges.badgesOf(row.id);
    if (badge && !badges.some((item) => item.kind === badge))
      throw new AppError("FORBIDDEN", "还没有获得这枚徽章");
    const updated = (await (
      await this.adapter()
    ).updateUser(userId, {
      equippedBadge: badge,
    })) as AccountRow | null;
    return toProfile(updated ?? { ...row, equippedBadge: badge }, badges);
  }

  async publicProfile(userId: string): Promise<PublicProfile> {
    const row = await this.findUser(userId);
    if (!row) throw new AppError("NOT_FOUND", "该玩家未登录账号或账号已注销");
    const badges = await this.options.badges.badgesOf(row.id);
    return {
      id: row.id,
      name: row.name,
      image: row.image ?? null,
      qqNumber: row.showQq ? (row.qqNumber ?? null) : null,
      badges,
      equippedBadge: equippedBadgeOf(row, badges),
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

const equippedBadgeOf = (row: AccountRow, badges: readonly AccountBadge[]): BadgeKind | null =>
  badges.some((badge) => badge.kind === row.equippedBadge)
    ? (row.equippedBadge as BadgeKind)
    : null;

const toProfile = (row: AccountRow, badges: readonly AccountBadge[]): AccountProfile => ({
  id: row.id,
  name: row.name,
  qqNumber: row.qqNumber ?? "",
  image: row.image ?? null,
  showQq: Boolean(row.showQq),
  role: row.role === "admin" ? "admin" : "user",
  badges: [...badges],
  equippedBadge: equippedBadgeOf(row, badges),
  createdAt: new Date(row.createdAt).toISOString(),
});
