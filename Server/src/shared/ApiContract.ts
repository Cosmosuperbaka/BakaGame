import { oc } from "@orpc/contract";
import { z } from "zod";

import {
  ACCOUNT_NAME_MAX_LENGTH,
  FEEDBACK_CONTENT_MAX_LENGTH,
  FEEDBACK_REPLY_MAX_LENGTH,
  FEEDBACK_TITLE_MAX_LENGTH,
  PREFERENCES_MAX_BYTES,
  QQ_NUMBER_PATTERN,
} from "./Account";

/**
 * 账号 HTTP API 契约（oRPC，挂在 `/api/rpc`）。
 *
 * 前后端唯一来源：服务端 `implement(apiContract)`，客户端只取类型推导调用签名，
 * 运行时不打包本文件（`Index.ts` 以 `export type` 导出）。
 * 错误统一为 `ORPCError`，`code` 取服务端 `AppError.code`，`message` 为可直接展示的中文。
 */

const qqNumber = z.string().regex(QQ_NUMBER_PATTERN, "QQ 号格式不正确");
const accountName = z.string().trim().min(1, "请填写账号昵称").max(ACCOUNT_NAME_MAX_LENGTH);

export const accountProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  qqNumber: z.string(),
  /** 站内代理头像地址；首次抓取完成前为空。 */
  image: z.string().nullable(),
  showQq: z.boolean(),
  role: z.enum(["user", "admin"]),
  createdAt: z.string(),
});

/** 别人看到的资料卡：QQ 号仅在本人公开时出现。 */
export const publicProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  qqNumber: z.string().nullable(),
});

const preferences = z.record(z.string().max(64), z.unknown()).refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= PREFERENCES_MAX_BYTES,
  "设置数据过大",
);

export const musicPlatformSchema = z.enum(["netease", "qq"]);

const musicAccountSchema = z.object({
  platform: musicPlatformSchema.optional(),
  userId: z.string().max(64).optional(),
  nickname: z.string().max(128),
  avatarUrl: z.string().max(1024).optional(),
  vipStatus: z.enum(["vip", "nonVip", "unknown"]).optional(),
  vipType: z.number().optional(),
  vipExpireTime: z.number().optional(),
  vipTier: z.enum(["svip", "vip", "musicPackage"]).optional(),
  vipLevel: z.number().optional(),
  vipYear: z.boolean().optional(),
});

/** 云端保存的猜歌音乐账号：cookie 在服务端加密落库，只回给本人。 */
export const musicSessionSchema = z.object({
  cookie: z.string().min(1).max(16 * 1024),
  account: musicAccountSchema,
});

export const cloudSettingsSchema = z.object({
  preferences: z.object({ value: preferences, updatedAt: z.string() }).nullable(),
  music: z.object({
    netease: musicSessionSchema.nullable(),
    qq: musicSessionSchema.nullable(),
  }),
});

export const feedbackKindSchema = z.enum(["suggestion", "bug"]);
export const feedbackStatusSchema = z.enum(["open", "processing", "resolved", "closed"]);

export const feedbackSummarySchema = z.object({
  id: z.string(),
  kind: feedbackKindSchema,
  title: z.string(),
  status: feedbackStatusSchema,
  createdAt: z.string(),
  lastReplyAt: z.string().nullable(),
  /** 有晚于本人上次查看的管理员回复。 */
  unread: z.boolean(),
});

export const feedbackReplySchema = z.object({
  id: z.number().int(),
  content: z.string(),
  createdAt: z.string(),
});

export const feedbackDetailSchema = feedbackSummarySchema.extend({
  content: z.string(),
  page: z.string().nullable(),
  replies: z.array(feedbackReplySchema),
});

// ==================== 管理后台 ====================

const page = {
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(100_000).default(0),
};
const paged = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), total: z.number().int() });
const userId = z.string().min(1).max(64);
export const recordedGameSchema = z.enum(["faker", "song", "ccb"]);
const reason = z.string().trim().max(200);

/** 后台只引用账号时的最小信息；账号已注销时为空。 */
const userRefSchema = z.object({ id: z.string(), name: z.string(), qqNumber: z.string(), image: z.string().nullable() });

export const adminUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  qqNumber: z.string(),
  image: z.string().nullable(),
  role: z.enum(["user", "admin"]),
  banned: z.boolean(),
  banReason: z.string().nullable(),
  banExpires: z.string().nullable(),
  showQq: z.boolean(),
  /** 经查询号获取的 QQ 昵称；未查到为空。 */
  qqName: z.string().nullable(),
  createdAt: z.string(),
});

