import type { Where } from "better-auth";

import type { AdminRoomControl, AdminRoomView } from "../domain/AdminRoom";
import { AppError } from "../domain/Errors";
import { beijingDay } from "./SiteStatsService";
import { capTimeline } from "./GameRecordService";
import { RECORDED_GAMES } from "../domain/GameRecord";
import type { BadgeRepository } from "../infrastructure/db/BadgeRepository";
import type { SiteStatsRepository } from "../infrastructure/db/SiteStatsRepository";
import type { AccountBadge, BadgeKind } from "../shared/Badges";
import type { QQNicknameService } from "./QQNicknameService";
import { SENTRY_NOT_CONFIGURED, type SentryApiClient } from "../infrastructure/SentryApi";
import type { RecordedGame } from "../domain/GameRecord";
import type { Auth } from "../infrastructure/auth/Auth";
import type { AppSettings } from "./AppSettings";
import type { AdminRuntimeSetting, RuntimeSettingKey } from "../shared/RuntimeSettings";
import type { AuditLogRepository } from "../infrastructure/db/AuditLogRepository";
import type {
  StatusEventFilter,
  StatusEventInput,
  StatusEventPatch,
  StatusEventRepository,
} from "../infrastructure/db/StatusEventRepository";
import {
  PUBLIC_STATUS_INCIDENT_STATUSES,
  PUBLIC_STATUS_MAINTENANCE_STATUSES,
  type PublicStatusComponentId,
  type PublicStatusEvent,
  type PublicStatusEventStatus,
  type PublicStatusIncidentKind,
} from "../shared/Status";
import type {
  GameRecordListItem,
  GameRecordRepository,
} from "../infrastructure/db/GameRecordRepository";
import type { FeedbackRecord, FeedbackRepository } from "../infrastructure/db/UserDataRepository";
import {
  aggregateCEEAntiCheatReviews,
  CEE_ANTI_CHEAT_AGGREGATE_WINDOW_MS,
  type CEEAntiCheatReviewBoard,
  type CEEAntiCheatReviewStatus,
} from "./CEEAntiCheatSignals";
import type {
  AdminAntiCheatAggregate,
  AdminAntiCheatReview,
  AdminFeedback,
  AdminOverview,
  AdminRoom,
  AdminFeedbackDetail,
  AdminUser,
  AdminUserDetail,
  AuditEntry,
  FeedbackKind,
  FeedbackStatus,
  GameRecordDetail,
  GameRecordItem,
  QQLookupStatus,
  SentryOverview,
} from "../shared/ApiContract";

interface UserRow {
  id: string;
  name: string;
  image?: string | null;
  createdAt: Date;
  role?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  banExpires?: Date | null;
  qqNumber: string;
  showQq?: boolean | null;
  qqName?: string | null;
  equippedBadge?: string | null;
}

type UserRef = { id: string; name: string; qqNumber: string; image: string | null };

export interface AdminServiceOptions {
  auth: Auth;
  feedback: FeedbackRepository;
  gameRecords: GameRecordRepository;
  audit: AuditLogRepository;
  /** 反作弊人工复核队列的读端口；写入由 CEE 侧触发，后台只读与改状态。 */
  reviews: CEEAntiCheatReviewBoard;
  /** 三款游戏的实时房间控制口；房间不落库，后台只经由它们读写。 */
  rooms: Record<RecordedGame, AdminRoomControl>;
  siteStats: SiteStatsRepository;
  /** 身份徽章的授予关系；目录由启动时补齐，这里只读写账号与徽章的关系。 */
  badges: BadgeRepository;
  /** 运行期旋钮（T3）：后台读它的内存快照，写它经校验后落 `app_setting`。 */
  settings: AppSettings;
  /** 未配置 `SENTRY_API_TOKEN` 时为 null，概览展示未配置。 */
  sentry: SentryApiClient | null;
  /** QQ 昵称查询号；缺省时 `admin.qq.*` 回 503。 */
  qq?: QQNicknameService | null;
  /** 状态页事件仓储；缺省时 `admin.statusEvents.*` 回 503（未配置数据库的实例）。 */
  statusEvents?: StatusEventRepository;
  /** 本进程的部署环境标记：状态事件按它隔离，与状态历史同一口径。 */
  environment: string;
  now?: () => number;
}

