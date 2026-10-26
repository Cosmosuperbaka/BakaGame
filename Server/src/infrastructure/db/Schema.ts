import {
  bigint,
  boolean,
  datetime,
  index,
  int,
  json,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * 持久化 schema 的唯一真相源（MySQL 协议）。
 *
 * - 时间列一律 `datetime(3)` + UTC（连接层固定 `timezone: "Z"`）：`timestamp` 在 2038 年溢出，
 *   封禁到期之类的远期时间放不下。
 * - 表的 JS 属性名即 Better Auth 字段名（drizzle 适配器按属性名映射），列名用蛇形。
 * - 变更 schema 后执行 `bun run db:generate` 生成迁移；服务启动时自动应用。
 */

const createdAt = () =>
  datetime("created_at", { mode: "date", fsp: 3 })
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  datetime("updated_at", { mode: "date", fsp: 3 })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

// ==================== 身份徽章 ====================

/**
 * 徽章目录：启动时按 `shared/Badges.ts` 幂等补齐并删除已下线的类型，`user_badge` 以它为外键目标。
 * 主理人与先行者由系统自动授予，贡献者只由管理员人工授予。
 */
export const badge = mysqlTable("badge", {
  id: varchar("id", { length: 16 }).primaryKey(),
  label: varchar("label", { length: 16 }).notNull(),
  description: varchar("description", { length: 120 }).notNull(),
  sortOrder: int("sort_order").notNull(),
});

// ==================== Better Auth ====================

export const user = mysqlTable("user", {
  id: varchar("id", { length: 64 }).primaryKey(),
  /** 账号昵称（用户手填，与游戏内昵称互不捆绑）。 */
  name: varchar("name", { length: 64 }).notNull(),
  /** 固定为 `QQ号@qq.com`，由注册钩子强制。 */
  email: varchar("email", { length: 128 }).notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  role: varchar("role", { length: 16 }),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: datetime("ban_expires", { mode: "date", fsp: 3 }),
  qqNumber: varchar("qq_number", { length: 16 }).notNull().unique(),
  /** QQ 号属于隐私：默认不在名片上展示。 */
  showQq: boolean("show_qq").notNull().default(false),
  /** QQ 头像内容摘要；变化即换代头像 URL，浏览器缓存随之失效。 */
  avatarHash: varchar("avatar_hash", { length: 64 }),
  avatarCheckedAt: datetime("avatar_checked_at", { mode: "date", fsp: 3 }),
  /** QQ 昵称（经后台扫码登录的查询号获取，只给管理员看与注册预填）；与账号昵称互不覆盖。 */
  qqName: varchar("qq_name", { length: 64 }),
  qqNameCheckedAt: datetime("qq_name_checked_at", { mode: "date", fsp: 3 }),
  /** 玩家佩戴的徽章；为空表示不佩戴。只能佩戴自己已获得的徽章。 */
  equippedBadge: varchar("equipped_badge", { length: 16 }).references(() => badge.id, {
    onDelete: "set null",
  }),
});

/** 注册序号：按建号顺序递增，先行者按它授予；序号不因注销回收。 */
export const userRegistration = mysqlTable("user_registration", {
  seq: int("seq", { unsigned: true }).autoincrement().primaryKey(),
  userId: varchar("user_id", { length: 64 })
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const session = mysqlTable(
  "session",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
    token: varchar("token", { length: 255 }).notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    userId: varchar("user_id", { length: 64 })
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: varchar("impersonated_by", { length: 64 }),
  },
  (table) => [index("session_user_idx").on(table.userId)]
);

export const account = mysqlTable(
  "account",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    accountId: varchar("account_id", { length: 255 }).notNull(),
    providerId: varchar("provider_id", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 64 })
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: datetime("access_token_expires_at", { mode: "date", fsp: 3 }),
    refreshTokenExpiresAt: datetime("refresh_token_expires_at", { mode: "date", fsp: 3 }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("account_user_idx").on(table.userId)]
);

export const verification = mysqlTable(
  "verification",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    identifier: varchar("identifier", { length: 255 }).notNull(),
    value: text("value").notNull(),
    expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)]
);

/**
 * 通行密钥（WebAuthn 凭据）：一行一把密钥，登录时按 `credentialID` 反查所属账号。
 *
 * - 属性名与 Better Auth `@better-auth/passkey` 声明的字段一一对应，适配器按属性名映射，改名即断链。
 * - 公钥是原始 CBOR/COSE 字节的 base64，长度不固定，用 `text`；私钥永不落库。
 */
