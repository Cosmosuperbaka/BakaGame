import type { Where } from "better-auth";

import type { AdminRoomControl, AdminRoomView } from "../domain/AdminRoom";
import { AppError } from "../domain/Errors";
import { beijingDay } from "./SiteStatsService";
import { GAME_RECORD_RETENTION_MS } from "./GameRecordService";
import { RECORDED_GAMES } from "../domain/GameRecord";
import type { SiteStatsRepository } from "../infrastructure/db/SiteStatsRepository";
import { SENTRY_NOT_CONFIGURED, type SentryApiClient } from "../infrastructure/SentryApi";
import type { RecordedGame } from "../domain/GameRecord";
import type { Auth } from "../infrastructure/auth/Auth";
import type { AuditLogRepository } from "../infrastructure/db/AuditLogRepository";
import type { GameRecordListItem, GameRecordRepository } from "../infrastructure/db/GameRecordRepository";
import type { FeedbackRecord, FeedbackRepository } from "../infrastructure/db/UserDataRepository";
import { normalizeAccountName } from "../shared/Account";
import type {
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
}

type UserRef = { id: string; name: string; qqNumber: string; image: string | null };

export interface AdminServiceOptions {
  auth: Auth;
  feedback: FeedbackRepository;
  gameRecords: GameRecordRepository;
  audit: AuditLogRepository;
  /** 三款游戏的实时房间控制口；房间不落库，后台只经由它们读写。 */
  rooms: Record<RecordedGame, AdminRoomControl>;
  siteStats: SiteStatsRepository;
  /** 未配置 `SENTRY_API_TOKEN` 时为 null，概览展示未配置。 */
  sentry: SentryApiClient | null;
  now?: () => number;
}

const toAdminUser = (row: UserRow): AdminUser => ({
  id: row.id,
  name: row.name,
  qqNumber: row.qqNumber,
  image: row.image ?? null,
  role: row.role === "admin" ? "admin" : "user",
  banned: Boolean(row.banned),
  banReason: row.banned ? row.banReason ?? null : null,
  banExpires: row.banned && row.banExpires ? new Date(row.banExpires).toISOString() : null,
  showQq: Boolean(row.showQq),
  createdAt: new Date(row.createdAt).toISOString(),
});

const toRef = (row: UserRow): UserRef => ({ id: row.id, name: row.name, qqNumber: row.qqNumber, image: row.image ?? null });

const toAdminRoom = (room: AdminRoomView): AdminRoom => ({
  ...room,
  createdAt: new Date(room.createdAt).toISOString(),
  lastActiveAt: new Date(room.lastActiveAt).toISOString(),
});