const toAdminUser = (row: UserRow, badges: readonly AccountBadge[]): AdminUser => ({
  id: row.id,
  name: row.name,
  qqNumber: row.qqNumber,
  image: row.image ?? null,
  role: row.role === "admin" ? "admin" : "user",
  banned: Boolean(row.banned),
  banReason: row.banned ? (row.banReason ?? null) : null,
  banExpires: row.banned && row.banExpires ? new Date(row.banExpires).toISOString() : null,
  showQq: Boolean(row.showQq),
  qqName: row.qqName ?? null,
  badges: [...badges],
  equippedBadge: badges.some((badge) => badge.kind === row.equippedBadge)
    ? (row.equippedBadge as BadgeKind)
    : null,
  createdAt: new Date(row.createdAt).toISOString(),
});

const toRef = (row: UserRow): UserRef => ({
  id: row.id,
  name: row.name,
  qqNumber: row.qqNumber,
  image: row.image ?? null,
});

const toAdminRoom = (room: AdminRoomView): AdminRoom => ({
  ...room,
  createdAt: new Date(room.createdAt).toISOString(),
  lastActiveAt: new Date(room.lastActiveAt).toISOString(),
});

const toGameItem = (record: GameRecordListItem): GameRecordItem => ({
  id: record.id,
  game: record.game,
  roomId: record.roomId,
  roundCount: record.roundCount,
  startedAt: record.startedAt.toISOString(),
  endedAt: record.endedAt.toISOString(),
  players: record.players,
});

/** 详情页合并时间线的出口上限：一局可能打很多回合，不能让单个响应无限膨胀。 */
const GAME_DETAIL_TIMELINE_MAX_BYTES = 1024 * 1024;

/**
 * 管理后台业务：用户、反馈、对局记录与审计。
 *
 * 每个写操作先写审计再执行：审计写不进去就不做，后台不存在「做了但查不到」的操作。
 * 用户行与会话经 Better Auth 适配器读写，与账号自助同一套存储口径。
 */
export class AdminService {
  private readonly now: () => number;

  constructor(private readonly options: AdminServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  private async context() {
    return this.options.auth.$context;
  }

  private async findUser(userId: string): Promise<UserRow | null> {
    return (await (await this.context()).internalAdapter.findUserById(userId)) as UserRow | null;
  }

  private async requireUser(userId: string): Promise<UserRow> {
    const row = await this.findUser(userId);
    if (!row) throw new AppError("NOT_FOUND", "用户不存在");
    return row;
  }

  private async adminUserOf(row: UserRow): Promise<AdminUser> {
    return toAdminUser(row, await this.options.badges.badgesOf(row.id));
  }

  private async usersById(ids: Array<string | null>): Promise<Map<string, UserRef>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map();
    const { adapter } = await this.context();
    const rows = await adapter.findMany<UserRow>({
      model: "user",
      where: [{ field: "id", operator: "in", value: unique }],
      limit: unique.length,
    });
    return new Map(rows.map((row) => [row.id, toRef(row)]));
  }

  private async audit(
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    detail?: Record<string, unknown>
  ) {
    await this.options.audit.append({
      actorId,
      action,
      targetType,
      targetId,
      detail: detail ?? null,
      createdAt: new Date(this.now()),
    });
  }

  /** 按 ID 读库校验：会话 Cookie 缓存里的角色可能已过期，降级与封禁必须立即生效。 */
  async requireAdmin(userId: string): Promise<void> {
    const row = await this.findUser(userId);
    if (!row || row.role !== "admin" || row.banned)
      throw new AppError("FORBIDDEN", "需要管理员权限");
  }

  // ==================== 用户 ====================