const gameRecordPlayerSchema = z.object({
  playerId: z.string(), userId: z.string().nullable(), name: z.string(), score: z.number().int(),
});
export const gameRecordItemSchema = z.object({
  id: z.string(),
  game: recordedGameSchema,
  roomId: z.string(),
  roundNumber: z.number().int(),
  startedAt: z.string(),
  endedAt: z.string(),
  players: z.array(gameRecordPlayerSchema),
});
export const adminUserDetailSchema = adminUserSchema.extend({
  recentGames: z.array(gameRecordItemSchema),
  feedbackCount: z.number().int(),
});
export const gameRecordDetailSchema = gameRecordItemSchema.extend({
  summary: z.record(z.string(), z.unknown()),
  timeline: z.array(z.looseObject({ at: z.number(), type: z.string() })),
});

export const adminFeedbackSchema = feedbackSummarySchema.omit({ unread: true }).extend({
  user: userRefSchema.nullable(),
  page: z.string().nullable(),
  sentryEventId: z.string().nullable(),
});
export const adminFeedbackDetailSchema = adminFeedbackSchema.extend({
  content: z.string(),
  userAgent: z.string().nullable(),
  replies: z.array(feedbackReplySchema.extend({ author: userRefSchema.nullable() })),
});

export const adminRoomSchema = z.object({
  game: recordedGameSchema,
  roomId: z.string(),
  name: z.string(),
  phase: z.string(),
  visibility: z.enum(["public", "private"]),
  hasPassword: z.boolean(),
  hidden: z.boolean(),
  roundNumber: z.number(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  players: z.array(z.object({
    id: z.string(),
    name: z.string(),
    online: z.boolean(),
    membership: z.string(),
    host: z.boolean(),
    bot: z.boolean(),
    userId: z.string().nullable(),
  })),
});

const perGame = <T extends z.ZodType>(item: T) => z.object({ faker: item, song: item, ccb: item });

export const adminOverviewSchema = z.object({
  users: z.object({ total: z.number(), admins: z.number(), banned: z.number(), newToday: z.number() }),
  feedback: z.record(feedbackStatusSchema, z.number()),
  live: perGame(z.object({ rooms: z.number(), onlinePlayers: z.number() })),
  /** 按北京时间自然日，升序且不缺日；对局数受记录保留期限制（`gameRecordDays`）。 */
  daily: z.array(z.object({
    day: z.string(),
    visitors: z.number(),
    signedInVisitors: z.number(),
    views: z.number(),
    newUsers: z.number(),
    rounds: perGame(z.number()),
    roundPlayers: z.number(),
  })),
  pages: z.array(z.object({ path: z.string(), views: z.number() })),
  gameRecordDays: z.number(),
});

export const sentryOverviewSchema = z.object({
  /** 服务端未配置 `SENTRY_API_TOKEN` 时为 false，其余字段为空。 */
  configured: z.boolean(),
  /** 近 24 小时错误事件数（前后端项目合计）。 */
  errors24h: z.number().nullable(),
  unresolvedIssues: z.number().nullable(),
  issues: z.array(z.object({
    id: z.string(),
    shortId: z.string(),
    title: z.string(),
    culprit: z.string().nullable(),
    level: z.string(),
    count: z.number(),
    userCount: z.number(),
    lastSeen: z.string(),
    permalink: z.string().nullable(),
    project: z.string().nullable(),
  })),
  /** 近 24 小时调用最多的事务及其耗时分位（毫秒）。 */
  transactions: z.array(z.object({
    name: z.string(),
    project: z.string().nullable(),
    count: z.number(),
    p75: z.number().nullable(),
    p95: z.number().nullable(),
  })).nullable(),
  /** 部分查询失败时的说明，不含凭据。 */
  warnings: z.array(z.string()),
  fetchedAt: z.string().nullable(),
});

/** 后台扫码登录的 QQ 查询号：用它的 QQ 空间登录态查注册用户的 QQ 昵称。 */
export const qqLookupStatusSchema = z.object({
  state: z.enum(["signedOut", "active", "expired"]),
  uin: z.string().nullable(),
  nickname: z.string().nullable(),
  loggedInAt: z.string().nullable(),
  expiredAt: z.string().nullable(),
});

export const qqLoginPollSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("waiting") }),
  z.object({ state: z.literal("scanned") }),
  z.object({ state: z.literal("expired") }),
  z.object({ state: z.literal("failed"), message: z.string() }),
  z.object({ state: z.literal("success"), status: qqLookupStatusSchema }),
]);

