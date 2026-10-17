import { oc } from "@orpc/contract";
import { z } from "zod";

import {
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
export const recordedGameSchema = z.enum(["faker", "song", "cee"]);
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
  /** 一局（一个房间从创建到销毁）内的回合数。 */
  roundCount: z.number().int(),
  startedAt: z.string(),
  endedAt: z.string(),
  /** 本局累计总分。 */
  players: z.array(gameRecordPlayerSchema),
});
const gameRecordRoundSchema = z.object({
  number: z.number().int(),
  startedAt: z.string(),
  endedAt: z.string(),
  /** 本回合得分增量。 */
  players: z.array(gameRecordPlayerSchema),
  summary: z.record(z.string(), z.unknown()),
});
export const adminUserDetailSchema = adminUserSchema.extend({
  recentGames: z.array(gameRecordItemSchema),
  feedbackCount: z.number().int(),
});
export const gameRecordDetailSchema = gameRecordItemSchema.extend({
  rounds: z.array(gameRecordRoundSchema),
  /** 全房合并时间线，事件带 `round` 回合号。 */
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

const perGame = <T extends z.ZodType>(item: T) => z.object({ faker: item, song: item, cee: item });

export const adminOverviewSchema = z.object({
  users: z.object({ total: z.number(), admins: z.number(), banned: z.number(), newToday: z.number() }),
  feedback: z.record(feedbackStatusSchema, z.number()),
  live: perGame(z.object({ rooms: z.number(), onlinePlayers: z.number() })),
  /** 按北京时间自然日，升序且不缺日；对局记录永久保留。 */
  daily: z.array(z.object({
    day: z.string(),
    visitors: z.number(),
    signedInVisitors: z.number(),
    views: z.number(),
    newUsers: z.number(),
    /** 一局数：一个房间从创建到销毁算一局。 */
    games: perGame(z.number()),
    /** 参与人次：每局按去重玩家数累加。 */
    roundPlayers: z.number(),
  })),
  pages: z.array(z.object({ path: z.string(), views: z.number() })),
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

/** QQ 昵称来源（NapCat / OneBot 11）的可用状态；查询号由 NapCat 自己维护，站点不再持有登录态。 */
export const qqLookupStatusSchema = z.object({
  state: z.enum(["active", "unavailable"]),
  /** NapCat 当前登录的 QQ 号与昵称；不可用时为空。 */
  uin: z.string().nullable(),
  nickname: z.string().nullable(),
  checkedAt: z.string().nullable(),
  /** 不可用原因（固定文案，不含内网地址与令牌）。 */
  error: z.string().nullable(),
});

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
    /** 实时房间（不分页，进程内全量）；CEE 只含增强房。 */
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
    /** 探测 NapCat 是否在线并已登录 QQ（结果在服务端缓存 15 秒）。 */
    status: oc.output(qqLookupStatusSchema),
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
    /**
     * 发送登录验证码。新号发码前必须取到 QQ 昵称（用作账号昵称）：查询不可用时拒绝，即停用注册；
     * `qqName` 是新号注册后将使用的账号昵称，老号为 null。
     */
    requestLoginCode: oc
      .input(z.object({ qqNumber }))
      .output(z.object({ registered: z.boolean(), resendAfterSeconds: z.number().int(), qqName: z.string().nullable() })),
    /** 当前登录资料；未登录返回 `null`。顺带按节流刷新 QQ 头像（每次访问调用一次即可）。 */
    me: oc.output(accountProfileSchema.nullable()),
    /** 账号昵称强制取自 QQ 昵称、不可修改；此处只允许切换 QQ 号公开开关。 */
    updateProfile: oc
      .input(z.object({ showQq: z.boolean().optional() }))
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