  async listUsers(input: {
    query?: string;
    role?: "user" | "admin";
    banned?: boolean;
    limit: number;
    offset: number;
  }) {
    const where: Where[] = [];
    const query = input.query?.trim();
    if (query)
      where.push(
        /^\d+$/.test(query)
          ? { field: "qqNumber", operator: "starts_with", value: query }
          : { field: "name", operator: "contains", value: query }
      );
    if (input.role) where.push({ field: "role", value: input.role });
    if (input.banned !== undefined) where.push({ field: "banned", value: input.banned });
    const { internalAdapter } = await this.context();
    const [rows, total] = await Promise.all([
      internalAdapter.listUsers(
        input.limit,
        input.offset,
        { field: "createdAt", direction: "desc" },
        where
      ),
      internalAdapter.countTotalUsers(where),
    ]);
    const items = rows as unknown as UserRow[];
    const badges = await this.options.badges.badgesOfMany(items.map((row) => row.id));
    return {
      items: items.map((row) => toAdminUser(row, badges.get(row.id) ?? [])),
      total,
    };
  }

  async getUser(userId: string): Promise<AdminUserDetail> {
    const row = await this.requireUser(userId);
    const [games, feedback, badges] = await Promise.all([
      this.options.gameRecords.list({ userId, limit: 20, offset: 0 }),
      this.options.feedback.list({ userId, limit: 1, offset: 0 }),
      this.options.badges.badgesOf(row.id),
    ]);
    return {
      ...toAdminUser(row, badges),
      recentGames: games.items.map(toGameItem),
      feedbackCount: feedback.total,
    };
  }

  /** 不能对自己、也不能对其他管理员做封禁或降级：先在后台改角色，留下审计再处理。 */
  private async requireTarget(
    actorId: string,
    userId: string,
    selfMessage: string
  ): Promise<UserRow> {
    if (actorId === userId) throw new AppError("CANNOT_TARGET_SELF", selfMessage);
    return this.requireUser(userId);
  }

  async banUser(
    actorId: string,
    input: { userId: string; reason: string; expiresInHours?: number }
  ): Promise<AdminUser> {
    const row = await this.requireTarget(actorId, input.userId, "不能封禁自己");
    if (row.role === "admin")
      throw new AppError("CANNOT_TARGET_ADMIN", "不能封禁管理员，请先取消其管理员身份");
    const banExpires = input.expiresInHours
      ? new Date(this.now() + input.expiresInHours * 3_600_000)
      : null;
    await this.audit(actorId, "user.ban", "user", row.id, {
      reason: input.reason,
      expiresAt: banExpires?.toISOString() ?? null,
      name: row.name,
    });
    const { internalAdapter } = await this.context();
    const updated = await internalAdapter.updateUser(row.id, {
      banned: true,
      banReason: input.reason,
      banExpires,
    });
    await internalAdapter.deleteUserSessions(row.id);
    return this.adminUserOf(updated as unknown as UserRow);
  }

  async unbanUser(actorId: string, userId: string): Promise<AdminUser> {
    const row = await this.requireUser(userId);
    await this.audit(actorId, "user.unban", "user", row.id, { name: row.name });
    const updated = await (
      await this.context()
    ).internalAdapter.updateUser(row.id, { banned: false, banReason: null, banExpires: null });
    return this.adminUserOf(updated as unknown as UserRow);
  }

  async setRole(
    actorId: string,
    input: { userId: string; role: "user" | "admin" }
  ): Promise<AdminUser> {
    const row = await this.requireTarget(actorId, input.userId, "不能修改自己的角色");
    if (row.banned && input.role === "admin") throw new AppError("USER_BANNED", "请先解除封禁");
    await this.audit(actorId, "user.setRole", "user", row.id, {
      from: row.role ?? "user",
      to: input.role,
      name: row.name,
    });
    const updated = await (
      await this.context()
    ).internalAdapter.updateUser(row.id, { role: input.role });
    return this.adminUserOf(updated as unknown as UserRow);
  }

