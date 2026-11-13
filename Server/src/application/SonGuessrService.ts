import { isAudioTicketMatch } from "./songuessr/AudioTicket";
import { clearMusicSession } from "./songuessr/MusicAuth";
import { scheduleMusicSessionRefresh } from "./songuessr/MusicSessionRefresh";
import { normalizeAnimeAutoFilters, normalizeAutoFilters } from "./songuessr/AutomaticRounds";
import {
  COMMAND_RATE_LIMIT_PER_CONNECTION,
  COMMAND_RATE_LIMIT_WINDOW_MS,
  ROOM_EXPIRING_WARNING_MS,
} from "../config/Constants";
import { ADMIN_CLOSE_REASON, AdminRoomView } from "../domain/AdminRoom";
import type { GameService } from "./GameService";
import { AppError } from "../domain/Errors";
import { assertTextAllowed } from "../infrastructure/SensitiveText";
import { normalizeWord } from "../domain/Rules";
import {
  SERVER_SHUTDOWN_MESSAGE,
  SONGUESSR_MAX_TEAM,
  SonGuessrClientMessage,
  SonGuessrRoomSummary,
  type ConnectionRecord,
} from "../shared/Index";
import { type SnapshottedRoom } from "../shared/RoomSnapshot";
import { describeError } from "../infrastructure/EventLogger";
import type { SonGuessrServiceOptions } from "./songuessr/Options";
import {
  createSonGuessrContext,
  normalizeRoomPassword,
  publishRoomCalibration,
  type SonGuessrContext,
} from "./songuessr/Context";
import { listRoomSummaries } from "./songuessr/RoomViews";
import { type SongCommandAt, isTestRoom, requireRoomPlayer } from "./songuessr/RoomAccess";
import { isRoomStarting, releasePendingSubmitter } from "./songuessr/RoundFlow";
import { settlePlayingRound } from "./songuessr/RoundEngine";
import { createSonGuessrCommands, type SonGuessrDispatcher } from "./songuessr/Commands";
import { CommandQuota, dispatchCommand } from "./room/CommandTable";
import { broadcastRoomEvent } from "./songuessr/Chat";
import { closeRoom } from "./songuessr/RoomClosure";
import {
  adminKickPlayer,
  disconnectSeat,
  reassignRemovedHost,
  settleHostChange,
} from "./songuessr/Membership";
import { exportSnapshots, restoreSnapshots } from "./songuessr/SnapshotCodec";

import { resolveHostGrace } from "./room/HostPolicy";
import { adminRoomView, countOnline, requireAdminRoom } from "./room/RoomSummaries";
import {
  expiredOfflineSeats,
  forEachRoomIsolated,
  isIdleWarningDue,
  judgeReclaim,
  markIdleWarningSent,
} from "./room/RoomJanitor";
import { assertTabAgentsAllowed, roomsOfTab } from "./room/SeatBinding";
import { musicIpScope } from "../infrastructure/music/MusicIpScope";
import { createEvent } from "../transport/Packets";
import { SonGuessrRoomRecord, SongUpdateSettingsPayload, cloneSettings } from "./songuessr/Records";

/** 巡检的房间回收结论：`skip` 整间跳过、`grace` 已补校准并跳过、`keep` 继续后续阶段。 */
type RoomReclaim = "skip" | "grace" | "keep";

export class SonGuessrService implements GameService<SonGuessrClientMessage> {
  readonly ctx: SonGuessrContext;
  private readonly dispatcher: SonGuessrDispatcher;
  /** 每连接的命令总额度：任何命令都先扣它，音乐、封面与登录的按成本配额在它之后。 */
  private readonly commandQuota: CommandQuota;

