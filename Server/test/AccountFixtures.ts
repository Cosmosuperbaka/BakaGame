import { memoryAdapter } from "better-auth/adapters/memory";

import { AccountService } from "../src/application/AccountService";
import { AdminService } from "../src/application/AdminService";
import { AppSettings } from "../src/application/AppSettings";
import { InMemoryAntiCheatReviewQueue } from "../src/application/CEEAntiCheatSignals";
import { QQNicknameService } from "../src/application/QQNicknameService";
import { QQNapCatClient } from "../src/infrastructure/auth/QQNapCatClient";
import { SiteStatsService } from "../src/application/SiteStatsService";
import type { SentryApiClient } from "../src/infrastructure/SentryApi";
import type {
  PageDelta,
  SiteStatsRepository,
  VisitorDelta,
} from "../src/infrastructure/db/SiteStatsRepository";
import type { AdminRoomControl } from "../src/domain/AdminRoom";
import type { RecordedGame } from "../src/domain/GameRecord";
import { UserDataService, type FeedbackSink } from "../src/application/UserDataService";
import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import type { AppEnv } from "../src/config/Env";
import { createAuth } from "../src/infrastructure/auth/Auth";
import type { Mailer } from "../src/infrastructure/auth/Mailer";
import { QQAvatarService } from "../src/infrastructure/auth/QQAvatar";
import { SettingCipher } from "../src/infrastructure/auth/SettingCipher";
import type {
  AuditEntry,
  AuditFilter,
  AuditLogRepository,
  StoredAuditEntry,
} from "../src/infrastructure/db/AuditLogRepository";
import type { GameRecordRepository } from "../src/infrastructure/db/GameRecordRepository";
import type {
  FeedbackFilter,
  FeedbackRecord,
  FeedbackReplyRecord,
  FeedbackRepository,
  StoredSetting,
  UserSettingRepository,
} from "../src/infrastructure/db/UserDataRepository";
import { EventLogger } from "../src/infrastructure/EventLogger";
import type { FeedbackStatus } from "../src/shared/ApiContract";
import { isAllowedOrigin } from "../src/transport/App";
import { createTestApp } from "./AppFixtures";

export const ACCOUNT_TEST_SECRET = "fixture-secret-fixture-secret-fixture-secret";

/** 仅测试使用的内存仓储：与数据库实现同一接口，行为口径以 Drizzle 实现为准。 */
export class MemoryUserSettingRepository implements UserSettingRepository {
  readonly rows = new Map<string, StoredSetting & { userId: string }>();

  async list(userId: string): Promise<StoredSetting[]> {
    return [...this.rows.values()]
      .filter((row) => row.userId === userId)
      .map(({ key, value, updatedAt }) => ({ key, value: structuredClone(value), updatedAt }));
  }

  async put(userId: string, key: string, value: unknown, now: Date): Promise<void> {
    this.rows.set(`${userId}:${key}`, {
      userId,
      key,
      value: structuredClone(value),
      updatedAt: now,
    });
  }

  async remove(userId: string, key: string): Promise<void> {
    this.rows.delete(`${userId}:${key}`);
  }
}

export class MemoryAuditLogRepository implements AuditLogRepository {
  readonly entries: StoredAuditEntry[] = [];
  failNext = false;

  async append(entry: AuditEntry): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("audit down");
    }
    this.entries.push({ ...entry, id: this.entries.length + 1 });
  }

  async list(filter: AuditFilter): Promise<{ items: StoredAuditEntry[]; total: number }> {
    const matched = this.entries
      .filter(
        (entry) =>
          (!filter.actorId || entry.actorId === filter.actorId) &&
          (!filter.action || entry.action === filter.action) &&
          (!filter.targetType || entry.targetType === filter.targetType) &&
          (!filter.targetId || entry.targetId === filter.targetId)
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
    return {
      items: matched.slice(filter.offset, filter.offset + filter.limit),
      total: matched.length,
    };
  }
}

export class MemoryFeedbackRepository implements FeedbackRepository {
  readonly records = new Map<string, FeedbackRecord>();
  readonly replyRows: FeedbackReplyRecord[] = [];