  async revokeSessions(actorId: string, userId: string): Promise<{ ok: true }> {
    const row = await this.requireUser(userId);
    await this.audit(actorId, "user.revokeSessions", "user", row.id, { name: row.name });
    await (await this.context()).internalAdapter.deleteUserSessions(row.id);
    return { ok: true };
  }

  /** 主理人由系统授予最高管理员，先行者由系统按注册顺序授予；后台只能手动管理贡献者。 */
  private requireManualBadge(badge: BadgeKind): void {
    if (badge === "owner") throw new AppError("FORBIDDEN", "主理人由系统自动授予最高管理员");
    if (badge === "pioneer") throw new AppError("FORBIDDEN", "先行者由系统按注册顺序自动授予");
  }

  /** 贡献者只由人授予；重复授予保持一枚，审计每次留痕。 */
  async grantBadge(
    actorId: string,
    input: { userId: string; badge: BadgeKind }
  ): Promise<{ ok: true }> {
    this.requireManualBadge(input.badge);
    const row = await this.requireUser(input.userId);
    await this.audit(actorId, "user.grantBadge", "user", row.id, {
      badge: input.badge,
      name: row.name,
    });
    await this.options.badges.grant(row.id, input.badge, actorId, new Date(this.now()));
    return { ok: true };
  }

  async revokeBadge(
    actorId: string,
    input: { userId: string; badge: BadgeKind }
  ): Promise<{ ok: true }> {
    this.requireManualBadge(input.badge);
    const row = await this.requireUser(input.userId);
    await this.audit(actorId, "user.revokeBadge", "user", row.id, {
      badge: input.badge,
      name: row.name,
    });
    await this.options.badges.revoke(row.id, input.badge);
    return { ok: true };
  }

  // ==================== 反馈 ====================

  private toAdminFeedback(record: FeedbackRecord, users: Map<string, UserRef>): AdminFeedback {
    return {
      id: record.id,
      kind: record.kind,
      title: record.title,
      status: record.status,
      createdAt: record.createdAt.toISOString(),
      lastReplyAt: record.lastReplyAt?.toISOString() ?? null,
      user: record.userId ? (users.get(record.userId) ?? null) : null,
      page: record.page,
      sentryEventId: record.sentryEventId,
    };
  }

  async listFeedback(input: {
    status?: FeedbackStatus;
    kind?: FeedbackKind;
    userId?: string;
    limit: number;
    offset: number;
  }) {
    const { items, total } = await this.options.feedback.list(input);
    const users = await this.usersById(items.map((item) => item.userId));
    return { items: items.map((item) => this.toAdminFeedback(item, users)), total };
  }

  async getFeedback(id: string): Promise<AdminFeedbackDetail> {
    const record = await this.options.feedback.get(id);
    if (!record) throw new AppError("NOT_FOUND", "反馈不存在");
    const replies = await this.options.feedback.replies(id);
    const users = await this.usersById([record.userId, ...replies.map((reply) => reply.authorId)]);
    return {
      ...this.toAdminFeedback(record, users),
      content: record.content,
      userAgent: record.userAgent,
      replies: replies.map((reply) => ({
        id: reply.id,
        content: reply.content,
        createdAt: reply.createdAt.toISOString(),
        author: reply.authorId ? (users.get(reply.authorId) ?? null) : null,
      })),
    };
  }

  async replyFeedback(
    actorId: string,
    input: { id: string; content: string }
  ): Promise<AdminFeedbackDetail> {
    const record = await this.options.feedback.get(input.id);
    if (!record) throw new AppError("NOT_FOUND", "反馈不存在");
    if (!record.userId) throw new AppError("BAD_REQUEST", "匿名反馈无法回复");
    const now = new Date(this.now());
    await this.audit(actorId, "feedback.reply", "feedback", record.id, {
      length: input.content.length,
    });
    await this.options.feedback.addReply({
      feedbackId: record.id,
      authorId: actorId,
      content: input.content,
      createdAt: now,
    });
    await this.options.feedback.update(record.id, {
      lastReplyAt: now,
      updatedAt: now,
      ...(record.status === "open" ? { status: "processing" as const } : {}),
    });
    return this.getFeedback(record.id);
  }

