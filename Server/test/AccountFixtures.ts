import { memoryAdapter } from "better-auth/adapters/memory";

import { AccountService } from "../src/application/AccountService";
import { AdminService } from "../src/application/AdminService";
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
  const auth = createAuth({
    database: memoryAdapter(db as Record<string, never[]>),
    secret: ACCOUNT_TEST_SECRET,
    baseURL: env.serverUrl,
    isTrustedOrigin: (origin) => isAllowedOrigin(origin, env.clientUrl),
    secureCookies: false,
    adminQqNumbers: options.adminQqNumbers ?? [],
    mailer,
  });
  const service = new AccountService({ auth, mailer, avatars: new QQAvatarService(avatarFetcher.fetcher), logger, now: options.now });
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
  const admin = new AdminService({
    auth,
    feedback,
    gameRecords: options.gameRecords ?? emptyGameRecords,
    audit,
    now: options.now,
  });
  const { app } = createTestApp({
    env,
    logger,
    whoIsFakerService: new WhoIsFakerService({ eventLogger: logger }),
    account: { auth, service, userData, admin, ready: Promise.resolve() },
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

  /** 完整走一遍「发码 → 填码登录」，返回会话 Cookie。 */
  const signIn = async (qqNumber: string, name?: string) => {
    const sent = await rpc("account/requestLoginCode", { qqNumber });
    if (sent.status !== 200) throw new Error(`发码失败: ${JSON.stringify(sent.body)}`);
    const email = `${qqNumber}@qq.com`;
    const response = await app.handle(new Request("http://localhost/api/auth/sign-in/email-otp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: env.clientUrl },
      body: JSON.stringify({ email, otp: mailer.lastCodeFor(email), ...(name ? { name } : {}) }),
    }));
    return { response, cookie: cookieOf(response) };
  };

  return { app, auth, service, userData, admin, audit, settings, feedback, sentFeedback, sentry, mailer, avatarFetcher, db, rpc, signIn };
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
