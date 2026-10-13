import { memoryAdapter } from "better-auth/adapters/memory";

import { AccountService } from "../src/application/AccountService";
import { AdminService } from "../src/application/AdminService";
import { QQNicknameService } from "../src/application/QQNicknameService";
import { QQWebLoginClient, gtkOf, ptqrToken } from "../src/infrastructure/auth/QQWebLogin";
import type { SiteConfigRepository } from "../src/infrastructure/db/SiteConfigRepository";
import { SiteStatsService } from "../src/application/SiteStatsService";
import type { SentryApiClient } from "../src/infrastructure/SentryApi";
import type { PageDelta, SiteStatsRepository, VisitorDelta } from "../src/infrastructure/db/SiteStatsRepository";
import type { AdminRoomControl } from "../src/domain/AdminRoom";
import type { RecordedGame } from "../src/domain/GameRecord";
import { UserDataService, type FeedbackSink } from "../src/application/UserDataService";
import { WhoIsFakerService } from "../src/application/WhoIsFakerService";
import type { AppEnv } from "../src/config/Env";
import { createAuth } from "../src/infrastructure/auth/Auth";
import type { Mailer } from "../src/infrastructure/auth/Mailer";
import { QQAvatarService } from "../src/infrastructure/auth/QQAvatar";
import { SettingCipher } from "../src/infrastructure/auth/SettingCipher";
import type { AuditEntry, AuditFilter, AuditLogRepository, StoredAuditEntry } from "../src/infrastructure/db/AuditLogRepository";
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
    return [...this.rows.values()].filter((row) => row.userId === userId)
      .map(({ key, value, updatedAt }) => ({ key, value: structuredClone(value), updatedAt }));
  }

  async put(userId: string, key: string, value: unknown, now: Date): Promise<void> {
    this.rows.set(`${userId}:${key}`, { userId, key, value: structuredClone(value), updatedAt: now });
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
      .filter((entry) => (!filter.actorId || entry.actorId === filter.actorId)
        && (!filter.action || entry.action === filter.action)
        && (!filter.targetType || entry.targetType === filter.targetType)
        && (!filter.targetId || entry.targetId === filter.targetId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
    return { items: matched.slice(filter.offset, filter.offset + filter.limit), total: matched.length };
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
      .filter((record) => (!filter.status || record.status === filter.status)
        && (!filter.kind || record.kind === filter.kind)
        && (!filter.userId || record.userId === filter.userId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return { items: matched.slice(filter.offset, filter.offset + filter.limit).map((record) => ({ ...record })), total: matched.length };
  }

  async countUnread(userId: string): Promise<number> {
    return [...this.records.values()].filter((record) => record.userId === userId && record.lastReplyAt
      && (!record.userSeenAt || record.userSeenAt < record.lastReplyAt)).length;
  }

  async countByStatus(): Promise<Partial<Record<FeedbackStatus, number>>> {
    const counts: Partial<Record<FeedbackStatus, number>> = {};
    for (const record of this.records.values()) counts[record.status] = (counts[record.status] ?? 0) + 1;
    return counts;
  }

  async addReply(reply: Omit<FeedbackReplyRecord, "id">): Promise<FeedbackReplyRecord> {
    const row = { ...reply, id: this.replyRows.length + 1 };
    this.replyRows.push(row);
    return { ...row };
  }

  async replies(feedbackId: string): Promise<FeedbackReplyRecord[]> {
    return this.replyRows.filter((reply) => reply.feedbackId === feedbackId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((reply) => ({ ...reply }));
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
      this.visitors.set(key, current
        ? { ...current, views: current.views + row.views, userId: row.userId ?? current.userId }
        : { ...row });
    }
    for (const row of pages) {
      const key = `${row.day}:${row.path}`;
      const current = this.pageRows.get(key);
      this.pageRows.set(key, { ...row, views: (current?.views ?? 0) + row.views });
    }
  }

  async purgeVisitors(beforeDay: string, batch: number): Promise<number> {
    const stale = [...this.visitors.keys()].filter((key) => this.visitors.get(key)!.day < beforeDay).slice(0, batch);
    for (const key of stale) this.visitors.delete(key);
    return stale.length;
  }

  async daily(sinceDay: string) {
    const byDay = new Map<string, { day: string; visitors: number; signedInVisitors: number; views: number }>();
    for (const row of this.visitors.values()) {
      if (row.day < sinceDay) continue;
      const entry = byDay.get(row.day) ?? { day: row.day, visitors: 0, signedInVisitors: 0, views: 0 };
      entry.visitors += 1;
      entry.signedInVisitors += row.userId ? 1 : 0;
      entry.views += row.views;
      byDay.set(row.day, entry);
    }
    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  }

  async pages(sinceDay: string, limit: number) {
    const byPath = new Map<string, number>();
    for (const row of this.pageRows.values()) if (row.day >= sinceDay) byPath.set(row.path, (byPath.get(row.path) ?? 0) + row.views);
    return [...byPath].map(([path, views]) => ({ path, views })).sort((a, b) => b.views - a.views).slice(0, limit);
  }

  async newUsers(): Promise<Array<{ day: string; count: number }>> {
    return [];
  }
}

export class MemorySiteConfigRepository implements SiteConfigRepository {
  readonly rows = new Map<string, unknown>();

  async get(key: string): Promise<unknown | null> {
    return this.rows.has(key) ? structuredClone(this.rows.get(key)) : null;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.rows.set(key, structuredClone(value));
  }

  async remove(key: string): Promise<void> {
    this.rows.delete(key);
  }
}

/** 由字符串与原始字节片段拼出响应体（昵称接口是 GBK 编码，测试里直接写字节）。 */
const bytesOf = (...parts: Array<string | number[]>) =>
  new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...new TextEncoder().encode(part)] : part)));