  async setFeedbackStatus(
    actorId: string,
    input: { id: string; status: FeedbackStatus }
  ): Promise<AdminFeedback> {
    const record = await this.options.feedback.get(input.id);
    if (!record) throw new AppError("NOT_FOUND", "反馈不存在");
    await this.audit(actorId, "feedback.setStatus", "feedback", record.id, {
      from: record.status,
      to: input.status,
    });
    await this.options.feedback.update(record.id, {
      status: input.status,
      updatedAt: new Date(this.now()),
    });
    const users = await this.usersById([record.userId]);
    return this.toAdminFeedback({ ...record, status: input.status }, users);
  }

  // ==================== 反作弊人工复核 ====================

  /**
   * 队列条目按人判：这里只把服务端算出来的特征原样摊开，附提交人的最小账号信息。
   * 没有排序选项、没有筛选之外的查询口——想绕过队列直接批量拉人不在设计里。
   */
  async listAntiCheatReviews(input: {
    status?: CEEAntiCheatReviewStatus;
    since?: number;
    limit: number;
    offset: number;
  }): Promise<{ items: AdminAntiCheatReview[]; total: number }> {
    const { items, total } = await this.options.reviews.list(input);
    const users = await this.usersById(items.map((item) => item.userId));
    return {
      total,
      items: items.map((item) => ({
        id: item.id,
        roomId: item.roomId,
        roundNumber: item.roundNumber,
        playerName: item.playerName,
        player: item.userId ? (users.get(item.userId) ?? null) : null,
        clientType: item.clientType,
        score: item.score,
        reasons: item.reasons,
        features: item.features,
        status: item.status,
        createdAt: new Date(item.recordedAt).toISOString(),
      })),
    };
  }

  /**
   * 单条条目的跨局视角：同一身份在近窗内的均值。
   * 只返回算术结果——不因为「跨局都高」就多写一条条目、也不改变任何处置。
   * 身份口径由存储决定：登录认 `userId`，游客只与其它同昵称的游客条目比。
   */
  async antiCheatReviewHistory(input: { id: string }): Promise<AdminAntiCheatAggregate> {
    const since = Date.now() - CEE_ANTI_CHEAT_AGGREGATE_WINDOW_MS;
    const items = await this.options.reviews.aggregateFor(input.id, since);
    return {
      windowDays: Math.round(CEE_ANTI_CHEAT_AGGREGATE_WINDOW_MS / 86_400_000),
      ...aggregateCEEAntiCheatReviews(items),
    };
  }

  /** 处置结果只是队列里的一个标记：这段代码不封号、不扣分，也不产生任何自动动作。 */
  async setAntiCheatReviewStatus(
    actorId: string,
    input: { id: string; status: CEEAntiCheatReviewStatus }
  ): Promise<{ ok: true }> {
    if (!(await this.options.reviews.exists(input.id)))
      throw new AppError("NOT_FOUND", "复核条目不存在");
    await this.audit(actorId, "antiCheat.setStatus", "antiCheatReview", input.id, {
      to: input.status,
    });
    await this.options.reviews.setStatus(input.id, input.status);
    return { ok: true as const };
  }

  // ==================== 实时房间 ====================

  listRooms(game?: RecordedGame): AdminRoom[] {
    const games = game ? [game] : (Object.keys(this.options.rooms) as RecordedGame[]);
    return games
      .flatMap((kind) => this.options.rooms[kind].adminListRooms())
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .map(toAdminRoom);
  }

  /** 审计记房名与人数快照：房间关闭后就查不到了。 */
  private requireRoom(game: RecordedGame, roomId: string): AdminRoomView {
    const room = this.options.rooms[game].adminListRooms().find((item) => item.roomId === roomId);
    if (!room) throw new AppError("ROOM_NOT_FOUND", "房间不存在或已关闭");
    return room;
  }