export const passkey = mysqlTable(
  "passkey",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    /** 用户自定义的密钥名称（如「公司的 YubiKey」），只为管理列表可读。 */
    name: varchar("name", { length: 255 }),
    publicKey: text("public_key").notNull(),
    userId: varchar("user_id", { length: 64 })
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** WebAuthn 凭据 ID（base64url）：全局唯一，认证时按它定位密钥。 */
    credentialID: varchar("credential_id", { length: 255 }).notNull(),
    counter: int("counter", { unsigned: true }).notNull(),
    deviceType: varchar("device_type", { length: 32 }).notNull(),
    backedUp: boolean("backed_up").notNull().default(false),
    transports: varchar("transports", { length: 128 }),
    aaguid: varchar("aaguid", { length: 64 }),
    createdAt: createdAt(),
  },
  (table) => [
    index("passkey_user_idx").on(table.userId),
    uniqueIndex("passkey_credential_idx").on(table.credentialID),
  ]
);

// ==================== 客户端通道 ====================

/**
 * 已注册的壳设备公钥。`clientId` 由公钥摘要派生，所以同一把密钥重复注册天然幂等，
 * 不需要「证明我拥有这把密钥」这类额外往返——拥有关系在每次换票时都在证。
 * 私钥永不落库；这张表泄露只暴露公钥，不能用来签名。
 */
export const clientChannelDevice = mysqlTable("client_channel_device", {
  clientId: varchar("client_id", { length: 64 }).primaryKey(),
  clientType: varchar("client_type", { length: 16 }).notNull(),
  platform: varchar("platform", { length: 32 }).notNull(),
  keyAlgorithm: varchar("key_algorithm", { length: 16 }).notNull(),
  publicKey: text("public_key").notNull(),
  keyProtection: varchar("key_protection", { length: 16 }).notNull(),
  /** 注册时服务端验出来的平台证明档位；null = 没有平台证明（桌面端或未带链的移动端）。 */
  attestationLevel: varchar("attestation_level", { length: 16 }),
  registeredAt: datetime("registered_at", { fsp: 3 }).notNull(),
  lastSeenAt: datetime("last_seen_at", { fsp: 3 }).notNull(),
});

/** 账号与徽章的授予关系：一个账号同类徽章只有一枚。 */
export const userBadge = mysqlTable(
  "user_badge",
  {
    userId: varchar("user_id", { length: 64 })
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    badgeId: varchar("badge_id", { length: 16 })
      .notNull()
      .references(() => badge.id, { onDelete: "cascade" }),
    /** 授予人；账号注销后置空，审计流水仍保留操作人。 */
    grantedBy: varchar("granted_by", { length: 64 }).references(() => user.id, {
      onDelete: "set null",
    }),
    grantedAt: datetime("granted_at", { mode: "date", fsp: 3 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.badgeId] }),
    index("user_badge_badge_idx").on(table.badgeId),
  ]
);

// ==================== 用户数据 ====================

/** 云同步设置：一行一个键，值为该键的完整 JSON 文档（整体覆盖，不做字段级合并）。 */
export const userSetting = mysqlTable(
  "user_setting",
  {
    userId: varchar("user_id", { length: 64 })
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    key: varchar("setting_key", { length: 48 }).notNull(),
    value: json("value").notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.key] })]
);

// ==================== 游戏数据 ====================

/** 谁是卧底出题人提交过的词对（规范化 + 字典序，唯一）。 */
export const wordPair = mysqlTable(
  "word_pair",
  {
    id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
    wordA: varchar("word_a", { length: 64 }).notNull(),
    wordB: varchar("word_b", { length: 64 }).notNull(),
    useCount: int("use_count").notNull().default(1),
    createdAt: createdAt(),
    lastUsedAt: datetime("last_used_at", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("word_pair_unique").on(table.wordA, table.wordB)]
);

/** 一个房间一局：房间从创建到销毁，永久保留；回合明细见 `game_record_round`。 */
export const gameRecord = mysqlTable(
  "game_record",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    game: varchar("game", { length: 16 }).notNull(),
    roomId: varchar("room_id", { length: 32 }).notNull(),
    /** 一局内的回合数。 */
    roundCount: int("round_count").notNull(),
    /** 房间创建时刻。 */
    startedAt: datetime("started_at", { mode: "date", fsp: 3 }).notNull(),
    /** 房间销毁时刻；进程重启等未走销毁流程时停在最后一个回合的结束时刻。 */
    endedAt: datetime("ended_at", { mode: "date", fsp: 3 }).notNull(),
    playerCount: int("player_count").notNull(),
  },
  (table) => [
    index("game_record_ended_idx").on(table.endedAt),
    index("game_record_game_ended_idx").on(table.game, table.endedAt),
    index("game_record_room_idx").on(table.roomId),
  ]
);