  async create(record: FeedbackRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async update(id: string, patch: Parameters<FeedbackRepository["update"]>[1]): Promise<void> {
    const record = this.records.get(id);
    if (record) Object.assign(record, patch);
  }

  async get(id: string): Promise<FeedbackRecord | null> {
    const record = this.records.get(id);
    return record ? { ...record } : null;
  }

  async list(filter: FeedbackFilter): Promise<{ items: FeedbackRecord[]; total: number }> {
    const matched = [...this.records.values()]
      .filter(
        (record) =>
          (!filter.status || record.status === filter.status) &&
          (!filter.kind || record.kind === filter.kind) &&
          (!filter.userId || record.userId === filter.userId)
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      items: matched
        .slice(filter.offset, filter.offset + filter.limit)
        .map((record) => ({ ...record })),
      total: matched.length,
    };
  }

  async countUnread(userId: string): Promise<number> {
    return [...this.records.values()].filter(
      (record) =>
        record.userId === userId &&
        record.lastReplyAt &&
        (!record.userSeenAt || record.userSeenAt < record.lastReplyAt)
    ).length;
  }

  async countByStatus(): Promise<Partial<Record<FeedbackStatus, number>>> {
    const counts: Partial<Record<FeedbackStatus, number>> = {};
    for (const record of this.records.values())
      counts[record.status] = (counts[record.status] ?? 0) + 1;
    return counts;
  }

  async addReply(reply: Omit<FeedbackReplyRecord, "id">): Promise<FeedbackReplyRecord> {
    const row = { ...reply, id: this.replyRows.length + 1 };
    this.replyRows.push(row);
    return { ...row };
  }

  async replies(feedbackId: string): Promise<FeedbackReplyRecord[]> {
    return this.replyRows
      .filter((reply) => reply.feedbackId === feedbackId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((reply) => ({ ...reply }));
  }
}

/** 按主键累加，口径同 Drizzle 实现的 `ON DUPLICATE KEY UPDATE`。 */
export class MemorySiteStatsRepository implements SiteStatsRepository {
  readonly visitors = new Map<string, VisitorDelta>();
  readonly pageRows = new Map<string, PageDelta>();
  readonly userCreatedAt: Date[] = [];
  failNext = false;

  async addVisits(visitors: VisitorDelta[], pages: PageDelta[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("db down");
    }
    for (const row of visitors) {
      const key = `${row.day}:${row.visitorHash}`;
      const current = this.visitors.get(key);
      this.visitors.set(
        key,
        current
          ? { ...current, views: current.views + row.views, userId: row.userId ?? current.userId }
          : { ...row }
      );
    }
    for (const row of pages) {
      const key = `${row.day}:${row.path}`;
      const current = this.pageRows.get(key);
      this.pageRows.set(key, { ...row, views: (current?.views ?? 0) + row.views });
    }
  }

  async purgeVisitors(beforeDay: string, batch: number): Promise<number> {
    const stale = [...this.visitors.keys()]
      .filter((key) => this.visitors.get(key)!.day < beforeDay)
      .slice(0, batch);
    for (const key of stale) this.visitors.delete(key);
    return stale.length;
  }

  async daily(sinceDay: string) {
    const byDay = new Map<
      string,
      { day: string; visitors: number; signedInVisitors: number; views: number }
    >();
    for (const row of this.visitors.values()) {
      if (row.day < sinceDay) continue;
      const entry = byDay.get(row.day) ?? {
        day: row.day,
        visitors: 0,
        signedInVisitors: 0,
        views: 0,
      };
      entry.visitors += 1;
      entry.signedInVisitors += row.userId ? 1 : 0;
      entry.views += row.views;
      byDay.set(row.day, entry);
    }
    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  }

  async pages(sinceDay: string, limit: number) {
    const byPath = new Map<string, number>();
    for (const row of this.pageRows.values())
      if (row.day >= sinceDay) byPath.set(row.path, (byPath.get(row.path) ?? 0) + row.views);
    return [...byPath]
      .map(([path, views]) => ({ path, views }))
      .sort((a, b) => b.views - a.views)
      .slice(0, limit);
  }

  async newUsers(): Promise<Array<{ day: string; count: number }>> {
    return [];
  }
}

/** 假的 NapCat（OneBot 11）：`get_login_info` 返回登录号自身，`get_stranger_info` 按 QQ 号查昵称。 */
export const createNapCatFetcher = () => {
  const state = {
    token: "napcat-test-token",
    /** false 模拟 NapCat 掉线：所有动作返回 failed。 */
    online: true,
    names: new Map<string, string>([
      ["10001", "阿狸"],
      ["20002", "请先"],
    ]),
    /** 每次 `get_stranger_info` 的 QQ 号（一个元素一条调用），批量断言靠它。 */
    calls: [] as string[][],
    loginInfo: { uin: "90001", nickname: "查询号" },
  };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== `Bearer ${state.token}`) {
      return new Response(JSON.stringify({ message: "token verify failed!" }), { status: 401 });
    }
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as { user_id?: number }) : {};
    if (url.pathname.endsWith("/get_login_info")) {
      if (!state.online)
        return new Response(
          JSON.stringify({ status: "failed", retcode: 1400, message: "QQ 未登录" })
        );
      return new Response(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: { user_id: Number(state.loginInfo.uin), nickname: state.loginInfo.nickname },
        })
      );
    }
    if (url.pathname.endsWith("/get_stranger_info")) {
      const uin = String(body.user_id ?? "");
      state.calls.push([uin]);
      const name = state.online ? state.names.get(uin) : undefined;
      if (!name)
        return new Response(
          JSON.stringify({ status: "failed", retcode: 1404, message: "not found" })
        );
      return new Response(
        JSON.stringify({ status: "ok", retcode: 0, data: { user_id: Number(uin), nickname: name } })
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetcher, state };
};