  constructor(readonly options: SonGuessrServiceOptions) {
    this.ctx = createSonGuessrContext(options);
    const { ctx } = this;
    this.commandQuota = new CommandQuota({
      now: () => ctx.now(),
      windowMs: COMMAND_RATE_LIMIT_WINDOW_MS,
      maxRequests: COMMAND_RATE_LIMIT_PER_CONNECTION,
    });
    this.dispatcher = {
      table: createSonGuessrCommands(ctx),
      deps: {
        ctx,
        handlers: this,
      },
      resolveSeat: (connection) => {
        const { room, player } = requireRoomPlayer(ctx, connection);
        return { room, seat: player };
      },
      isRoomRegistered: (room) => ctx.rooms.get(room.id) === room,
      isSeated: (room, seat) => room.players[seat.id] === seat,
      hostIdOf: (room) => room.hostPlayerId,
      phaseOf: (room) => room.phase,
    };
  }

  /** 房间表：测试直接读它，写入只走命令与巡检。 */
  get rooms(): Map<string, SonGuessrRoomRecord> {
    return this.ctx.rooms;
  }

  /**
   * 站内播放地址的跳转目标：按房号与票据取当前回合保存在服务端的上游地址。
   * 房间不在、没有进行中的回合、票据不符都返回 undefined，调用方不得把三者区分开来回给客户端。
   * 目标只来自回合记录，不接受任何请求里的地址。
   */
  resolveAudioRedirect(roomId: string, ticket: string): string | undefined {
    const round = this.ctx.rooms.get(roomId)?.currentRound;
    if (!round || !isAudioTicketMatch(ticket, round.audioTicket)) return undefined;
    return round.song.audioUrl || undefined;
  }

  getRoomSummaries(): SonGuessrRoomSummary[] {
    return listRoomSummaries(this.ctx);
  }

  registerConnection(connection: ConnectionRecord): void {
    this.ctx.connections.registerConnection(connection);
  }

  getHealthSnapshot() {
    return {
      roomCount: this.ctx.rooms.size,
      connectionCount: this.ctx.connections.stats.totalConnections,
      onlinePlayerCount: [...this.ctx.rooms.values()].reduce(
        (sum, room) => sum + countOnline(Object.values(room.players)),
        0
      ),
    };
  }

  notifyShutdown(): void {
    this.ctx.connections.broadcastToAll(
      createEvent("server.shutdown", {
        message: SERVER_SHUTDOWN_MESSAGE,
      })
    );
  }

  /** 导出全部房间以供停机保存；两类字段不落盘的理由见快照编解码模块。 */
  exportSnapshots(): SnapshottedRoom[] {
    return exportSnapshots(this.ctx);
  }

  /** 从快照恢复房间，返回真正恢复的房间数。 */
  restoreSnapshots(rooms: readonly SnapshottedRoom[], savedAt: number): number {
    return restoreSnapshots(this.ctx, rooms, savedAt);
  }

  async unregisterConnection(connectionId: string): Promise<void> {
    return disconnectSeat(this.ctx, connectionId);
  }

  async execute(connectionId: string, message: SonGuessrClientMessage): Promise<unknown> {
    const connection = this.ctx.connections.getConnection(connectionId);
    // 总额度排在一切之前，与卧底、猜猜呗同一个窗口与额度。
    this.commandQuota.consume(connection);
    // 玩家级伪装 IP 归属：同一连接的匿名请求复用同一个 CN IP，不同玩家各持一个，
    // 避免全服匿名请求共享同一份网易云限流配额（见 NeteaseMusicProvider 的 musicIpScope）。
    // 作用域只能在最外层建立，下游 provider 才可能在任意调用深度读到玩家身份。
    return musicIpScope.run(`player:${connectionId}`, async () =>
      dispatchCommand(this.dispatcher, connection, message)
    );
  }

  async runHousekeeping(): Promise<void> {
    const currentTime = this.ctx.now();
    await forEachRoomIsolated(
      this.ctx.rooms,
      (room) => this.sweepRoom(room, currentTime),
      (room, error) =>
        this.options.eventLogger?.warn("猜歌房间巡检失败，已跳过该房间", {
          roomId: room.id,
          ...describeError(error),
        })
    );
    scheduleMusicSessionRefresh(this.ctx, currentTime);
  }