/** 一局中的一回合：摘要 + 关键事件时间线（为回放预留），按回合序号顺序落库。 */
export const gameRecordRound = mysqlTable(
  "game_record_round",
  {
    recordId: varchar("record_id", { length: 36 })
      .notNull()
      .references(() => gameRecord.id, { onDelete: "cascade" }),
    number: int("round_number").notNull(),
    startedAt: datetime("started_at", { mode: "date", fsp: 3 }).notNull(),
    endedAt: datetime("ended_at", { mode: "date", fsp: 3 }).notNull(),
    /** 本回合参与人数，与 `players` 长度一致。 */
    playerCount: int("player_count").notNull(),
    /** 回合得分增量（`GameRecordPlayer[]`）。 */
    players: json("players").notNull(),
    summary: json("summary").notNull(),
    timeline: json("timeline").notNull(),
  },
  (table) => [primaryKey({ columns: [table.recordId, table.number] })]
);

export const gameRecordPlayer = mysqlTable(
  "game_record_player",
  {
    recordId: varchar("record_id", { length: 36 })
      .notNull()
      .references(() => gameRecord.id, { onDelete: "cascade" }),
    playerId: varchar("player_id", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 64 }).references(() => user.id, { onDelete: "set null" }),
    name: varchar("name", { length: 64 }).notNull(),
    score: int("score").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.recordId, table.playerId] }),
    index("game_record_player_user_idx").on(table.userId),
  ]
);

// ==================== 管理与运营 ====================

/**
 * CEE 反作弊人工复核队列：只记录「服务端可观测特征 + 可疑度」，不含任何处罚状态。
 * 写入即排队，是否处理由人在这里改 `status`；代码路径永不据此封禁。
 */
export const ceeAntiCheatReview = mysqlTable(
  "cee_anti_cheat_review",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    roomId: varchar("room_id", { length: 8 }).notNull(),
    roomCreatedAt: datetime("room_created_at", { mode: "date", fsp: 3 }).notNull(),
    roundNumber: int("round_number").notNull(),
    playerId: varchar("player_id", { length: 64 }).notNull(),
    playerName: varchar("player_name", { length: 64 }).notNull(),
    /** 游客被复核时只能按连接追溯，账号 ID 为空。 */
    userId: varchar("user_id", { length: 64 }),
    clientType: varchar("client_type", { length: 16 }).notNull(),
    score: int("score").notNull(),
    reasons: json("reasons").notNull(),
    features: json("features").notNull(),
    /** `open` 待复核 / `cleared` 已排除 / `actioned` 已人工处置。 */
    status: varchar("status", { length: 16 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("cee_ac_review_created_idx").on(table.createdAt),
    index("cee_ac_review_status_idx").on(table.status, table.createdAt),
    index("cee_ac_review_user_idx").on(table.userId),
  ]
);

export const auditLog = mysqlTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
    /** 操作人；系统动作为空。 */
    actorId: varchar("actor_id", { length: 64 }),
    action: varchar("action", { length: 64 }).notNull(),
    targetType: varchar("target_type", { length: 32 }).notNull(),
    targetId: varchar("target_id", { length: 128 }).notNull(),
    detail: json("detail"),
    ipAddress: varchar("ip_address", { length: 64 }),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_log_created_idx").on(table.createdAt),
    index("audit_log_actor_idx").on(table.actorId),
    index("audit_log_action_idx").on(table.action),
  ]
);

/**
 * 运行期旋钮（T3）：一行一个键，值为规范化后的原始字符串。
 *
 * 只有「改它不该等下一次重建容器」的项进这里，凭据与部署拓扑永远在环境变量。
 * 键与校验见 `shared/RuntimeSettings.ts`；读取侧有缓存且**回落环境变量缺省**，
 * 因此没有数据库时行为与进表之前完全一致。
 */
export const appSetting = mysqlTable("app_setting", {
  key: varchar("setting_key", { length: 48 }).primaryKey(),
  value: text("value").notNull(),
  /** 最后改动该键的管理员 id；系统写入或未知来源为空。 */
  updatedBy: varchar("updated_by", { length: 64 }),
  updatedAt: updatedAt(),
});

export const feedback = mysqlTable(
  "feedback",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    /** 匿名反馈不关联账号；账号删除时其反馈随外键级联清除。 */
    userId: varchar("user_id", { length: 64 }).references(() => user.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 16 }).notNull(),
    title: varchar("title", { length: 120 }).notNull(),
    content: text("content").notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    page: varchar("page", { length: 255 }),
    userAgent: varchar("user_agent", { length: 512 }),
    /** Sentry User Feedback 事件 id；转发失败时为空，不影响站内反馈本身。 */
    sentryEventId: varchar("sentry_event_id", { length: 64 }),
    /** 最近一次管理员回复时间；晚于 `userSeenAt` 即为未读。 */
    lastReplyAt: datetime("last_reply_at", { mode: "date", fsp: 3 }),
    userSeenAt: datetime("user_seen_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("feedback_user_idx").on(table.userId, table.createdAt),
    index("feedback_status_idx").on(table.status, table.createdAt),
  ]
);