/** 记录发出的验证码，测试据此完成登录。 */
export class CapturedMailer implements Mailer {
  readonly sent: Array<{ to: string; code: string }> = [];
  failNext = false;

  async sendLoginCode(input: { to: string; code: string }): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("smtp down");
    }
    this.sent.push(input);
  }

  lastCodeFor(to: string): string {
    const item = [...this.sent].reverse().find((entry) => entry.to === to);
    if (!item) throw new Error(`没有发给 ${to} 的验证码`);
    return item.code;
  }
}

/** 假的 qlogo：按 QQ 号返回可控字节，记录回源次数。 */
export const createAvatarFetcher = () => {
  const versions = new Map<string, number>();
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const qq = url.searchParams.get("nk") ?? "";
    calls.push(url.toString());
    const version = versions.get(qq) ?? 1;
    return new Response(
      new TextEncoder().encode(`avatar:${qq}:${version}:${url.searchParams.get("s")}`),
      {
        headers: { "content-type": "image/jpeg" },
      }
    );
  }) as typeof fetch;
  return { fetcher, calls, bump: (qq: string) => versions.set(qq, (versions.get(qq) ?? 1) + 1) };
};

export const createAccountTestApp = (
  options: {
    adminQqNumbers?: string[];
    now?: () => number;
    gameRecords?: GameRecordRepository;
    /** 默认只接真实的谁是卧底服务，另两款为空房间桩；各游戏的后台控制口在各自测试里覆盖。 */
    rooms?: Partial<Record<RecordedGame, AdminRoomControl>>;
    sentry?: SentryApiClient;
    /** 运行期旋钮：默认不带库（一律读到环境变量缺省），要测写入的用例自己注入带仓储的实例。 */
    settings?: AppSettings;
    /**
     * 前端来源；默认与后端同主机（`localhost`）。
     *
     * 通行密钥的用例必须改成不同主机：WebAuthn 的 rpID 取自前端域名，
     * 与后端同主机时写错的取值也会「看起来对」。
     */
    clientUrl?: string;
  } = {}
) => {
  const env: AppEnv = {
    clientUrl: options.clientUrl ?? "http://localhost:5173",
    serverUrl: "http://localhost:4850",
    serverListenHost: "127.0.0.1",
    serverPort: 0,
    bangumiApiUrl: "https://api.bgm.tv",
    bangumiImageUrl: "",
  };
  const logger = new EventLogger(() => {});
  const mailer = new CapturedMailer();
  const avatarFetcher = createAvatarFetcher();
  const db: Record<string, unknown[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    passkey: [],
  };
  // 建号钩子要解析 QQ 昵称，而昵称服务在 auth 之后创建：用闭包延迟绑定（与 CreateServer 同法）。
  let resolveNickname: ((qqNumber: string) => Promise<string | null>) | null = null;
  const auth = createAuth({
    database: memoryAdapter(db as Record<string, never[]>),
    secret: ACCOUNT_TEST_SECRET,
    baseURL: env.serverUrl,
    isTrustedOrigin: (origin) => isAllowedOrigin(origin, env.clientUrl),
    secureCookies: false,
    adminQqNumbers: options.adminQqNumbers ?? [],
    passkeyRpId: new URL(env.clientUrl).hostname,
    mailer,
    resolveNickname: (qqNumber) =>
      resolveNickname ? resolveNickname(qqNumber) : Promise.resolve(null),
  });
  const napcat = createNapCatFetcher();
  const nicknames = new QQNicknameService({
    auth,
    client: new QQNapCatClient({
      apiUrl: "https://napcat.test/onebot-internal",
      accessToken: napcat.state.token,
      fetcher: napcat.fetcher,
      minIntervalMs: 0,
    }),
    logger,
    now: options.now,
  });
  resolveNickname = (qqNumber) => nicknames.resolveNickname(qqNumber);
  const service = new AccountService({
    auth,
    mailer,
    avatars: new QQAvatarService(avatarFetcher.fetcher),
    nicknames,
    logger,
    now: options.now,
  });
  const settings = new MemoryUserSettingRepository();
  const feedback = new MemoryFeedbackRepository();
  const sentFeedback: Array<Parameters<FeedbackSink>[0]> = [];
  const sentry = { enabled: true, fail: false };
  const userData = new UserDataService({
    settings,
    feedback,
    cipher: new SettingCipher(ACCOUNT_TEST_SECRET),
    nameOf: (userId) => service.nameOf(userId),
    feedbackSink: (item) => {
      if (sentry.fail) throw new Error("sentry down");
      if (!sentry.enabled) return null;
      sentFeedback.push(item);
      return `event-${sentFeedback.length}`;
    },
    logger,
    now: options.now,
  });
  const audit = new MemoryAuditLogRepository();
  const siteStats = new MemorySiteStatsRepository();
  const antiCheatReviews = new InMemoryAntiCheatReviewQueue();
  const whoIsFakerService = new WhoIsFakerService({ eventLogger: logger });
  const rooms = { faker: whoIsFakerService, song: emptyRooms, cee: emptyRooms, ...options.rooms };
  const admin = new AdminService({
    auth,
    feedback,
    gameRecords: options.gameRecords ?? emptyGameRecords,
    audit,
    reviews: antiCheatReviews,
    rooms,
    siteStats,
    // 夹具默认不带库：后台读到的旋钮一律是环境变量缺省那侧。
    settings: options.settings ?? new AppSettings({ defaults: {} }),
    sentry: options.sentry ?? null,
    qq: nicknames,
    now: options.now,
  });
  const visits = new SiteStatsService({
    repository: siteStats,
    secret: ACCOUNT_TEST_SECRET,
    logger,
    now: options.now,
  });
  const { app } = createTestApp({
    env,
    logger,
    whoIsFakerService,
    account: { auth, service, userData, admin, visits, ready: Promise.resolve() },
  });

  /** `B` 是响应信封里 `json` 的类型：默认按对象写，输出为标量的过程（如 `account.qqName` 直接回昵称）显式传。 */
  const rpc = async <B = Record<string, unknown>>(
    path: string,
    input?: unknown,
    cookie?: string,
    /** 按来源地址计配额的接口靠它分桶（如 `x-real-ip`）；不传时所有调用落在同一个 `unknown` 桶。 */
    headers?: Record<string, string>
  ) => {
    const response = await app.handle(
      new Request(`http://localhost/api/rpc/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: env.clientUrl,
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body: JSON.stringify(input === undefined ? {} : { json: input }),
      })
    );
    const body = (await response.json()) as { json?: unknown };
    return { status: response.status, body: body.json as B };
  };

  /** 让 NapCat 处于在线状态（默认就是在线的，测试用它复位）。 */
  const ensureLookup = async () => {
    napcat.state.online = true;
  };

  /** 让某个 QQ 号可注册：保证 NapCat 在线，并让该号的 QQ 昵称可查到（传入 `name` 时覆盖）。 */
  const prepareSignup = async (qqNumber: string, name?: string) => {
    await ensureLookup();
    if (name !== undefined) napcat.state.names.set(qqNumber, name);
    else if (!napcat.state.names.has(qqNumber)) napcat.state.names.set(qqNumber, `玩家${qqNumber}`);
  };

  /** 完整走一遍「发码 → 填码登录」，返回会话 Cookie；`name` 会作为该 QQ 号查到的昵称，成为账号昵称。 */
  const signIn = async (qqNumber: string, name?: string) => {
    await prepareSignup(qqNumber, name);
    const sent = await rpc("account/requestLoginCode", { qqNumber });
    if (sent.status !== 200) throw new Error(`发码失败: ${JSON.stringify(sent.body)}`);
    const email = `${qqNumber}@qq.com`;
    const response = await app.handle(
      new Request("http://localhost/api/auth/sign-in/email-otp", {
        method: "POST",
        headers: { "content-type": "application/json", origin: env.clientUrl },
        body: JSON.stringify({ email, otp: mailer.lastCodeFor(email) }),
      })
    );
    return { response, cookie: cookieOf(response) };
  };

  return {
    app,
    auth,
    service,
    userData,
    admin,
    audit,
    antiCheatReviews,
    whoIsFakerService,
    visits,
    siteStats,
    settings,
    feedback,
    sentFeedback,
    sentry,
    mailer,
    avatarFetcher,
    napcat,
    nicknames,
    db,
    rpc,
    signIn,
    prepareSignup,
  };
};

const emptyRooms: AdminRoomControl = {
  adminListRooms: () => [],
  adminCloseRoom: async () => {},
  adminKickPlayer: async () => {},
};

const emptyGameRecords: GameRecordRepository = {
  save: async () => {},
  list: async () => ({ items: [], total: 0 }),
  get: async () => null,
  dailyCounts: async () => [],
};

/** 把 Set-Cookie 折叠成请求用的 Cookie 头。 */
export const cookieOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .join("; ");
