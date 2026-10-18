import { randomUUID } from "node:crypto";

import { AppError } from "../domain/Errors";
import type { EventLogger } from "../infrastructure/EventLogger";
import { SlidingWindowRateLimiter } from "../infrastructure/RateLimiter";
import type { SettingCipher } from "../infrastructure/auth/SettingCipher";
import type {
  FeedbackRecord,
  FeedbackReplyRecord,
  FeedbackRepository,
  UserSettingRepository,
} from "../infrastructure/db/UserDataRepository";
import {
  musicSessionSchema,
  type CloudMusicSession,
  type CloudSettings,
  type FeedbackDetail,
  type FeedbackKind,
  type FeedbackSummary,
  type MusicPlatform,
} from "../shared/ApiContract";

/** 设置键：偏好为明文 JSON；音乐账号含 cookie，整体加密后以字符串落库。 */
const PREFERENCES_KEY = "preferences";
const MUSIC_KEYS: Record<MusicPlatform, string> = { netease: "music.netease", qq: "music.qq" };

const FEEDBACK_KIND_LABEL: Record<FeedbackKind, string> = { suggestion: "建议", bug: "Bug" };
const FEEDBACK_PAGE_SIZE = 50;

export interface FeedbackSink {
  /** 同步到 Sentry User Feedback，返回事件 ID；未启用时返回 `null`。 */
  (feedback: {
    message: string;
    name: string;
    userId: string;
    url?: string;
    tags: Record<string, string>;
  }): string | null;
}

export interface UserDataServiceOptions {
  settings: UserSettingRepository;
  feedback: FeedbackRepository;
  cipher: SettingCipher;
  /** 读取账号当前昵称，账号不存在返回 `null`。 */
  nameOf(userId: string): Promise<string | null>;
  feedbackSink: FeedbackSink;
  logger: EventLogger;
  now?: () => number;
}

/** 登录用户的云端数据：设置同步与站内反馈。 */
export class UserDataService {
  private readonly now: () => number;
  /** 每人每小时最多 5 条反馈，防止刷屏与 Sentry 配额被打满。 */
  private readonly feedbackLimiter = new SlidingWindowRateLimiter({
    windowMs: 60 * 60 * 1000,
    maxRequests: 5,
  });