  /** 单间房的巡检：回收判定之后才做离线清理、房主改选与回合推进。 */
  private sweepRoom(room: SonGuessrRoomRecord, currentTime: number): void {
    if (this.reclaimIdleRoom(room, currentTime) !== "keep") return;
    this.cleanupOfflinePlayers(room, currentTime);
    this.resolveHost(room, currentTime);
    this.expirePendingSubmitter(room, currentTime);
    settlePlayingRound(this.ctx, room, currentTime);
    publishRoomCalibration(this.ctx, room);
  }

  /**
   * 无人房间与空闲房间的回收：测试房间只豁免「无人立即回收」，仍受空闲超时约束，
   * 无人房间先给一段宽限期，宽限期内只补一次校准便跳过其余巡检阶段。
   * 闲置关房前提前一段时间预警：每一段闲置只预警一次，有新活动后重新计。
   */
  private reclaimIdleRoom(room: SonGuessrRoomRecord, currentTime: number): RoomReclaim {
    const onlineCount = countOnline(Object.values(room.players));
    const emptyRoomExempt = isTestRoom(this.ctx, room);
    if (isIdleWarningDue(room, onlineCount, currentTime, ROOM_EXPIRING_WARNING_MS)) {
      markIdleWarningSent(room);
      broadcastRoomEvent(this.ctx, room, "song.room.expiring", { roomId: room.id, idle: true });
    }
    const verdict = judgeReclaim(room, onlineCount, currentTime, { emptyRoomExempt });
    switch (verdict) {
      case "grace":
        publishRoomCalibration(this.ctx, room);
        return "grace";
      case "close-empty":
      case "close-idle":
        closeRoom(this.ctx, room, onlineCount === 0 ? "empty" : "idle_timeout");
        return "skip";
      case "keep":
        // 测试房常态就是一间等人加入的空房：没人时不推进任何巡检阶段。
        return emptyRoomExempt && onlineCount === 0 ? "skip" : "keep";
    }
  }

  /** 清理离线超过保留时长的真人玩家；被清掉的是房主时先移交，房间空了立即回收。 */
  private cleanupOfflinePlayers(room: SonGuessrRoomRecord, currentTime: number): void {
    for (const player of expiredOfflineSeats(room, Object.values(room.players), currentTime)) {
      delete room.players[player.id];
      // 掉线超过宽限：人和他贡献的号一起清出房间（宽限内号仍在，房主面板也能看到）。
      clearMusicSession(this.ctx, room, player.id);
      if (room.hostPlayerId === player.id) reassignRemovedHost(room);
      this.ctx.touch(room);
      if (countOnline(Object.values(room.players)) === 0 && !isTestRoom(this.ctx, room)) {
        closeRoom(this.ctx, room, "empty");
      } else {
        this.ctx.publishRoom(room);
        this.ctx.publishLobby();
      }
    }
  }

  /** 出题时限到点：退回选出题人阶段并在房间公告里说明，免得全房以为页面自己跳回去了。 */
  private expirePendingSubmitter(room: SonGuessrRoomRecord, currentTime: number): void {
    const playerId = room.pendingSubmitterPlayerId;
    if (room.phase !== "submittingSong" || !playerId) return;
    const deadlineAt = room.pendingSubmitterDeadlineAt;
    if (deadlineAt === undefined || currentTime < deadlineAt) return;
    const submitter = room.players[playerId];
    const target = room.settings.questionType === "anime" ? "番剧" : "歌曲";
    releasePendingSubmitter(
      this.ctx,
      room,
      playerId,
      `${submitter ? `出题人 ${submitter.name}` : "出题人"} 没有在时限内选好${target}，请重新指定出题人`
    );
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
  }

  requestSync({ connection, room }: SongCommandAt) {
    connection.resetStateSync?.();
    this.ctx.publishRoom(room, connection);
    return { synced: true };
  }

  setReady(at: SongCommandAt, ready: boolean) {
    const { room, seat: player } = at;
    player.isReady = player.id === room.hostPlayerId ? true : ready;
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    return { ready: player.isReady };
  }