  async closeRoom(
    actorId: string,
    input: { game: RecordedGame; roomId: string }
  ): Promise<{ ok: true }> {
    const room = this.requireRoom(input.game, input.roomId);
    await this.audit(actorId, "room.close", "room", `${input.game}:${room.roomId}`, {
      name: room.name,
      phase: room.phase,
      players: room.players.map((player) => player.name),
    });
    await this.options.rooms[input.game].adminCloseRoom(room.roomId);
    return { ok: true };
  }

  async kickPlayer(
    actorId: string,
    input: { game: RecordedGame; roomId: string; playerId: string }
  ): Promise<{ ok: true }> {
    const room = this.requireRoom(input.game, input.roomId);
    const player = room.players.find((item) => item.id === input.playerId);
    if (!player) throw new AppError("PLAYER_NOT_FOUND", "玩家不在房间中");
    await this.audit(actorId, "room.kick", "room", `${input.game}:${room.roomId}`, {
      playerId: player.id,
      name: player.name,
      userId: player.userId,
    });
    await this.options.rooms[input.game].adminKickPlayer(room.roomId, player.id);
    return { ok: true };
  }

  // ==================== 运行期旋钮（T3） ====================

  /** 环境变量缺省、库内覆盖值与当前生效值一起给出；`updatedBy` 解析成管理员昵称。 */
  async listRuntimeSettings(): Promise<AdminRuntimeSetting[]> {
    const snapshot = this.options.settings.snapshot();
    const names = await this.usersById(snapshot.map((item) => item.updatedBy));
    return snapshot.map((item) => ({
      ...item,
      updatedBy: item.updatedBy ? (names.get(item.updatedBy)?.name ?? item.updatedBy) : null,
    }));
  }

  /**
   * 改一个旋钮：先过校验（取值与是否配了数据库），再写审计、后落库 ——
   * 与其余后台动作同一口径，被拒的请求不会留下一条没发生的审计。
   */
  async updateRuntimeSetting(
    actorId: string,
    input: { key: RuntimeSettingKey; value: string }
  ): Promise<AdminRuntimeSetting[]> {
    const value = this.options.settings.check(input.key, input.value);
    await this.audit(actorId, "runtimeSetting.update", "site", input.key, { value });
    await this.options.settings.update(input.key, value, actorId);
    return this.listRuntimeSettings();
  }

  // ==================== 状态页事件 ====================

  private requireStatusEvents(): StatusEventRepository {
    if (!this.options.statusEvents) throw new AppError("STATUS_EVENTS_DISABLED", "状态事件未启用");
    return this.options.statusEvents;
  }

  /** 事件的合法进度按类型收口：故障事件用事件档，维护窗口用维护档。 */
  private statusOfKind(kind: PublicStatusIncidentKind, status: PublicStatusEventStatus | undefined) {
    const allowed = kind === "incident" ? PUBLIC_STATUS_INCIDENT_STATUSES : PUBLIC_STATUS_MAINTENANCE_STATUSES;
    if (status !== undefined && !(allowed as readonly string[]).includes(status)) {
      throw new AppError(
        "BAD_REQUEST",
        kind === "incident" ? "故障事件不能使用维护窗口的进度" : "维护窗口不能使用故障事件的进度"
      );
    }
    return status ?? (kind === "incident" ? "investigating" : "scheduled");
  }

  /** 维护窗口必须有晚于开始时刻的计划结束；故障事件没有计划结束这个概念。 */
  private validateWindow(
    kind: PublicStatusIncidentKind,
    startedAt: number,
    plannedEndAt: number | null
  ): number | null {
    if (kind === "incident") return null;
    if (plannedEndAt === null || plannedEndAt <= startedAt)
      throw new AppError("BAD_REQUEST", "维护窗口需要晚于开始时刻的结束时间");
    return plannedEndAt;
  }

  async listStatusEvents(input: StatusEventFilter) {
    return this.requireStatusEvents().list(this.options.environment, input);
  }