  constructor(private readonly options: UserDataServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  // ==================== 设置同步 ====================

  async settings(userId: string): Promise<CloudSettings> {
    const rows = new Map((await this.options.settings.list(userId)).map((row) => [row.key, row]));
    const preferences = rows.get(PREFERENCES_KEY);
    return {
      preferences: preferences
        ? {
            value: preferences.value as Record<string, unknown>,
            updatedAt: preferences.updatedAt.toISOString(),
          }
        : null,
      music: {
        netease: this.readMusic(userId, "netease", rows.get(MUSIC_KEYS.netease)?.value),
        qq: this.readMusic(userId, "qq", rows.get(MUSIC_KEYS.qq)?.value),
      },
    };
  }

  async savePreferences(
    userId: string,
    value: Record<string, unknown>
  ): Promise<{ updatedAt: string }> {
    const now = new Date(this.now());
    await this.options.settings.put(userId, PREFERENCES_KEY, value, now);
    return { updatedAt: now.toISOString() };
  }

  async saveMusicSession(
    userId: string,
    platform: MusicPlatform,
    session: CloudMusicSession | null
  ): Promise<{ updatedAt: string }> {
    const now = new Date(this.now());
    const key = MUSIC_KEYS[platform];
    if (session) {
      await this.options.settings.put(
        userId,
        key,
        this.options.cipher.encrypt(JSON.stringify(session), userId, key),
        now
      );
    } else {
      await this.options.settings.remove(userId, key);
    }
    return { updatedAt: now.toISOString() };
  }

  private readMusic(
    userId: string,
    platform: MusicPlatform,
    stored: unknown
  ): CloudMusicSession | null {
    if (stored === undefined) return null;
    const key = MUSIC_KEYS[platform];
    const plaintext =
      typeof stored === "string" ? this.options.cipher.decrypt(stored, userId, key) : null;
    const parsed = plaintext ? musicSessionSchema.safeParse(safeJson(plaintext)) : null;
    if (parsed?.success) return parsed.data;
    // 密钥轮换后旧密文无法解开：按云端无数据处理，用户重新登录音乐账号即覆盖。
    this.options.logger.warn("云端音乐账号无法解密，已忽略", { userId, platform });
    return null;
  }

  // ==================== 反馈 ====================

  async createFeedback(
    userId: string,
    input: {
      kind: FeedbackKind;
      title: string;
      content: string;
      page?: string;
      userAgent?: string | null;
    }
  ): Promise<FeedbackSummary> {
    if (!this.feedbackLimiter.allow(userId, this.now())) {
      throw new AppError("RATE_LIMITED", "反馈提交过于频繁，请稍后再试");
    }
    const name = await this.options.nameOf(userId);
    if (!name) throw new AppError("UNAUTHORIZED", "请先登录");
    const now = new Date(this.now());
    const record: FeedbackRecord = {
      id: randomUUID(),
      userId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      status: "open",
      page: input.page ?? null,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      sentryEventId: null,
      lastReplyAt: null,
      userSeenAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.options.feedback.create(record);
    try {
      const eventId = this.options.feedbackSink({
        message: `【${FEEDBACK_KIND_LABEL[record.kind]}】${record.title}\n\n${record.content}`,
        name,
        userId,
        ...(record.page ? { url: record.page } : {}),
        tags: { "feedback.kind": record.kind, "feedback.id": record.id },
      });
      if (eventId) {
        record.sentryEventId = eventId;
        await this.options.feedback.update(record.id, { sentryEventId: eventId });
      }
    } catch (error) {
      // 站内反馈已落库，Sentry 同步失败只记日志。
      this.options.logger.warn("反馈同步 Sentry 失败", {
        feedbackId: record.id,
        error: String(error),
      });
    }
    return toSummary(record);
  }

  async listMyFeedback(userId: string): Promise<{ items: FeedbackSummary[]; unread: number }> {
    const [{ items }, unread] = await Promise.all([
      this.options.feedback.list({ userId, limit: FEEDBACK_PAGE_SIZE, offset: 0 }),
      this.options.feedback.countUnread(userId),
    ]);
    return { items: items.map(toSummary), unread };
  }

  async myFeedback(userId: string, id: string): Promise<FeedbackDetail> {
    const record = await this.options.feedback.get(id);
    if (!record || record.userId !== userId) throw new AppError("NOT_FOUND", "反馈不存在");
    const replies = await this.options.feedback.replies(id);
    if (isUnread(record)) {
      record.userSeenAt = new Date(this.now());
      await this.options.feedback.update(id, { userSeenAt: record.userSeenAt });
    }
    return toDetail(record, replies);
  }
}

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const isUnread = (record: FeedbackRecord): boolean =>
  record.lastReplyAt !== null &&
  (record.userSeenAt === null || record.userSeenAt < record.lastReplyAt);

export const toSummary = (record: FeedbackRecord): FeedbackSummary => ({
  id: record.id,
  kind: record.kind,
  title: record.title,
  status: record.status,
  createdAt: record.createdAt.toISOString(),
  lastReplyAt: record.lastReplyAt?.toISOString() ?? null,
  unread: isUnread(record),
});

export const toDetail = (
  record: FeedbackRecord,
  replies: FeedbackReplyRecord[]
): FeedbackDetail => ({
  ...toSummary(record),
  content: record.content,
  page: record.page,
  replies: replies.map((reply) => ({
    id: reply.id,
    content: reply.content,
    createdAt: reply.createdAt.toISOString(),
  })),
});