  setSpectator(at: SongCommandAt, spectator: boolean) {
    const { room, seat: player } = at;
    if (room.phase !== "waiting") {
      const targetMembership = spectator ? "spectator" : "active";
      if (targetMembership === "spectator" && !room.allowSpectators) {
        throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
      }
      // 再次点击同个预约选项时撤销预约
      if (player.nextRoundMembership === targetMembership) {
        player.nextRoundMembership = undefined;
        this.ctx.touch(room);
        this.ctx.publishRoom(room);
        return { spectator: player.membership === "spectator", queued: false };
      }
      player.nextRoundMembership = targetMembership;
      this.ctx.touch(room);
      this.ctx.publishRoom(room);
      return { spectator, queued: true };
    }
    const nextMembership = spectator ? "spectator" : "active";
    player.nextRoundMembership = undefined;
    if (player.membership === nextMembership) return { spectator, queued: false };
    if (spectator) {
      if (!room.allowSpectators) throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
      player.membership = "spectator";
      player.isReady = false;
      // 旁观者没有队伍：回到玩家组时从个人游玩开始。
      player.team = null;
    } else {
      player.membership = "active";
      player.isReady = player.id === room.hostPlayerId;
    }
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
    return { spectator, queued: false };
  }

  /** 选队伍：只在等待阶段、只给参与玩家，与 CEE 的 `cee.player.team` 同口径。准备状态保留。 */
  setTeam(at: SongCommandAt, team: number | null) {
    const { room, seat: player } = at;
    if (team !== null && (!Number.isInteger(team) || team < 1 || team > SONGUESSR_MAX_TEAM)) {
      throw new AppError("INVALID_TEAM", `队伍号只能是 1–${SONGUESSR_MAX_TEAM}`);
    }
    player.team = team;
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    return { team };
  }

  async updateSettings(at: SongCommandAt, payload: SongUpdateSettingsPayload) {
    const { room } = at;
    const next = { ...room, settings: cloneSettings(room.settings) };
    await this.applyRoomAdmission(next, payload);
    // 口令摘要要跨 await：期间房间可能已开局或关闭，回来先复核再整块覆盖。
    this.assertSettingsEditable(room);
    this.applyRoundSettings(next, room.solo, payload);

    room.name = next.name;
    room.visibility = next.visibility;
    room.passwordHash = next.passwordHash;
    room.allowSpectators = next.allowSpectators;
    room.settings = next.settings;
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
    return { settings: room.settings };
  }

  /**
   * 设置只在「等待且没有开局在途」时可改。开局加载期间阶段仍是 waiting，
   * 只看阶段会放过题型或出题方式的改动，让回合按旧条件选歌却克隆新设置。
   * 这里是跨 await 回来后的复核；入口处的同一判定由命令表的守卫承担。
   */
  private assertSettingsEditable(room: SonGuessrRoomRecord) {
    if (this.ctx.rooms.get(room.id) !== room) throw new AppError("ROOM_NOT_FOUND", "房间已经关闭");
    if (room.phase !== "waiting" || isRoomStarting(room)) {
      throw new AppError("INVALID_PHASE", "只能在等待阶段修改房间设置");
    }
  }

  /** 先算出公开/私密的密码归属再校验，校验失败时 room 上还没有任何写入。 */
  private async applyRoomAdmission(
    next: Pick<SonGuessrRoomRecord, "name" | "visibility" | "passwordHash" | "allowSpectators">,
    payload: SongUpdateSettingsPayload
  ) {
    if (payload.name !== undefined) {
      assertTextAllowed(payload.name);
      next.name = normalizeWord(payload.name) || next.name;
    }
    if (payload.visibility !== undefined) next.visibility = payload.visibility;
    if (payload.allowSpectators !== undefined) next.allowSpectators = payload.allowSpectators;
    if (payload.visibility === "public") next.passwordHash = undefined;
    // 留空保留原口令，给了新值才换摘要：明文只在这段局部变量里存在一次。
    const password = normalizeRoomPassword(payload.password ?? "");
    if (next.visibility === "private" && password) {
      next.passwordHash = await this.ctx.passwords.hash(password);
    }
    if (next.visibility === "private" && !next.passwordHash) {
      throw new AppError("PASSWORD_REQUIRED", "私密房间需要密码");
    }
  }