export const feedbackReply = mysqlTable(
  "feedback_reply",
  {
    id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
    feedbackId: varchar("feedback_id", { length: 36 })
      .notNull()
      .references(() => feedback.id, { onDelete: "cascade" }),
    authorId: varchar("author_id", { length: 64 }).references(() => user.id, {
      onDelete: "set null",
    }),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("feedback_reply_feedback_idx").on(table.feedbackId, table.createdAt)]
);

/** 访问统计：按北京时间自然日 + 匿名访客摘要聚合，不存 IP 原文。 */
export const siteVisitDaily = mysqlTable(
  "site_visit_daily",
  {
    day: varchar("day", { length: 10 }).notNull(),
    visitorHash: varchar("visitor_hash", { length: 32 }).notNull(),
    userId: varchar("user_id", { length: 64 }),
    views: int("views").notNull(),
  },
  (table) => [primaryKey({ columns: [table.day, table.visitorHash] })]
);

export const sitePageDaily = mysqlTable(
  "site_page_daily",
  {
    day: varchar("day", { length: 10 }).notNull(),
    path: varchar("path", { length: 64 }).notNull(),
    views: int("views").notNull(),
  },
  (table) => [primaryKey({ columns: [table.day, table.path] })]
);

/**
 * 公开状态页的历史：一个环境一个组件一个北京时间自然日一行，存的是各级别的探测计数。
 *
 * - 开发与生产共用一个库时各自记各自的行：`environment` 取进程的部署环境标记，
 *   状态页只读自己环境的数据，开发实例的探测不会把生产的条带搅浑。
 * - 存计数而不是存每次探测的结果：30 天 × 10 个组件固定 300 行，探测频率再高也不会膨胀，
 *   而可用率与日格都只由计数派生。`total` 为 0 的行不会出现（没有探测就不写），
 *   「那一天没数据」由缺行表达，不用一行全零去冒充。
 */
export const statusDaily = mysqlTable(
  "status_daily",
  {
    environment: varchar("environment", { length: 24 }).notNull().default("production"),
    componentId: varchar("component_id", { length: 24 }).notNull(),
    day: varchar("day", { length: 10 }).notNull(),
    total: int("total").notNull(),
    operational: int("operational").notNull(),
    degraded: int("degraded").notNull(),
    unknown: int("unknown").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.environment, table.componentId, table.day] }),
    index("status_daily_day_idx").on(table.day),
  ]
);

/**
 * 状态页实时条带的样本账：一个环境一个组件一个采样间隔一格，
 * 除各等级计数外还累计带延迟读数的样本（和值 + 个数，读时求均值）。
 * 只保留实时窗口外加一栏余量，行数有界；结构同 `status_daily`，绝对值覆盖写。
 */
export const statusSample = mysqlTable(
  "status_sample",
  {
    environment: varchar("environment", { length: 24 }).notNull(),
    componentId: varchar("component_id", { length: 24 }).notNull(),
    /** 格子起点，UTC，对齐采样间隔；用 bigint 毫秒而非 datetime：读出后直接当索引算格子。 */
    bucket: bigint("bucket", { mode: "number", unsigned: true }).notNull(),
    total: int("total").notNull(),
    operational: int("operational").notNull(),
    degraded: int("degraded").notNull(),
    unknown: int("unknown").notNull(),
    latencySum: bigint("latency_sum", { mode: "number", unsigned: true }).notNull(),
    latencyCount: int("latency_count").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.environment, table.componentId, table.bucket] }),
    index("status_sample_bucket_idx").on(table.bucket),
  ]
);

/**
 * 状态页的事件与维护窗口：一条一行，正文整体覆盖更新（改写历史由管理审计留痕）。
 * `components` 存公开组件白名单的 JSON 数组；时间列 UTC。
 */
export const statusEvent = mysqlTable(
  "status_event",
  {
    id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
    /** 与状态历史同口径的部署环境标记：事件只出现在所属环境的状态页上。 */
    environment: varchar("environment", { length: 24 }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    title: varchar("title", { length: 120 }).notNull(),
    body: text("body").notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    components: text("components").notNull(),
    /** 事件开始 / 维护窗口开始（计划中的维护可以是未来时刻）。 */
    startedAt: datetime("started_at", { mode: "date", fsp: 3 }).notNull(),
    /** 维护窗口的计划结束时刻；故障事件为 null。 */
    plannedEndAt: datetime("planned_end_at", { mode: "date", fsp: 3 }),
    /** 实际恢复 / 完成时刻；进行中为 null。 */
    resolvedAt: datetime("resolved_at", { mode: "date", fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("status_event_env_idx").on(table.environment, table.startedAt)]
);
