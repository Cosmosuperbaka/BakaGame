import { LRUCache } from "lru-cache";

import { AppError } from "../domain/Errors";
import type { EventLogger } from "../infrastructure/EventLogger";
import type { Auth } from "../infrastructure/auth/Auth";
import type { QQNapCatClient } from "../infrastructure/auth/QQNapCatClient";
import { normalizeAccountName } from "../shared/Account";
import type { QQLookupStatus } from "../shared/ApiContract";

/** 同一账号 QQ 昵称的刷新间隔：昵称不常改，降低查询号一侧的请求量。 */
export const QQ_NAME_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 后台「全部刷新」单次最多处理的账号数，其余由下一次点击继续。 */
const REFRESH_ALL_LIMIT = 200;

interface UserRow {
  id: string;
  name?: string | null;
  qqNumber?: string | null;
  qqName?: string | null;
  qqNameCheckedAt?: Date | null;
}

export interface QQNicknameServiceOptions {
  auth: Auth;
  /** NapCat 的 OneBot 客户端；未配置实例时整个服务不装配（后台 `admin.qq.*` 回 503）。 */
  client: QQNapCatClient;
  logger: EventLogger;
  now?: () => number;
}

/** 不可用原因 → 后台展示文案；不含地址与令牌。 */
const statusMessage = (kind: string | undefined): string => {
  if (kind === "unauthorized") return "访问令牌无效，请核对 NapCat 的 OneBot 访问令牌";
  if (kind === "network") return "无法连接到 NapCat 实例，请检查内网连通与服务状态";
  return "NapCat 实例暂时不可用";
};

/**
 * 通过管理员自建的 NapCat（OneBot 11）查注册用户的 QQ 昵称（见 Server/docs/Account.md §4）。
 *
 * 账号昵称强制使用 QQ 昵称：注册时经 `resolveNickname` 取昵称，之后刷新到新昵称即同步账号昵称。
 * NapCat 未配置、未登录或查询失败时一律返回空，调用方据此停用注册或保留旧昵称。
 */
export class QQNicknameService {
  private readonly now: () => number;
  /** 刚查到的昵称：注册预填后紧接着的首次访问刷新不再重复请求。 */
  private readonly recent: LRUCache<string, string>;
  private refreshing = false;

  constructor(private readonly options: QQNicknameServiceOptions) {
    this.now = options.now ?? Date.now;
    this.recent = new LRUCache({ max: 512, ttl: 10 * 60 * 1000, perf: { now: () => this.now() } });
  }

  /**
   * NapCat 的登录状态。
   *
   * 每次实时探测、不缓存：它只是 NapCat 本地的 `get_login_info`，不触碰 QQ 侧接口，
   * 而缓存会让后台「重新检测」点下去毫无反应——那正是运维需要它准的时候。
   */
  async status(): Promise<QQLookupStatus> {
    const checkedAt = new Date(this.now()).toISOString();
    try {
      const info = await this.options.client.loginInfo();
      return info
        ? { state: "active", uin: info.uin, nickname: info.nickname, checkedAt, error: null }
        : {
            state: "unavailable",
            uin: null,
            nickname: null,
            checkedAt,
            error: "NapCat 当前没有登录任何 QQ 号",
          };
    } catch (error) {
      const kind =
        error instanceof AppError
          ? (error.details as { kind?: string } | undefined)?.kind
          : undefined;
      this.options.logger.warn("QQ 昵称服务不可用", { kind, error: String(error) });
      return {
        state: "unavailable",
        uin: null,
        nickname: null,
        checkedAt,
        error: statusMessage(kind),
      };
    }
  }

  /**
   * 查一批昵称；返回 `null` 表示这次没查成（实例不可用、掉线或接口失败），
   * 与「查了但没有昵称」区分。
   */
  private async lookup(qqNumbers: readonly string[]): Promise<Map<string, string> | null> {
    if (!qqNumbers.length) return null;
    try {
      const names = await this.options.client.nicknames(qqNumbers);
      const normalized = new Map(
        [...names]
          .map(([uin, name]) => [uin, normalizeAccountName(name)] as const)
          .filter(([, name]) => name)
      );
      for (const [uin, name] of normalized) this.recent.set(uin, name);
      return normalized;
    } catch (error) {
      this.options.logger.warn("QQ 昵称查询失败", { error: String(error) });
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
    await (
      await this.adapter()
    ).updateUser(
      row.id,
      name
        ? { qqName: name, name, qqNameCheckedAt: new Date(this.now()) }
        : { qqNameCheckedAt: new Date(this.now()) }
    );
  }

  /**
   * 后台手动刷新：优先处理从没查过与最久未查的账号。
   * 单次最多 `REFRESH_ALL_LIMIT` 个；同一时刻只跑一轮。
   */
  async refreshAll(): Promise<{ checked: number; updated: number; remaining: number }> {
    const status = await this.status();
    if (status.state !== "active") {
      throw new AppError("QQ_NICKNAME_UNAVAILABLE", status.error ?? "QQ 昵称服务不可用");
    }
    if (this.refreshing) throw new AppError("RATE_LIMITED", "正在刷新，请稍后再试");
    this.refreshing = true;
    try {
      const { adapter } = await this.options.auth.$context;
      const stale = new Date(this.now() - QQ_NAME_REFRESH_INTERVAL_MS);
      const candidates = (await adapter.findMany<UserRow>({ model: "user", limit: 100_000 }))
        .filter(
          (row) => row.qqNumber && (!row.qqNameCheckedAt || new Date(row.qqNameCheckedAt) < stale)
        )
        .sort(
          (a, b) =>
            (a.qqNameCheckedAt ? new Date(a.qqNameCheckedAt).getTime() : 0) -
            (b.qqNameCheckedAt ? new Date(b.qqNameCheckedAt).getTime() : 0)
        );
      const batch = candidates.slice(0, REFRESH_ALL_LIMIT);
      // 没查成（掉线、令牌失效、接口失败）就停下，不把这批账号标成已查。
      const names = await this.lookup(batch.map((row) => row.qqNumber!));
      if (!names) return { checked: 0, updated: 0, remaining: candidates.length };
      const internal = await this.adapter();
      const checkedAt = new Date(this.now());
      let checked = 0;
      let updated = 0;
      for (const row of batch) {
        const name = names.get(row.qqNumber!);
        await internal.updateUser(
          row.id,
          name ? { qqName: name, name, qqNameCheckedAt: checkedAt } : { qqNameCheckedAt: checkedAt }
        );
        checked += 1;
        if (name && name !== row.name) updated += 1;
      }
      return { checked, updated, remaining: candidates.length - checked };
    } finally {
      this.refreshing = false;
    }
  }
}