  async createStatusEvent(
    actorId: string,
    input: Omit<StatusEventInput, "status" | "resolvedAt">
  ): Promise<PublicStatusEvent> {
    const repository = this.requireStatusEvents();
    const status = this.statusOfKind(input.kind, undefined);
    const plannedEndAt = this.validateWindow(input.kind, input.startedAt, input.plannedEndAt);
    await this.audit(actorId, "statusEvent.create", "statusEvent", input.kind, {
      title: input.title,
      components: input.components,
      startedAt: new Date(input.startedAt).toISOString(),
      plannedEndAt: plannedEndAt === null ? null : new Date(plannedEndAt).toISOString(),
    });
    return repository.create(this.options.environment, {
      ...input,
      plannedEndAt,
      status,
      resolvedAt: null,
    });
  }

  async updateStatusEvent(
    actorId: string,
    input: {
      id: number;
      title?: string;
      body?: string;
      status?: PublicStatusEventStatus;
      components?: PublicStatusComponentId[];
      startedAt?: number;
      plannedEndAt?: number | null;
    }
  ): Promise<PublicStatusEvent> {
    const repository = this.requireStatusEvents();
    const existing = await repository.get(this.options.environment, input.id);
    if (!existing) throw new AppError("NOT_FOUND", "状态事件不存在");

    // 状态推进与结束时刻同步：改成已恢复/已完成补上时刻，改回进行中清空，单独改正文不动它。
    let resolvedAt: number | null | undefined;
    if (input.status !== undefined) {
      const status = this.statusOfKind(existing.kind, input.status);
      if (status === "resolved" || status === "done") {
        resolvedAt = existing.resolvedAt ?? this.now();
      } else {
        resolvedAt = null;
      }
    }
    const startedAt = input.startedAt ?? existing.startedAt;
    const plannedEndAt = this.validateWindow(
      existing.kind,
      startedAt,
      input.plannedEndAt === undefined ? existing.plannedEndAt : input.plannedEndAt
    );
    const patch: StatusEventPatch = { ...input, plannedEndAt };
    if (resolvedAt !== undefined) patch.resolvedAt = resolvedAt;

    await this.audit(actorId, "statusEvent.update", "statusEvent", String(input.id), {
      from: existing.status,
      to: input.status ?? existing.status,
      title: input.title ?? existing.title,
    });
    return repository.update(this.options.environment, input.id, patch);
  }

  async deleteStatusEvent(actorId: string, id: number): Promise<{ ok: true }> {
    const repository = this.requireStatusEvents();
    const existing = await repository.get(this.options.environment, id);
    if (!existing) throw new AppError("NOT_FOUND", "状态事件不存在");
    await this.audit(actorId, "statusEvent.delete", "statusEvent", String(id), {
      title: existing.title,
      kind: existing.kind,
    });
    await repository.remove(this.options.environment, id);
    return { ok: true as const };
  }

  // ==================== 站点概览 ====================

  // ==================== QQ 昵称查询号 ====================

  private requireQq(): QQNicknameService {
    if (!this.options.qq) throw new AppError("QQ_LOOKUP_DISABLED", "QQ 昵称查询未启用");
    return this.options.qq;
  }

  qqStatus(): Promise<QQLookupStatus> {
    return this.requireQq().status();
  }

  async qqRefreshNames(
    actorId: string
  ): Promise<{ checked: number; updated: number; remaining: number }> {
    const qq = this.requireQq();
    await this.audit(actorId, "qq.refreshNames", "site", "qq.lookup");
    return qq.refreshAll();
  }