const toGameItem = (record: GameRecordListItem): GameRecordItem => ({
  id: record.id,
  game: record.game,
  roomId: record.roomId,
  roundNumber: record.roundNumber,
  startedAt: record.startedAt.toISOString(),
  endedAt: record.endedAt.toISOString(),
  players: record.players,
});

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

  private async usersById(ids: Array<string | null>): Promise<Map<string, UserRef>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map();
    const { adapter } = await this.context();
    const rows = await adapter.findMany<UserRow>({ model: "user", where: [{ field: "id", operator: "in", value: unique }], limit: unique.length });
    return new Map(rows.map((row) => [row.id, toRef(row)]));
  }

  private async audit(actorId: string, action: string, targetType: string, targetId: string, detail?: Record<string, unknown>) {
    await this.options.audit.append({ actorId, action, targetType, targetId, detail: detail ?? null, createdAt: new Date(this.now()) });
  }

  /** 按 ID 读库校验：会话 Cookie 缓存里的角色可能已过期，降级与封禁必须立即生效。 */
  async requireAdmin(userId: string): Promise<void> {
    const row = await this.findUser(userId);
    if (!row || row.role !== "admin" || row.banned) throw new AppError("FORBIDDEN", "需要管理员权限");
  }

  // ==================== 用户 ====================

  async listUsers(input: { query?: string; role?: "user" | "admin"; banned?: boolean; limit: number; offset: number }) {
    const where: Where[] = [];
    const query = input.query?.trim();
    if (query) where.push(/^\d+$/.test(query)
      ? { field: "qqNumber", operator: "starts_with", value: query }
      : { field: "name", operator: "contains", value: query });
    if (input.role) where.push({ field: "role", value: input.role });
    if (input.banned !== undefined) where.push({ field: "banned", value: input.banned });
    const { internalAdapter } = await this.context();
    const [rows, total] = await Promise.all([
      internalAdapter.listUsers(input.limit, input.offset, { field: "createdAt", direction: "desc" }, where),
      internalAdapter.countTotalUsers(where),
    ]);
    return { items: (rows as unknown as UserRow[]).map(toAdminUser), total };
  }

  async getUser(userId: string): Promise<AdminUserDetail> {
    const row = await this.requireUser(userId);
    const [games, feedback] = await Promise.all([
      this.options.gameRecords.list({ userId, limit: 20, offset: 0 }),
      this.options.feedback.list({ userId, limit: 1, offset: 0 }),
    ]);
    return { ...toAdminUser(row), recentGames: games.items.map(toGameItem), feedbackCount: feedback.total };
  }

  /** 不能对自己、也不能对其他管理员做封禁或降级：先在后台改角色，留下审计再处理。 */
  private async requireTarget(actorId: string, userId: string, selfMessage: string): Promise<UserRow> {
    if (actorId === userId) throw new AppError("CANNOT_TARGET_SELF", selfMessage);
    return this.requireUser(userId);
  }

  async banUser(actorId: string, input: { userId: string; reason: string; expiresInHours?: number }): Promise<AdminUser> {
    const row = await this.requireTarget(actorId, input.userId, "不能封禁自己");
    if (row.role === "admin") throw new AppError("CANNOT_TARGET_ADMIN", "不能封禁管理员，请先取消其管理员身份");
    const banExpires = input.expiresInHours ? new Date(this.now() + input.expiresInHours * 3_600_000) : null;
    await this.audit(actorId, "user.ban", "user", row.id, {
      reason: input.reason, expiresAt: banExpires?.toISOString() ?? null, name: row.name,
    });
    const { internalAdapter } = await this.context();
    const updated = await internalAdapter.updateUser(row.id, { banned: true, banReason: input.reason, banExpires });
    await internalAdapter.deleteUserSessions(row.id);
    return toAdminUser(updated as unknown as UserRow);
  }

  async unbanUser(actorId: string, userId: string): Promise<AdminUser> {
    const row = await this.requireUser(userId);
    await this.audit(actorId, "user.unban", "user", row.id, { name: row.name });
    const updated = await (await this.context()).internalAdapter.updateUser(row.id, { banned: false, banReason: null, banExpires: null });
    return toAdminUser(updated as unknown as UserRow);
  }

  async setRole(actorId: string, input: { userId: string; role: "user" | "admin" }): Promise<AdminUser> {
    const row = await this.requireTarget(actorId, input.userId, "不能修改自己的角色");
    if (row.banned && input.role === "admin") throw new AppError("USER_BANNED", "请先解除封禁");
    await this.audit(actorId, "user.setRole", "user", row.id, { from: row.role ?? "user", to: input.role, name: row.name });
    const updated = await (await this.context()).internalAdapter.updateUser(row.id, { role: input.role });
    return toAdminUser(updated as unknown as UserRow);
  }

  async revokeSessions(actorId: string, userId: string): Promise<{ ok: true }> {
    const row = await this.requireUser(userId);
    await this.audit(actorId, "user.revokeSessions", "user", row.id, { name: row.name });
    await (await this.context()).internalAdapter.deleteUserSessions(row.id);
    return { ok: true };
  }

  async renameUser(actorId: string, input: { userId: string; name: string }): Promise<AdminUser> {
    const row = await this.requireUser(input.userId);
    const name = normalizeAccountName(input.name);
    if (!name) throw new AppError("ACCOUNT_NAME_REQUIRED", "请填写账号昵称");
    await this.audit(actorId, "user.rename", "user", row.id, { from: row.name, to: name });
    const updated = await (await this.context()).internalAdapter.updateUser(row.id, { name });
    return toAdminUser(updated as unknown as UserRow);
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
      user: users.get(record.userId) ?? null,
      page: record.page,
      sentryEventId: record.sentryEventId,
    };
  }

  async listFeedback(input: { status?: FeedbackStatus; kind?: FeedbackKind; userId?: string; limit: number; offset: number }) {
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
        author: reply.authorId ? users.get(reply.authorId) ?? null : null,
      })),
    };
  }

  async replyFeedback(actorId: string, input: { id: string; content: string }): Promise<AdminFeedbackDetail> {
    const record = await this.options.feedback.get(input.id);
    if (!record) throw new AppError("NOT_FOUND", "反馈不存在");
    const now = new Date(this.now());
    await this.audit(actorId, "feedback.reply", "feedback", record.id, { length: input.content.length });
    await this.options.feedback.addReply({ feedbackId: record.id, authorId: actorId, content: input.content, createdAt: now });
    await this.options.feedback.update(record.id, {
      lastReplyAt: now,
      updatedAt: now,
      ...(record.status === "open" ? { status: "processing" as const } : {}),
    });
    return this.getFeedback(record.id);
  }

  async setFeedbackStatus(actorId: string, input: { id: string; status: FeedbackStatus }): Promise<AdminFeedback> {
    const record = await this.options.feedback.get(input.id);
    if (!record) throw new AppError("NOT_FOUND", "反馈不存在");
    await this.audit(actorId, "feedback.setStatus", "feedback", record.id, { from: record.status, to: input.status });
    await this.options.feedback.update(record.id, { status: input.status, updatedAt: new Date(this.now()) });
    const users = await this.usersById([record.userId]);
    return this.toAdminFeedback({ ...record, status: input.status }, users);
  }

  // ==================== 实时房间 ====================

  listRooms(game?: RecordedGame): AdminRoom[] {
    const games = game ? [game] : (Object.keys(this.options.rooms) as RecordedGame[]);
    return games.flatMap((kind) => this.options.rooms[kind].adminListRooms())
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .map(toAdminRoom);
  }

  /** 审计记房名与人数快照：房间关闭后就查不到了。 */
  private requireRoom(game: RecordedGame, roomId: string): AdminRoomView {
    const room = this.options.rooms[game].adminListRooms().find((item) => item.roomId === roomId);
    if (!room) throw new AppError("ROOM_NOT_FOUND", "房间不存在或已关闭");
    return room;
  }

  async closeRoom(actorId: string, input: { game: RecordedGame; roomId: string }): Promise<{ ok: true }> {
    const room = this.requireRoom(input.game, input.roomId);
    await this.audit(actorId, "room.close", "room", `${input.game}:${room.roomId}`, {
      name: room.name, phase: room.phase, players: room.players.map((player) => player.name),
    });
    await this.options.rooms[input.game].adminCloseRoom(room.roomId);
    return { ok: true };
  }

  async kickPlayer(actorId: string, input: { game: RecordedGame; roomId: string; playerId: string }): Promise<{ ok: true }> {
    const room = this.requireRoom(input.game, input.roomId);
    const player = room.players.find((item) => item.id === input.playerId);
    if (!player) throw new AppError("PLAYER_NOT_FOUND", "玩家不在房间中");
    await this.audit(actorId, "room.kick", "room", `${input.game}:${room.roomId}`, {
      playerId: player.id, name: player.name, userId: player.userId,
    });
    await this.options.rooms[input.game].adminKickPlayer(room.roomId, player.id);
    return { ok: true };
  }

  // ==================== 站点概览 ====================

  async overview(days: number): Promise<AdminOverview> {
    const now = this.now();
    const dayList = Array.from({ length: days }, (_, index) => beijingDay(now - (days - 1 - index) * 86_400_000));
    const firstDay = dayList[0]!;
    // 北京时间当天 0 点对应的 UTC 时刻：库内时间一律 UTC。
    const startOf = (day: string) => new Date(`${day}T00:00:00+08:00`);
    const today = dayList.at(-1)!;
    const { internalAdapter } = await this.context();
    const [total, admins, banned, newToday, feedback, visits, pages, signups, games] = await Promise.all([
      internalAdapter.countTotalUsers([]),
      internalAdapter.countTotalUsers([{ field: "role", value: "admin" }]),
      internalAdapter.countTotalUsers([{ field: "banned", value: true }]),
      internalAdapter.countTotalUsers([{ field: "createdAt", operator: "gte", value: startOf(today) }]),
      this.options.feedback.countByStatus(),
      this.options.siteStats.daily(firstDay),
      this.options.siteStats.pages(firstDay, 20),
      this.options.siteStats.newUsers(startOf(firstDay)),
      this.options.gameRecords.dailyCounts(startOf(firstDay)),
    ]);
    const visitsByDay = new Map(visits.map((row) => [row.day, row]));
    const signupsByDay = new Map(signups.map((row) => [row.day, row.count]));
    const live = Object.fromEntries(RECORDED_GAMES.map((game) => {
      const rooms = this.options.rooms[game].adminListRooms();
      return [game, {
        rooms: rooms.length,
        onlinePlayers: rooms.reduce((sum, room) => sum + room.players.filter((player) => player.online && !player.bot).length, 0),
      }];
    })) as AdminOverview["live"];
    return {
      users: { total, admins, banned, newToday },
      feedback: {
        open: feedback.open ?? 0, processing: feedback.processing ?? 0, resolved: feedback.resolved ?? 0, closed: feedback.closed ?? 0,
      },
      live,
      daily: dayList.map((day) => {
        const dayGames = games.filter((row) => row.day === day);
        const roundsOf = (game: RecordedGame) => dayGames.find((row) => row.game === game)?.rounds ?? 0;
        return {
          day,
          visitors: visitsByDay.get(day)?.visitors ?? 0,
          signedInVisitors: visitsByDay.get(day)?.signedInVisitors ?? 0,
          views: visitsByDay.get(day)?.views ?? 0,
          newUsers: signupsByDay.get(day) ?? 0,
          rounds: { faker: roundsOf("faker"), song: roundsOf("song"), ccb: roundsOf("ccb") },
          roundPlayers: dayGames.reduce((sum, row) => sum + row.players, 0),
        };
      }),
      pages,
      gameRecordDays: GAME_RECORD_RETENTION_MS / 86_400_000,
    };
  }

  sentryOverview(): Promise<SentryOverview> {
    return this.options.sentry ? this.options.sentry.overview() : Promise.resolve(SENTRY_NOT_CONFIGURED);
  }

  // ==================== 对局记录与审计 ====================

  async listGames(input: { game?: RecordedGame; roomId?: string; userId?: string; limit: number; offset: number }) {
    const { items, total } = await this.options.gameRecords.list(input);
    return { items: items.map(toGameItem), total };
  }

  async getGame(id: string): Promise<GameRecordDetail> {
    const record = await this.options.gameRecords.get(id);
    if (!record) throw new AppError("NOT_FOUND", "对局记录不存在或已过期");
    return { ...toGameItem(record), summary: record.summary, timeline: record.timeline };
  }

  async listAudit(input: { actorId?: string; action?: string; targetType?: string; targetId?: string; limit: number; offset: number }) {
    const { items, total } = await this.options.audit.list(input);
    const users = await this.usersById(items.map((item) => item.actorId));
    return {
      items: items.map((item): AuditEntry => ({
        id: item.id,
        actor: item.actorId ? users.get(item.actorId) ?? null : null,
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
