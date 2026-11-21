import { LRUCache } from "lru-cache";

import { AppError } from "../domain/Errors";
import type { BadgeRepository } from "../infrastructure/db/BadgeRepository";
import type { RegistrationRepository } from "../infrastructure/db/RegistrationRepository";
import type { EventLogger } from "../infrastructure/EventLogger";
import { SlidingWindowRateLimiter } from "../infrastructure/RateLimiter";
import type { Auth } from "../infrastructure/auth/Auth";
import type { Mailer } from "../infrastructure/auth/Mailer";
import type { AvatarImage, AvatarSize, QQAvatarService } from "../infrastructure/auth/QQAvatar";
import { checkAccountName } from "../infrastructure/auth/AccountName";
import {
  ACCOUNT_NAME_CHANGE_COOLDOWN_MS,
  accountAvatarUrlOf,
  LOGIN_CODE_RESEND_SECONDS,
  qqEmailOf,
} from "../shared/Account";
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
  nameChangedAt?: Date | null;
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
  now?: () => number;
}

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
   * 发码按来源地址的配额：没有这一层，单个匿名客户端换着号码就能耗尽全站额度，
   * 让所有人收不到验证码。分钟额度明显低于全站额度，才挤不满全站；小时额度压住慢速消耗。
   */
  private readonly clientLimiter = new SlidingWindowRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 10,
  });
  private readonly clientHourlyLimiter = new SlidingWindowRateLimiter({
    windowMs: 60 * 60 * 1000,
    maxRequests: 60,
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

  /** 账号昵称（排位赛显示名）；账号不存在为 null。 */
  async displayName(userId: string): Promise<string | null> {
    return (await this.findUser(userId))?.name ?? null;
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
   * 最高管理员独占主理人。
   *
   * 找不到主理人账号（配置写错、管理员尚未注册、查询失败）时**保留现有授予**：
   * 清空换不来新的主理人，只会把已经生效的那一枚抹掉，且没有任何日志能事后追回。
   */
  async ensureAutomaticBadges(): Promise<void> {
    await this.options.registrations.ensureAll();
    const ownerQqNumber = this.options.ownerQqNumber;
    const owner = ownerQqNumber ? await this.findUserByQq(ownerQqNumber) : null;
    if (owner) {
      await this.options.badges.resetExclusive("owner", owner.id);
      const owned = await this.options.badges.badgesOf(owner.id);
      if (!owned.some((badge) => badge.kind === "owner")) {
        await this.options.badges.grant(owner.id, "owner", null, new Date(this.now()));
        this.options.logger.info("主理人徽章已授予", { userId: owner.id });
      }
    } else {
      this.options.logger.warn("主理人账号未找到，保留现有主理人徽章", {
        ownerQqNumber: ownerQqNumber ?? null,
      });
    }

    const early = await this.options.registrations.earlyAdopters(PIONEER_BADGE_LIMIT);
    const existing = await this.options.badges.badgesOfMany(early.map((entry) => entry.userId));
    const granted: number[] = [];
    for (const { userId, serial } of early) {
      if (existing.get(userId)?.some((badge) => badge.kind === "pioneer")) continue;
      await this.options.badges.grant(userId, "pioneer", null, new Date(this.now()));
      granted.push(serial);
    }
    // 新号的先行者由建号钩子当场发出，这里只补历史上的漏发；健康的库启动时应该一枚都不补，
    // 所以补了就打日志，不让第二次「注册时没发、重启后才发」再悄无声息地发生。
    if (granted.length)
      this.options.logger.warn("启动补发先行者徽章", {
        count: granted.length,
        serials: granted.slice(0, 20),
      });
  }

  /** 建号钩子：分配注册序号并当场补上系统徽章；失败由调用方记录，不回滚建号。 */
  async afterRegistration(user: { id: string; qqNumber?: string | null }): Promise<void> {
    const serial = await this.options.registrations.register(user.id);
    const now = new Date(this.now());
    if (this.options.ownerQqNumber && user.qqNumber === this.options.ownerQqNumber)
      await this.options.badges.grant(user.id, "owner", null, now);
    if (await this.pioneerEligible(user.id, serial))
      await this.options.badges.grant(user.id, "pioneer", null, now);
  }

  /**
   * 先行者判定：序号在名额内即授予。
   *
   * 序号就是「第几位」：中间账号注销的空位不回填，但最后注册者注销后下一位会沿用它的序号，
   * 所以不能说「注销不回收」。历史上托管库自增预取写出的跳号，启动自愈已经处理，正常情况下
   * 这一条就够。按名次兜底只是防线：压实被别的实例的并发建号抢出新的跳号时，序号绝对值
   * 超出名额而名次仍在名额内，此时按名次授予并告警，避免静默漏发；下一次启动的压实会收掉它。
   */
  private async pioneerEligible(userId: string, serial: number): Promise<boolean> {
    if (serial <= PIONEER_BADGE_LIMIT) return true;
    const rank = await this.options.registrations.rankOf(userId);
    if (rank === null || rank > PIONEER_BADGE_LIMIT) return false;
    this.options.logger.warn("注册序号超出先行者名额但名次仍在名额内，按名次授予", {
      userId,
      serial,
      rank,
    });
    return true;
  }

  private async findUserByQq(qqNumber: string): Promise<AccountRow | null> {
    const result = await (await this.adapter()).findUserByEmail(qqEmailOf(qqNumber));
    return (result?.user as AccountRow | undefined) ?? null;
  }

  async requestLoginCode(
    qqNumber: string,
    clientKey: string
  ): Promise<{ registered: boolean; resendAfterSeconds: number }> {
    const email = qqEmailOf(qqNumber);
    this.takeLoginCodeQuota(email, clientKey, this.now());
    const now = this.now();
    const existing = (await (await this.adapter()).findUserByEmail(email))?.user as
      { banned?: boolean | null; banExpires?: Date | null } | undefined;
    // 封禁中的账号登录必然被拒，不为它消耗发信额度；到期的封禁由 Better Auth 在登录时自动解除。
    if (
      existing?.banned &&
      (!existing.banExpires || new Date(existing.banExpires).getTime() > now)
    ) {
      throw new AppError("ACCOUNT_BANNED", "账号已被封禁");
    }
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
    return { registered: Boolean(existing), resendAfterSeconds: LOGIN_CODE_RESEND_SECONDS };
  }

  /**
   * 发码配额：从细到粗逐层只读判定（邮箱冷却 → 邮箱小时 → 来源地址 → 全站），全部放行才一起记账。
   * 细键被拒的请求不消耗粗键额度：否则对同一邮箱的重复请求就能把来源额度与全站额度耗光。
   * 判定与记账之间没有 await，并发请求不会交错。
   */
  private takeLoginCodeQuota(email: string, clientKey: string, now: number): void {
    const gates: Array<[SlidingWindowRateLimiter, string, string]> = [
      [this.resendLimiter, email, `请 ${LOGIN_CODE_RESEND_SECONDS} 秒后再获取验证码`],
      [this.hourlyLimiter, email, "验证码获取过于频繁，请一小时后再试"],
      [this.clientLimiter, clientKey, "验证码获取过于频繁，请稍后再试"],
      [this.clientHourlyLimiter, clientKey, "验证码获取过于频繁，请一小时后再试"],
      [this.globalLimiter, "global", "验证码发送繁忙，请稍后再试"],
    ];
    for (const [limiter, key, message] of gates) {
      if (!limiter.peek(key, now).allowed) throw new AppError("RATE_LIMITED", message);
    }
    for (const [limiter, key] of gates) limiter.consume(key, now);
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

  /**
   * 修改资料：QQ 号公开开关与账号昵称（见 Server/docs/Account.md §1）。
   *
   * 昵称与注册同一口径清洗并过敏感词；清洗后与当前昵称相同视为未修改，不消耗冷却。
   * 冷却从上次改名（新号为注册）起算；从未改过名的老账号没有改名时刻，第一次改名不受限。
   * 校验全部放在写库之前，任何一项被拒都不留下半个改动（公开开关也不生效）。
   */
  async updateProfile(
    userId: string,
    input: { showQq?: boolean; name?: string }
  ): Promise<AccountProfile> {
    const row = await this.findUser(userId);
    if (!row) throw new AppError("UNAUTHORIZED", "请先登录");
    const patch: Record<string, unknown> = {};
    if (input.showQq !== undefined) patch.showQq = input.showQq;
    if (input.name !== undefined) {
      const checked = checkAccountName(input.name);
      if (!checked.ok) throw new AppError(checked.code, checked.message);
      if (checked.name !== row.name) {
        const now = this.now();
        const availableAt = row.nameChangedAt
          ? new Date(row.nameChangedAt).getTime() + ACCOUNT_NAME_CHANGE_COOLDOWN_MS
          : 0;
        if (now < availableAt)
          throw new AppError(
            "NAME_CHANGE_COOLDOWN",
            `账号昵称每 ${ACCOUNT_NAME_CHANGE_COOLDOWN_MS / 86_400_000} 天只能修改一次，${formatBeijingMinute(availableAt)} 后可再次修改`
          );
        patch.name = checked.name;
        patch.nameChangedAt = new Date(now);
      }
    }
    const updated = Object.keys(patch).length
      ? ((await (await this.adapter()).updateUser(userId, patch)) as AccountRow | null)
      : row;
    if (!updated) throw new AppError("UNAUTHORIZED", "请先登录");
    return toProfile(updated, await this.options.badges.badgesOf(updated.id));
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
  nameChangedAt: row.nameChangedAt ? new Date(row.nameChangedAt).toISOString() : null,
  createdAt: new Date(row.createdAt).toISOString(),
});

/** 改名冷却提示里的时刻：按北京时间写到分钟（如「11月29日 14:30」），玩家不必换算时区。 */
const beijingMinute = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const formatBeijingMinute = (time: number): string => {
  const parts = Object.fromEntries(
    beijingMinute.formatToParts(time).map((part) => [part.type, part.value])
  );
  return `${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`;
};
