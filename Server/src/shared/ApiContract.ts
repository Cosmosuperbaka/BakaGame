import { oc } from "@orpc/contract";
import { z } from "zod";

import {
  FEEDBACK_CONTENT_MAX_LENGTH,
  FEEDBACK_REPLY_MAX_LENGTH,
  FEEDBACK_TITLE_MAX_LENGTH,
  PREFERENCES_MAX_BYTES,
  QQ_NUMBER_PATTERN,
} from "./Account";
import { adminRuntimeSettingSchema, runtimeSettingKeySchema } from "./RuntimeSettings";

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

const preferences = z
  .record(z.string().max(64), z.unknown())
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= PREFERENCES_MAX_BYTES,
    "设置数据过大"
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
  cookie: z
    .string()
    .min(1)
    .max(16 * 1024),
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
const paged = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int() });
const userId = z.string().min(1).max(64);
export const recordedGameSchema = z.enum(["faker", "song", "cee"]);
const reason = z.string().trim().max(200);

/** 后台只引用账号时的最小信息；账号已注销时为空。 */
const userRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  qqNumber: z.string(),
  image: z.string().nullable(),
});

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
  playerId: z.string(),
  userId: z.string().nullable(),
  name: z.string(),
  score: z.number().int(),
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

/** 复核条目状态：只有人能在后台改，代码路径永不写除 `open` 以外的值。 */
export const antiCheatReviewStatusSchema = z.enum(["open", "cleared", "actioned"]);

/** 触发这条复核的服务端可观测特征原值，后台直接摊开给人对照，不做二次加工。 */
const reviewFeaturesSchema = z.object({
  intervals: z.array(z.number()),
  cv: z.number().nullable(),
  noSearchGuesses: z.number().int(),
  unmatchedSearches: z.number().int(),
  guesses: z.number().int(),
  firstGuessCorrect: z.boolean(),
});

/**
 * 反作弊人工复核队列的一条候选：「值得人看一眼」，不是结论。
 * 只由服务端可观测特征写入，没有任何自动处罚，处置全部发生在这里由人判定。
 */
export const adminAntiCheatReviewSchema = z.object({
  id: z.string(),
  roomId: z.string(),
  roundNumber: z.number().int(),
  playerName: z.string(),
  /** 条目按账号补充资料；游客参与或账号已注销时为空。 */
  player: userRefSchema.nullable(),
  clientType: z.enum(["web", "desktop", "mobile"]),
  score: z.number().int(),
  /** 中文短句，说明是哪几条特征把它抬进队列。 */
  reasons: z.array(z.string()),
  features: reviewFeaturesSchema,
  status: antiCheatReviewStatusSchema,
  createdAt: z.string(),
});

/**
 * 同一条目所属身份在近窗内的均值口径。只是把队列里已有条目的特征做算术，
 * 不判定、不加减分，读数字的是人。
 */
export const adminAntiCheatAggregateSchema = z.object({
  /** 回看窗口的天数，与服务端常量同一处口径。 */
  windowDays: z.number().int(),
  rounds: z.number().int(),
  avgGuesses: z.number(),
  firstGuessHits: z.number().int(),
  avgCv: z.number().nullable(),
  maxScore: z.number().int(),
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
  players: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      online: z.boolean(),
      membership: z.string(),
      host: z.boolean(),
      bot: z.boolean(),
      userId: z.string().nullable(),
    })
  ),
});

const perGame = <T extends z.ZodType>(item: T) => z.object({ faker: item, song: item, cee: item });

export const adminOverviewSchema = z.object({
  users: z.object({
    total: z.number(),
    admins: z.number(),
    banned: z.number(),
    newToday: z.number(),
  }),
  feedback: z.record(feedbackStatusSchema, z.number()),
  live: perGame(z.object({ rooms: z.number(), onlinePlayers: z.number() })),
  /** 按北京时间自然日，升序且不缺日；对局记录永久保留。 */
  daily: z.array(
    z.object({
      day: z.string(),
      visitors: z.number(),
      signedInVisitors: z.number(),
      views: z.number(),
      newUsers: z.number(),
      /** 一局数：一个房间从创建到销毁算一局。 */
      games: perGame(z.number()),
      /** 参与人次：每局按去重玩家数累加。 */
      roundPlayers: z.number(),
    })
  ),
  pages: z.array(z.object({ path: z.string(), views: z.number() })),
});