  /** 单人房固定由系统出题，不提供手动出题与轮流出题。 */
  private applyRoundSettings(
    next: Pick<SonGuessrRoomRecord, "settings">,
    solo: boolean,
    payload: SongUpdateSettingsPayload
  ) {
    const { settings } = next;
    if (payload.questionType !== undefined) settings.questionType = payload.questionType;
    if (!solo && payload.questionMode !== undefined) settings.questionMode = payload.questionMode;
    if (!solo && payload.autoRotateSubmitter !== undefined) {
      settings.autoRotateSubmitter = payload.autoRotateSubmitter;
    }
    if (!solo && payload.allowCustomClip !== undefined) {
      settings.allowCustomClip = payload.allowCustomClip;
    }
    if (payload.autoFilters !== undefined)
      settings.autoFilters = normalizeAutoFilters(this.ctx, payload.autoFilters);
    if (payload.animeAutoFilters !== undefined) {
      settings.animeAutoFilters = normalizeAnimeAutoFilters(payload.animeAutoFilters);
    }
    if (payload.lyricsLineCount !== undefined) settings.lyricsLineCount = payload.lyricsLineCount;
    if (payload.showLyrics !== undefined) settings.showLyrics = payload.showLyrics;
    if (payload.maxGuessesPerRound !== undefined) {
      settings.maxGuessesPerRound = payload.maxGuessesPerRound;
    }
    if (payload.guessDurationSeconds !== undefined) {
      settings.guessDurationSeconds = payload.guessDurationSeconds;
    }
    if (payload.showGuessTimer !== undefined) settings.showGuessTimer = payload.showGuessTimer;
    if (payload.bloodMode !== undefined) settings.bloodMode = payload.bloodMode;
    if (payload.allowAgents !== undefined) settings.allowAgents = payload.allowAgents;
    if (payload.spectatorsSeeAnswers !== undefined) {
      settings.spectatorsSeeAnswers = payload.spectatorsSeeAnswers;
    }
  }

  adminListRooms(): AdminRoomView[] {
    return [...this.ctx.rooms.values()].map((room) =>
      adminRoomView(room, Object.values(room.players), {
        game: "song",
        name: room.name,
        phase: room.phase,
        visibility: room.visibility,
        hidden: isTestRoom(this.ctx, room) || room.solo,
        roundNumber: room.roundNumber,
      })
    );
  }

  async adminCloseRoom(roomId: string): Promise<void> {
    closeRoom(this.ctx, requireAdminRoom(this.ctx.rooms, roomId), ADMIN_CLOSE_REASON);
  }

  async adminKickPlayer(roomId: string, playerId: string): Promise<void> {
    return adminKickPlayer(this.ctx, roomId, playerId);
  }

  /** 这张标签页要交给 Agent：它坐着的房间必须开着 MCP，否则其他玩家的知情就被绕过了。 */
  assertTabAgentsAllowed(tabKey: string): void {
    assertTabAgentsAllowed(this.ctx.kernel, tabKey);
  }

  /** 接管开始或结束：同房玩家要立刻看到座位上的 MCP 徽标变化。 */
  publishTabRooms(tabKey: string): void {
    for (const room of roomsOfTab(this.ctx.kernel, tabKey)) this.ctx.publishRoom(room);
  }

  /** 巡检每跳调用：房主空缺或离线宽限已过时改选，选不到就保持现状、下一跳再试。 */
  private resolveHost(room: SonGuessrRoomRecord, currentTime: number) {
    const previousHostId = room.hostPlayerId;
    const { changed } = resolveHostGrace(room, Object.values(room.players), currentTime);
    if (!changed) return;
    settleHostChange(room, previousHostId);
    this.ctx.touch(room);
    this.ctx.publishRoom(room);
    this.ctx.publishLobby();
  }
}
