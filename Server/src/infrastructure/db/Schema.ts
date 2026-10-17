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
 * 持久化 schema 的唯一真相源（TiDB / MySQL 协议）。
 *
 * - 时间列一律 `datetime(3)` + UTC（连接层固定 `timezone: "Z"`）：`timestamp` 在 2038 年溢出，
 *   封禁到期之类的远期时间放不下。
 * - 表的 JS 属性名即 Better Auth 字段名（drizzle 适配器按属性名映射），列名用蛇形。
 * - 变更 schema 后执行 `bun run db:generate` 生成迁移；服务启动时自动应用。
 */

const createdAt = () => datetime("created_at", { mode: "date", fsp: 3 }).notNull().$defaultFn(() => new Date());
const updatedAt = () => datetime("updated_at", { mode: "date", fsp: 3 }).notNull().$defaultFn(() => new Date()).$onUpdateFn(() => new Date());

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
});

export const session = mysqlTable("session", {
  id: varchar("id", { length: 64 }).primaryKey(),
  expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
  token: varchar("token", { length: 255 }).notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  ipAddress: varchar("ip_address", { length: 64 }),
  userAgent: text("user_agent"),
  userId: varchar("user_id", { length: 64 }).notNull().references(() => user.id, { onDelete: "cascade" }),
  impersonatedBy: varchar("impersonated_by", { length: 64 }),
}, (table) => [index("session_user_idx").on(table.userId)]);

export const account = mysqlTable("account", {
  id: varchar("id", { length: 64 }).primaryKey(),
  accountId: varchar("account_id", { length: 255 }).notNull(),
  providerId: varchar("provider_id", { length: 64 }).notNull(),
  userId: varchar("user_id", { length: 64 }).notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: datetime("access_token_expires_at", { mode: "date", fsp: 3 }),
  refreshTokenExpiresAt: datetime("refresh_token_expires_at", { mode: "date", fsp: 3 }),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [index("account_user_idx").on(table.userId)]);

export const verification = mysqlTable("verification", {
  id: varchar("id", { length: 64 }).primaryKey(),
  identifier: varchar("identifier", { length: 255 }).notNull(),
  value: text("value").notNull(),
  expiresAt: datetime("expires_at", { mode: "date", fsp: 3 }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (table) => [index("verification_identifier_idx").on(table.identifier)]);

// ==================== 用户数据 ====================

/** 云同步设置：一行一个键，值为该键的完整 JSON 文档（整体覆盖，不做字段级合并）。 */
export const userSetting = mysqlTable("user_setting", {
  userId: varchar("user_id", { length: 64 }).notNull().references(() => user.id, { onDelete: "cascade" }),
  key: varchar("setting_key", { length: 48 }).notNull(),
  value: json("value").notNull(),
  updatedAt: updatedAt(),
}, (table) => [primaryKey({ columns: [table.userId, table.key] })]);

// ==================== 游戏数据 ====================

/** 谁是卧底出题人提交过的词对（规范化 + 字典序，唯一）。 */
export const wordPair = mysqlTable("word_pair", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  wordA: varchar("word_a", { length: 64 }).notNull(),
  wordB: varchar("word_b", { length: 64 }).notNull(),
  useCount: int("use_count").notNull().default(1),
  createdAt: createdAt(),
  lastUsedAt: datetime("last_used_at", { mode: "date", fsp: 3 }).notNull().$defaultFn(() => new Date()),
}, (table) => [uniqueIndex("word_pair_unique").on(table.wordA, table.wordB)]);

/** 一轮对局一条：摘要 + 关键事件时间线（为回放预留），滚动保留 7 天。 */
export const gameRecord = mysqlTable("game_record", {
  id: varchar("id", { length: 36 }).primaryKey(),
  game: varchar("game", { length: 16 }).notNull(),
  roomId: varchar("room_id", { length: 32 }).notNull(),
  roundNumber: int("round_number").notNull(),
  startedAt: datetime("started_at", { mode: "date", fsp: 3 }).notNull(),
  endedAt: datetime("ended_at", { mode: "date", fsp: 3 }).notNull(),
  playerCount: int("player_count").notNull(),
  summary: json("summary").notNull(),
  timeline: json("timeline").notNull(),
}, (table) => [
  index("game_record_ended_idx").on(table.endedAt),
  index("game_record_game_ended_idx").on(table.game, table.endedAt),
  index("game_record_room_idx").on(table.roomId),
]);

export const gameRecordPlayer = mysqlTable("game_record_player", {
  recordId: varchar("record_id", { length: 36 }).notNull().references(() => gameRecord.id, { onDelete: "cascade" }),
  playerId: varchar("player_id", { length: 64 }).notNull(),
  userId: varchar("user_id", { length: 64 }).references(() => user.id, { onDelete: "set null" }),
  name: varchar("name", { length: 64 }).notNull(),
  score: int("score").notNull(),
}, (table) => [
  primaryKey({ columns: [table.recordId, table.playerId] }),
  index("game_record_player_user_idx").on(table.userId),
]);

// ==================== 管理与运营 ====================

export const auditLog = mysqlTable("audit_log", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  /** 操作人；系统动作为空。 */
  actorId: varchar("actor_id", { length: 64 }),
  action: varchar("action", { length: 64 }).notNull(),
  targetType: varchar("target_type", { length: 32 }).notNull(),
  targetId: varchar("target_id", { length: 128 }).notNull(),
  detail: json("detail"),
  ipAddress: varchar("ip_address", { length: 64 }),
  createdAt: createdAt(),
}, (table) => [
  index("audit_log_created_idx").on(table.createdAt),
  index("audit_log_actor_idx").on(table.actorId),
  index("audit_log_action_idx").on(table.action),
]);

export const feedback = mysqlTable("feedback", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: varchar("user_id", { length: 64 }).notNull().references(() => user.id, { onDelete: "cascade" }),
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
}, (table) => [
  index("feedback_user_idx").on(table.userId, table.createdAt),
  index("feedback_status_idx").on(table.status, table.createdAt),
]);

export const feedbackReply = mysqlTable("feedback_reply", {
  id: bigint("id", { mode: "number", unsigned: true }).autoincrement().primaryKey(),
  feedbackId: varchar("feedback_id", { length: 36 }).notNull().references(() => feedback.id, { onDelete: "cascade" }),
  authorId: varchar("author_id", { length: 64 }).references(() => user.id, { onDelete: "set null" }),
  content: text("content").notNull(),
  createdAt: createdAt(),
}, (table) => [index("feedback_reply_feedback_idx").on(table.feedbackId, table.createdAt)]);

/** 访问统计：按北京时间自然日 + 匿名访客摘要聚合，不存 IP 原文。 */
export const siteVisitDaily = mysqlTable("site_visit_daily", {
  day: varchar("day", { length: 10 }).notNull(),
  visitorHash: varchar("visitor_hash", { length: 32 }).notNull(),
  userId: varchar("user_id", { length: 64 }),
  views: int("views").notNull(),
}, (table) => [primaryKey({ columns: [table.day, table.visitorHash] })]);

export const sitePageDaily = mysqlTable("site_page_daily", {
  day: varchar("day", { length: 10 }).notNull(),
  path: varchar("path", { length: 64 }).notNull(),
  views: int("views").notNull(),
}, (table) => [primaryKey({ columns: [table.day, table.path] })]);