export const sentryOverviewSchema = z.object({
  /** 服务端未配置 `SENTRY_API_TOKEN` 时为 false，其余字段为空。 */
  configured: z.boolean(),
  /** 近 24 小时错误事件数（前后端项目合计）。 */
  errors24h: z.number().nullable(),
  unresolvedIssues: z.number().nullable(),
  issues: z.array(
    z.object({
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
    })
  ),
  /** 近 24 小时调用最多的事务及其耗时分位（毫秒）。 */
  transactions: z
    .array(
      z.object({
        name: z.string(),
        project: z.string().nullable(),
        count: z.number(),
        p75: z.number().nullable(),
        p95: z.number().nullable(),
      })
    )
    .nullable(),
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

/**
 * 过程的机器可读说明，`scripts/ExportOpenapi.ts` 据此生成对外契约（Postman / AI Agent 直接照打）。
 *
 * - `description`：调用方视角的行为与前置条件，是这个过程的**唯一**说明来源，不再另写文档注释。
 * - `auth`：服务端路由实际套用的鉴权层级，必须与 `transport/routes/Account.ts` 的
 *   `base` / `signedIn` / `adminOnly` 一致；`test/RpcOpenapi.test.ts` 用真实路由核对，写错即红。
 */
export type RpcAuth = "public" | "session" | "admin";
const op = (description: string, auth: RpcAuth) => oc.meta({ description, auth });

const adminContract = {
  users: {
    list: op("分页查账号；`query` 为纯数字时按 QQ 号前缀匹配，否则按账号昵称包含匹配。", "admin")
      .input(
        z.object({
          query: z.string().trim().max(64).optional(),
          role: z.enum(["user", "admin"]).optional(),
          banned: z.boolean().optional(),
          ...page,
        })
      )
      .output(paged(adminUserSchema)),
    get: op("账号详情：资料、最近对局与反馈数。", "admin")
      .input(z.object({ userId }))
      .output(adminUserDetailSchema),
    ban: op(
      "封禁账号并吊销全部会话；`expiresInHours` 缺省为永久。不能封禁自己或其他管理员。",
      "admin"
    )
      .input(
        z.object({
          userId,
          reason: reason.min(1, "请填写封禁原因"),
          expiresInHours: z
            .number()
            .int()
            .min(1)
            .max(24 * 3650)
            .optional(),
        })
      )
      .output(adminUserSchema),
    unban: op("解除封禁，会话不恢复（登录时按封禁状态判定）。", "admin")
      .input(z.object({ userId }))
      .output(adminUserSchema),
    setRole: op("切换 `user` / `admin` 角色。", "admin")
      .input(z.object({ userId, role: z.enum(["user", "admin"]) }))
      .output(adminUserSchema),
    revokeSessions: op("吊销该账号的全部会话（强制下线），不改资料与封禁状态。", "admin")
      .input(z.object({ userId }))
      .output(z.object({ ok: z.literal(true) })),
  },
  settings: {
    list: op(
      "读取运行期旋钮（T3）：环境变量缺省、库内覆盖值与当前生效值一起给出。",
      "admin"
    ).output(z.object({ items: z.array(adminRuntimeSettingSchema) })),
    set: op(
      "改一个运行期旋钮：按该键的校验通过后落 `app_setting`，本进程立即生效，其余分片按缓存周期收敛。未配置数据库时拒绝。",
      "admin"
    )
      .input(z.object({ key: runtimeSettingKeySchema, value: z.string().max(64) }))
      .output(z.object({ items: z.array(adminRuntimeSettingSchema) })),
  },
  feedback: {
    list: op("分页查全部反馈，可按状态、类型、提交人过滤。", "admin")
      .input(
        z.object({
          status: feedbackStatusSchema.optional(),
          kind: feedbackKindSchema.optional(),
          userId: userId.optional(),
          ...page,
        })
      )
      .output(paged(adminFeedbackSchema)),
    get: op("读取单条反馈详情，含全部回复与提交时的 user-agent。", "admin")
      .input(z.object({ id: z.string().min(1).max(36) }))
      .output(adminFeedbackDetailSchema),
    reply: op("回复反馈；用户侧出现未读，待处理的反馈随之转为处理中。", "admin")
      .input(
        z.object({
          id: z.string().min(1).max(36),
          content: z.string().trim().min(1, "请填写回复").max(FEEDBACK_REPLY_MAX_LENGTH),
        })
      )
      .output(adminFeedbackDetailSchema),
    setStatus: op("更新反馈状态。", "admin")
      .input(z.object({ id: z.string().min(1).max(36), status: feedbackStatusSchema }))
      .output(adminFeedbackSchema),
  },
  antiCheat: {
    list: op(
      "分页查反作弊人工复核队列，可按状态过滤；条目是候选不是结论，不含任何自动处罚。",
      "admin"
    )
      .input(
        z.object({
          status: antiCheatReviewStatusSchema.optional(),
          /** 只查这之后产生的条目（epoch 毫秒），缺省查全部。 */
          since: z.number().int().min(0).optional(),
          ...page,
        })
      )
      .output(paged(adminAntiCheatReviewSchema)),
    history: op(
      "展开这条条目所属身份在近窗内的其它条目，只回均值数字；窗口固定，不接受按昵称批量拉人。",
      "admin"
    )
      .input(z.object({ id: z.string().min(1).max(36) }))
      .output(adminAntiCheatAggregateSchema),
    setStatus: op("标记一条复核条目的处置结果（`cleared` 放行 / `actioned` 已处置）。", "admin")
      .input(z.object({ id: z.string().min(1).max(36), status: antiCheatReviewStatusSchema }))
      .output(z.object({ ok: z.literal(true) })),
  },
  rooms: {
    list: op("列出实时房间（进程内全量，不分页）；CEE 只含增强房。", "admin")
      .input(z.object({ game: recordedGameSchema.optional() }))
      .output(z.array(adminRoomSchema)),
    close: op("关闭指定房间，房内玩家收到关闭原因。", "admin")
      .input(z.object({ game: recordedGameSchema, roomId: z.string().min(1).max(32) }))
      .output(z.object({ ok: z.literal(true) })),
    kick: op("把玩家踢出房间；玩家不在该房间时报 `PLAYER_NOT_FOUND`。", "admin")
      .input(
        z.object({
          game: recordedGameSchema,
          roomId: z.string().min(1).max(32),
          playerId: z.string().min(1).max(64),
        })
      )
      .output(z.object({ ok: z.literal(true) })),
  },
  games: {
    list: op("分页查对局记录，可按游戏、房号、参与人过滤。", "admin")
      .input(
        z.object({
          game: recordedGameSchema.optional(),
          roomId: z.string().max(32).optional(),
          userId: userId.optional(),
          ...page,
        })
      )
      .output(paged(gameRecordItemSchema)),
    get: op("对局详情：逐回合得分与全房合并时间线。", "admin")
      .input(z.object({ id: z.string().min(1).max(36) }))
      .output(gameRecordDetailSchema),
  },
  audit: {
    list: op("分页查管理操作审计流水（所有写操作都会在此留痕）。", "admin")
      .input(
        z.object({
          actorId: userId.optional(),
          action: z.string().max(64).optional(),
          targetType: z.string().max(32).optional(),
          targetId: z.string().max(128).optional(),
          ...page,
        })
      )
      .output(paged(auditEntrySchema)),
  },
  qq: {
    status: op("探测 NapCat 是否在线并已登录 QQ（结果在服务端缓存 15 秒）。", "admin").output(
      qqLookupStatusSchema
    ),
    refreshNames: op("刷新最久未查的一批账号的 QQ 昵称（单次最多 200 个）。", "admin").output(
      z.object({
        checked: z.number().int(),
        updated: z.number().int(),
        remaining: z.number().int(),
      })
    ),
  },
  stats: {
    overview: op(
      "后台概览：账号与反馈量、三款游戏的实时房间，以及按北京时间自然日的访问与对局（`days` 默认 14，上限 90）。",
      "admin"
    )
      .input(z.object({ days: z.number().int().min(1).max(90).default(14) }))
      .output(adminOverviewSchema),
    sentry: op(
      "服务端以只读令牌代查 Sentry 近 24 小时的错误与耗时分位，结果缓存 60 秒；令牌不出服务端。",
      "admin"
    ).output(sentryOverviewSchema),
  },
};

export const apiContract = {
  site: {
    visit: op(
      "前端每次载入页面报一次；`visitorId` 是浏览器本地随机值，路径只按板块统计，未登录同样记录。",
      "public"
    )
      .input(
        z.object({
          visitorId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
          path: z.string().max(512),
        })
      )
      .output(z.object({ ok: z.literal(true) })),
  },
  account: {
    requestLoginCode: op(
      "发送登录验证码。新号发码前必须取到 QQ 昵称（用作账号昵称）：查询不可用时拒绝，即停用注册；" +
        "`qqName` 是登录弹窗在头像下展示的身份：新号为即将注册的昵称，老号为库里最近一次同步的 QQ 昵称。",
      "public"
    )
      .input(z.object({ qqNumber }))
      .output(
        z.object({
          registered: z.boolean(),
          resendAfterSeconds: z.number().int(),
          qqName: z.string().nullable(),
        })
      ),
    qqName: op(
      "登录弹窗输入 QQ 号后回显的身份昵称：已注册取库里最近一次同步的值，未注册现查（即即将注册的账号昵称）。" +
        "查不到返回 `null`，不挡住发码。不回答该号是否已注册；按客户端地址限流，防止按号批量枚举昵称。",
      "public"
    )
      .input(z.object({ qqNumber }))
      .output(z.string().nullable()),
    me: op(
      "当前登录资料；未登录返回 `null`（不报 401）。顺带按节流刷新 QQ 头像，每次访问调用一次即可。",
      "public"
    ).output(accountProfileSchema.nullable()),
    updateProfile: op(
      "账号昵称强制取自 QQ 昵称、不可修改；此处只允许切换 QQ 号公开开关。",
      "session"
    )
      .input(z.object({ showQq: z.boolean().optional() }))
      .output(accountProfileSchema),
    publicProfile: op("别人看到的资料卡：QQ 号仅在本人公开时出现。", "public")
      .input(z.object({ userId: z.string().min(1).max(64) }))
      .output(publicProfileSchema),
  },
  settings: {
    get: op("读取云端设置：偏好文档与两个音乐平台的账号会话。", "session").output(
      cloudSettingsSchema
    ),
    savePreferences: op("整体覆盖偏好文档，返回服务端记录的更新时间；文档超限即拒绝。", "session")
      .input(z.object({ value: preferences }))
      .output(z.object({ updatedAt: z.string() })),
    saveMusicSession: op(
      "保存某个音乐平台的账号会话；`session` 为空表示退出该平台账号并删除云端副本。cookie 在服务端加密落库，只回给本人。",
      "session"
    )
      .input(z.object({ platform: musicPlatformSchema, session: musicSessionSchema.nullable() }))
      .output(z.object({ updatedAt: z.string() })),
  },
  feedback: {
    create: op("提交站内反馈；服务端一并记下请求的 user-agent。", "session")
      .input(
        z.object({
          kind: feedbackKindSchema,
          title: z.string().trim().min(1, "请填写标题").max(FEEDBACK_TITLE_MAX_LENGTH),
          content: z.string().trim().min(1, "请填写内容").max(FEEDBACK_CONTENT_MAX_LENGTH),
          page: z.string().max(255).optional(),
        })
      )
      .output(feedbackSummarySchema),
    listMine: op("列出本人提交的反馈与未读回复数。", "session").output(
      z.object({ items: z.array(feedbackSummarySchema), unread: z.number().int() })
    ),
    get: op("读取反馈详情，并把晚于本人上次查看的管理员回复标记为已读。", "session")
      .input(z.object({ id: z.string().min(1).max(36) }))
      .output(feedbackDetailSchema),
  },
  /** 仅管理员；每次调用按 ID 读库校验角色与封禁状态，写操作全部留审计。 */
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
export type AdminAntiCheatReview = z.infer<typeof adminAntiCheatReviewSchema>;
export type AdminAntiCheatAggregate = z.infer<typeof adminAntiCheatAggregateSchema>;
export type AntiCheatReviewStatus = z.infer<typeof antiCheatReviewStatusSchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type AdminRoom = z.infer<typeof adminRoomSchema>;
export type AdminOverview = z.infer<typeof adminOverviewSchema>;
export type SentryOverview = z.infer<typeof sentryOverviewSchema>;
export type QQLookupStatus = z.infer<typeof qqLookupStatusSchema>;