/**
 * 假的 QQ 网页登录：二维码、轮询、check_sig 跳转与 QQ 空间昵称接口。
 * `login` 控制轮询返回码，`expired` 让昵称接口报登录失效，`names` 是可查到的昵称（值为原始响应片段）。
 */
export const createQQWebFetcher = () => {
  const state = {
    login: "66" as "66" | "67" | "65" | "0" | "10006",
    expired: false,
    names: new Map<string, string | number[]>([
      ["10001", "&#38463;&#29432;"],
      ["20002", [0xc7, 0xeb, 0xcf, 0xc8]],
    ]),
    portraitCalls: [] as string[][],
  };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    if (url.pathname === "/ptqrshow") {
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "set-cookie": "qrsig=SIG-1; Path=/" } });
    }
    if (url.pathname === "/ptqrlogin") {
      if (!cookie.includes("qrsig=SIG-1") || url.searchParams.get("ptqrtoken") !== String(ptqrToken("SIG-1"))) return new Response("ptuiCB('65','0','','0','二维码已失效。', '')");
      if (state.login !== "0") return new Response(`ptuiCB('${state.login}','0','','0','提示', '')`);
      const headers = new Headers();
      headers.append("set-cookie", "uin=o0012345; Path=/; Domain=qq.com");
      headers.append("set-cookie", "skey=@SKEY; Path=/; Domain=qq.com");
      return new Response("ptuiCB('0','0','https://ptlogin2.qzone.qq.com/check_sig?uin=12345&ptsigx=x','0','登录成功！', '查询号')", { headers });
    }
    if (url.pathname === "/check_sig") {
      const headers = new Headers({ location: "https://qzs.qq.com/qzone/v5/loginsucc.html?para=izone" });
      headers.append("set-cookie", "p_skey=PSKEY; Path=/; Domain=qzone.qq.com");
      headers.append("set-cookie", "p_uin=o0012345; Path=/; Domain=qzone.qq.com");
      return new Response(null, { status: 302, headers });
    }
    if (url.pathname === "/fcg-bin/cgi_get_portrait.fcg") {
      const uins = (url.searchParams.get("uins") ?? "").split(",");
      state.portraitCalls.push(uins);
      const authorized = cookie.includes("p_skey=PSKEY") && url.searchParams.get("g_tk") === String(gtkOf("PSKEY"));
      if (state.expired || !authorized) return new Response(bytesOf("_Callback({\"error\":{\"type\":\"need login\",\"msg\":\"\"}});"));
      const parts: Array<string | number[]> = ["portraitCallBack({"];
      uins.filter((uin) => state.names.has(uin)).forEach((uin, index) => {
        parts.push(`${index ? "," : ""}"${uin}":["http://qlogo",0,-1,0,0,0,"`, state.names.get(uin)!, "\",0]");
      });
      parts.push("})");
      return new Response(bytesOf(...parts));
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
    return new Response(new TextEncoder().encode(`avatar:${qq}:${version}:${url.searchParams.get("s")}`), {
      headers: { "content-type": "image/jpeg" },
    });
  }) as typeof fetch;
  return { fetcher, calls, bump: (qq: string) => versions.set(qq, (versions.get(qq) ?? 1) + 1) };
};