export const auditEntrySchema = z.object({
  id: z.number().int(),
  actor: userRefSchema.nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});

const adminContract = {
  users: {
    /** `query` 为纯数字时按 QQ 号前缀匹配，否则按账号昵称包含匹配。 */
    list: oc
      .input(z.object({
        query: z.string().trim().max(64).optional(),
        role: z.enum(["user", "admin"]).optional(),
        banned: z.boolean().optional(),
        ...page,
      }))
      .output(paged(adminUserSchema)),
    get: oc
      .input(z.object({ userId }))
      .output(adminUserDetailSchema),
    /** 封禁同时吊销全部会话；`expiresInHours` 缺省为永久。不能封禁自己或其他管理员。 */
    ban: oc
      .input(z.object({ userId, reason: reason.min(1, "请填写封禁原因"), expiresInHours: z.number().int().min(1).max(24 * 3650).optional() }))
      .output(adminUserSchema),
    unban: oc.input(z.object({ userId })).output(adminUserSchema),
    setRole: oc.input(z.object({ userId, role: z.enum(["user", "admin"]) })).output(adminUserSchema),
    revokeSessions: oc.input(z.object({ userId })).output(z.object({ ok: z.literal(true) })),
    /** 处理违规昵称。 */
    rename: oc.input(z.object({ userId, name: accountName })).output(adminUserSchema),
  },
  feedback: {
    list: oc
      .input(z.object({ status: feedbackStatusSchema.optional(), kind: feedbackKindSchema.optional(), userId: userId.optional(), ...page }))
      .output(paged(adminFeedbackSchema)),
    get: oc.input(z.object({ id: z.string().min(1).max(36) })).output(adminFeedbackDetailSchema),
    /** 回复后用户侧出现未读；待处理的反馈随之转为处理中。 */
    reply: oc
      .input(z.object({ id: z.string().min(1).max(36), content: z.string().trim().min(1, "请填写回复").max(FEEDBACK_REPLY_MAX_LENGTH) }))
      .output(adminFeedbackDetailSchema),
    setStatus: oc
      .input(z.object({ id: z.string().min(1).max(36), status: feedbackStatusSchema }))
      .output(adminFeedbackSchema),
  },
  rooms: {
    /** 实时房间（不分页，进程内全量）；CCB 只含增强房。 */
    list: oc.input(z.object({ game: recordedGameSchema.optional() })).output(z.array(adminRoomSchema)),
    close: oc.input(z.object({ game: recordedGameSchema, roomId: z.string().min(1).max(32) })).output(z.object({ ok: z.literal(true) })),
    kick: oc
      .input(z.object({ game: recordedGameSchema, roomId: z.string().min(1).max(32), playerId: z.string().min(1).max(64) }))
      .output(z.object({ ok: z.literal(true) })),
  },
  games: {
    list: oc
      .input(z.object({ game: recordedGameSchema.optional(), roomId: z.string().max(32).optional(), userId: userId.optional(), ...page }))
      .output(paged(gameRecordItemSchema)),
    get: oc.input(z.object({ id: z.string().min(1).max(36) })).output(gameRecordDetailSchema),
  },
  audit: {
    list: oc
      .input(z.object({
        actorId: userId.optional(),
        action: z.string().max(64).optional(),
        targetType: z.string().max(32).optional(),
        targetId: z.string().max(128).optional(),
        ...page,
      }))
      .output(paged(auditEntrySchema)),
  },
  qq: {
    status: oc.output(qqLookupStatusSchema),
    /** 申请扫码二维码（PNG data URL）；`loginId` 用于之后轮询。 */
    startLogin: oc.output(z.object({ loginId: z.string(), image: z.string() })),
    /** 前端每 2 秒轮询一次，直到成功、失效或失败。成功即替换原查询号。 */
    pollLogin: oc.input(z.object({ loginId: z.string().uuid() })).output(qqLoginPollSchema),
    logout: oc.output(z.object({ ok: z.literal(true) })),
    /** 刷新最久未查的一批账号的 QQ 昵称（单次最多 200 个）。 */
    refreshNames: oc.output(z.object({ checked: z.number().int(), updated: z.number().int(), remaining: z.number().int() })),
  },
  stats: {
    overview: oc.input(z.object({ days: z.number().int().min(1).max(90).default(14) })).output(adminOverviewSchema),
    /** 服务端以只读令牌代查 Sentry，结果缓存 60 秒；令牌不出服务端。 */
    sentry: oc.output(sentryOverviewSchema),
  },
};