  async overview(days: number): Promise<AdminOverview> {
    const now = this.now();
    const dayList = Array.from({ length: days }, (_, index) =>
      beijingDay(now - (days - 1 - index) * 86_400_000)
    );
    const firstDay = dayList[0]!;
    // 北京时间当天 0 点对应的 UTC 时刻：库内时间一律 UTC。
    const startOf = (day: string) => new Date(`${day}T00:00:00+08:00`);
    const today = dayList.at(-1)!;
    const { internalAdapter } = await this.context();
    const [total, admins, banned, newToday, feedback, visits, pages, signups, games] =
      await Promise.all([
        internalAdapter.countTotalUsers([]),
        internalAdapter.countTotalUsers([{ field: "role", value: "admin" }]),
        internalAdapter.countTotalUsers([{ field: "banned", value: true }]),
        internalAdapter.countTotalUsers([
          { field: "createdAt", operator: "gte", value: startOf(today) },
        ]),
        this.options.feedback.countByStatus(),
        this.options.siteStats.daily(firstDay),
        this.options.siteStats.pages(firstDay, 20),
        this.options.siteStats.newUsers(startOf(firstDay)),
        this.options.gameRecords.dailyCounts(startOf(firstDay)),
      ]);
    const visitsByDay = new Map(visits.map((row) => [row.day, row]));
    const signupsByDay = new Map(signups.map((row) => [row.day, row.count]));
    const live = Object.fromEntries(
      RECORDED_GAMES.map((game) => {
        const rooms = this.options.rooms[game].adminListRooms();
        return [
          game,
          {
            rooms: rooms.length,
            onlinePlayers: rooms.reduce(
              (sum, room) =>
                sum + room.players.filter((player) => player.online && !player.bot).length,
              0
            ),
          },
        ];
      })
    ) as AdminOverview["live"];
    return {
      users: { total, admins, banned, newToday },
      feedback: {
        open: feedback.open ?? 0,
        processing: feedback.processing ?? 0,
        resolved: feedback.resolved ?? 0,
        closed: feedback.closed ?? 0,
      },
      live,
      daily: dayList.map((day) => {
        const dayGames = games.filter((row) => row.day === day);
        const gamesOf = (game: RecordedGame) =>
          dayGames.find((row) => row.game === game)?.games ?? 0;
        return {
          day,
          visitors: visitsByDay.get(day)?.visitors ?? 0,
          signedInVisitors: visitsByDay.get(day)?.signedInVisitors ?? 0,
          views: visitsByDay.get(day)?.views ?? 0,
          newUsers: signupsByDay.get(day) ?? 0,
          games: { faker: gamesOf("faker"), song: gamesOf("song"), cee: gamesOf("cee") },
          roundPlayers: dayGames.reduce((sum, row) => sum + row.players, 0),
        };
      }),
      pages,
    };
  }

  sentryOverview(): Promise<SentryOverview> {
    return this.options.sentry
      ? this.options.sentry.overview()
      : Promise.resolve(SENTRY_NOT_CONFIGURED);
  }

  // ==================== 对局记录与审计 ====================

  async listGames(input: {
    game?: RecordedGame;
    roomId?: string;
    userId?: string;
    limit: number;
    offset: number;
  }) {
    const { items, total } = await this.options.gameRecords.list(input);
    return { items: items.map(toGameItem), total };
  }

  async getGame(id: string): Promise<GameRecordDetail> {
    const record = await this.options.gameRecords.get(id);
    if (!record) throw new AppError("NOT_FOUND", "对局记录不存在");
    const { rounds, ...item } = record;
    return {
      ...toGameItem(item),
      rounds: rounds.map((round) => ({
        number: round.number,
        startedAt: round.startedAt.toISOString(),
        endedAt: round.endedAt.toISOString(),
        players: round.players,
        summary: round.summary,
      })),
      // 回放视角：全房一条时间线，按时间合并各回合事件并带上回合号。
      timeline: capTimeline(
        rounds
          .flatMap((round) => round.timeline.map((event) => ({ ...event, round: round.number })))
          .sort((left, right) => left.at - right.at),
        GAME_DETAIL_TIMELINE_MAX_BYTES
      ),
    };
  }

  async listAudit(input: {
    actorId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    limit: number;
    offset: number;
  }) {
    const { items, total } = await this.options.audit.list(input);
    const users = await this.usersById(items.map((item) => item.actorId));
    return {
      items: items.map((item): AuditEntry => ({
        id: item.id,
        actor: item.actorId ? (users.get(item.actorId) ?? null) : null,
        action: item.action,
        targetType: item.targetType,
        targetId: item.targetId,
        detail: item.detail,
        createdAt: item.createdAt.toISOString(),
      })),
      total,
    };
  }
}