export const createAccountTestApp = (options: {
  adminQqNumbers?: string[];
  now?: () => number;
  gameRecords?: GameRecordRepository;
  /** 默认只接真实的谁是卧底服务，另两款为空房间桩；各游戏的后台控制口在各自测试里覆盖。 */
  rooms?: Partial<Record<RecordedGame, AdminRoomControl>>;
  sentry?: SentryApiClient;
} = {}) => {
  const env: AppEnv = {
    clientUrl: "http://localhost:5173",
    serverUrl: "http://localhost:4850",
    serverListenHost: "127.0.0.1",
    serverPort: 0,
    bangumiApiUrl: "https://api.bgm.tv",
    bangumiImageUrl: "",
  };
  const logger = new EventLogger(() => {});
  const mailer = new CapturedMailer();
  const avatarFetcher = createAvatarFetcher();
  const db: Record<string, unknown[]> = { user: [], session: [], account: [], verification: [] };
  // 建号钩子要解析 QQ 昵称，而昵称服务在 auth 之后创建：用闭包延迟绑定（与 CreateServer 同法）。
  let resolveNickname: ((qqNumber: string) => Promise<string | null>) | null = null;
  const auth = createAuth({
    database: memoryAdapter(db as Record<string, never[]>),
    secret: ACCOUNT_TEST_SECRET,
    baseURL: env.serverUrl,
    isTrustedOrigin: (origin) => isAllowedOrigin(origin, env.clientUrl),
    secureCookies: false,
    adminQqNumbers: options.adminQqNumbers ?? [],
    mailer,
    resolveNickname: (qqNumber) => resolveNickname ? resolveNickname(qqNumber) : Promise.resolve(null),
  });
  const qqWeb = createQQWebFetcher();
  const siteConfig = new MemorySiteConfigRepository();
  const nicknames = new QQNicknameService({
    auth,
    client: new QQWebLoginClient(qqWeb.fetcher),
    config: siteConfig,
    cipher: new SettingCipher(ACCOUNT_TEST_SECRET),
    logger,
    now: options.now,
    batchDelayMs: 0,
  });
  resolveNickname = (qqNumber) => nicknames.resolveNickname(qqNumber);
  const service = new AccountService({ auth, mailer, avatars: new QQAvatarService(avatarFetcher.fetcher), nicknames, logger, now: options.now });
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
  const whoIsFakerService = new WhoIsFakerService({ eventLogger: logger });
  const rooms = { faker: whoIsFakerService, song: emptyRooms, ccb: emptyRooms, ...options.rooms };
  const admin = new AdminService({
    auth,
    feedback,
    gameRecords: options.gameRecords ?? emptyGameRecords,
    audit,
    rooms,
    siteStats,
    sentry: options.sentry ?? null,
    qq: nicknames,
    now: options.now,
  });
  const visits = new SiteStatsService({ repository: siteStats, secret: ACCOUNT_TEST_SECRET, logger, now: options.now });
  const { app } = createTestApp({
    env,
    logger,
    whoIsFakerService,
    account: { auth, service, userData, admin, visits, ready: Promise.resolve() },
  });

  const rpc = async (path: string, input?: unknown, cookie?: string) => {
    const response = await app.handle(new Request(`http://localhost/api/rpc/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: env.clientUrl, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    }));
    const body = await response.json() as { json?: unknown };
    return { status: response.status, body: body.json as Record<string, unknown> };
  };

  /** 查询号已登录则直接返回；未登录或已失效时静默走一遍扫码流程（不经管理接口，不产生审计）。 */
  const ensureLookup = async () => {
    const status = await nicknames.status();
    if (status.state === "active") return;
    qqWeb.state.login = "0";
    const { loginId } = await nicknames.startLogin();
    await nicknames.pollLogin(loginId, async () => {});
  };

  /** 假昵称接口的响应按 GBK 解码：直接塞 UTF-8 中文会变成乱码，统一转成 HTML 实体（纯 ASCII）。 */
  const entityEncode = (name: string) =>
    [...name].map((char) => (char.codePointAt(0)! < 0x80 ? char : `&#${char.codePointAt(0)};`)).join("");

  /** 让某个 QQ 号可注册：保证查询号在线，并让该号的 QQ 昵称可查到（传入 `name` 时覆盖）。 */
  const prepareSignup = async (qqNumber: string, name?: string) => {
    await ensureLookup();
    if (name !== undefined) qqWeb.state.names.set(qqNumber, entityEncode(name));
    else if (!qqWeb.state.names.has(qqNumber)) qqWeb.state.names.set(qqNumber, entityEncode(`玩家${qqNumber}`));
  };

  /** 完整走一遍「发码 → 填码登录」，返回会话 Cookie；`name` 会作为该 QQ 号查到的昵称，成为账号昵称。 */
  const signIn = async (qqNumber: string, name?: string) => {
    await prepareSignup(qqNumber, name);
    const sent = await rpc("account/requestLoginCode", { qqNumber });
    if (sent.status !== 200) throw new Error(`发码失败: ${JSON.stringify(sent.body)}`);
    const email = `${qqNumber}@qq.com`;
    const response = await app.handle(new Request("http://localhost/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: env.clientUrl },
      body: JSON.stringify({ email, otp: mailer.lastCodeFor(email) }),
    }));
    return { response, cookie: cookieOf(response) };
  };

  return { app, auth, service, userData, admin, audit, whoIsFakerService, visits, siteStats, settings, feedback, sentFeedback, sentry, mailer, avatarFetcher, qqWeb, siteConfig, nicknames, db, rpc, signIn, prepareSignup };
};

const emptyRooms: AdminRoomControl = {
  adminListRooms: () => [],
  adminCloseRoom: async () => {},
  adminKickPlayer: async () => {},
};

const emptyGameRecords: GameRecordRepository = {
  insert: async () => {},
  purge: async () => 0,
  list: async () => ({ items: [], total: 0 }),
  get: async () => null,
  dailyCounts: async () => [],
};

/** 把 Set-Cookie 折叠成请求用的 Cookie 头。 */
export const cookieOf = (response: Response): string =>
  response.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