export const apiContract = {
  site: {
    /** 前端每次载入页面报一次；`visitorId` 是浏览器本地随机值，路径只按板块统计。 */
    visit: oc
      .input(z.object({ visitorId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), path: z.string().max(512) }))
      .output(z.object({ ok: z.literal(true) })),
  },
  account: {
    /** 发送登录验证码；`registered` 决定前端是否要求填写昵称，新号附带查到的 QQ 昵称供预填（查不到为空）。 */
    requestLoginCode: oc
      .input(z.object({ qqNumber }))
      .output(z.object({ registered: z.boolean(), resendAfterSeconds: z.number().int(), qqName: z.string().nullable() })),
    /** 当前登录资料；未登录返回 `null`。顺带按节流刷新 QQ 头像（每次访问调用一次即可）。 */
    me: oc.output(accountProfileSchema.nullable()),
    updateProfile: oc
      .input(z.object({ name: accountName.optional(), showQq: z.boolean().optional() }))
      .output(accountProfileSchema),
    publicProfile: oc
      .input(z.object({ userId: z.string().min(1).max(64) }))
      .output(publicProfileSchema),
  },
  settings: {
    get: oc.output(cloudSettingsSchema),
    /** 整体覆盖偏好文档，返回服务端记录的更新时间。 */
    savePreferences: oc
      .input(z.object({ value: preferences }))
      .output(z.object({ updatedAt: z.string() })),
    /** `session` 为空表示退出该平台账号并删除云端副本。 */
    saveMusicSession: oc
      .input(z.object({ platform: musicPlatformSchema, session: musicSessionSchema.nullable() }))
      .output(z.object({ updatedAt: z.string() })),
  },
  feedback: {
    create: oc
      .input(z.object({
        kind: feedbackKindSchema,
        title: z.string().trim().min(1, "请填写标题").max(FEEDBACK_TITLE_MAX_LENGTH),
        content: z.string().trim().min(1, "请填写内容").max(FEEDBACK_CONTENT_MAX_LENGTH),
        page: z.string().max(255).optional(),
      }))
      .output(feedbackSummarySchema),
    listMine: oc
      .output(z.object({ items: z.array(feedbackSummarySchema), unread: z.number().int() })),
    /** 读取详情并标记已读。 */
    get: oc
      .input(z.object({ id: z.string().min(1).max(36) }))
      .output(feedbackDetailSchema),
  },
  /** 仅管理员；每次调用按 ID 读库校验角色与封禁状态。 */
  admin: adminContract,
};

export type ApiContract = typeof apiContract;
export type AccountProfile = z.infer<typeof accountProfileSchema>;
export type PublicProfile = z.infer<typeof publicProfileSchema>;
export type CloudSettings = z.infer<typeof cloudSettingsSchema>;
export type CloudMusicSession = z.infer<typeof musicSessionSchema>;
export type MusicPlatform = z.infer<typeof musicPlatformSchema>;
export type FeedbackSummary = z.infer<typeof feedbackSummarySchema>;
export type FeedbackDetail = z.infer<typeof feedbackDetailSchema>;
export type FeedbackKind = z.infer<typeof feedbackKindSchema>;
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;
export type RecordedGameKind = z.infer<typeof recordedGameSchema>;
export type AdminUser = z.infer<typeof adminUserSchema>;
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>;
export type GameRecordItem = z.infer<typeof gameRecordItemSchema>;
export type GameRecordDetail = z.infer<typeof gameRecordDetailSchema>;
export type AdminFeedback = z.infer<typeof adminFeedbackSchema>;
export type AdminFeedbackDetail = z.infer<typeof adminFeedbackDetailSchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type AdminRoom = z.infer<typeof adminRoomSchema>;
export type AdminOverview = z.infer<typeof adminOverviewSchema>;
export type SentryOverview = z.infer<typeof sentryOverviewSchema>;
export type QQLookupStatus = z.infer<typeof qqLookupStatusSchema>;
export type QQLoginPollResult = z.infer<typeof qqLoginPollSchema>;

