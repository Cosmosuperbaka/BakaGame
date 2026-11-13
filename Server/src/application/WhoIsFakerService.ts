import { ADMIN_CLOSE_REASON, type AdminRoomView } from "../domain/AdminRoom";
import { assertTextAllowed } from "../infrastructure/SensitiveText";
import { AppError } from "../domain/Errors";
import {
  type ChatChannel,
  type ConnectionRecord,
  type GameRound,
  type WhoIsFakerPlayerRecord,
  type WhoIsFakerRole,
  type WhoIsFakerRoomRecord,
  type WhoIsFakerRoomSummary,
  type RoleConfig,
  type RoomSettings,
  SERVER_SHUTDOWN_MESSAGE,
} from "../shared/Index";
import type { SnapshottedRoom } from "../shared/RoomSnapshot";
import { tabSeatId } from "./TabSeat";
import type { GameService } from "./GameService";
import {
  createDefaultRoleConfig,
  assignRoles,
  ensureRoomId,
  listPlayablePlayerIds,
  normalizeName,
  normalizeWord,
  safeEqualToken,
  validateRoleConfig,
} from "../domain/Rules";

import { describeError } from "../infrastructure/EventLogger";
import { createEvent } from "../transport/Packets";
import type { WhoIsFakerClientMessage } from "../transport/WhoIsFakerProtocol";

import { QUESTIONER_RECONNECT_TIMEOUT_MS, ROOM_EXPIRING_WARNING_MS } from "../config/Constants";
import { resolveHostGrace, transferHost } from "./room/HostPolicy";
import { acceptChatText, appendChat } from "./room/ChatLog";
import { adminRoomView, countOnline, requireAdminRoom } from "./room/RoomSummaries";
import {
  assertAgentAdmission,
  assertSeatResumable,
  assertTabAgentsAllowed,
  findSeat,
  roomsOfTab,
  type TabSeatContext,
} from "./room/SeatBinding";
import {
  forEachRoomIsolated,
  isIdleWarningDue,
  judgeReclaim,
  markIdleWarningSent,
  offlineSeatGraceMs,
} from "./room/RoomJanitor";
import {
  adoptRoomCore,
  exportRoomJson,
  hasSnapshotShape,
  restoreRooms,
} from "./room/RoomSnapshotCodec";
import { whoIsFakerShape } from "./whoisfaker/RoomShape";
import {
  createWhoIsFakerDispatcher,
  screenCommand,
  type WhoIsFakerDispatcher,
} from "./whoisfaker/Commands";
import { dispatchCommand } from "./room/CommandTable";
import { createWhoIsFakerContext, type WhoIsFakerContext } from "./whoisfaker/Context";
import type { WhoIsFakerServiceOptions } from "./whoisfaker/Options";
import {
  clearPendingDisconnect,
  forceRemovePlayer,
  handlePlayerOffline,
  requeuePendingDisconnects,
  shouldAutoCloseWhenEmpty,
} from "./whoisfaker/OfflineSettlement";
import {
  armPhaseTimer,
  clearPhaseTimer,
  completeSupplementIfReady,
  finishRound,
  handlePhaseTimeout,
} from "./whoisfaker/PhaseFlow";
import { runBots } from "./whoisfaker/dev/BotActors";
import {
  clampRoleConfig,
  createDescription,
  createDescriptionOrder,
  ensureCanVote,
  getConfigurableParticipantCount,
  getParticipantCount,
  isDescriptionComplete,
  normalizeRoomRoleConfig,
  replaceNightAction,
  replaceVote,
} from "./whoisfaker/RoundRules";
import { attachConnection } from "./whoisfaker/RoomAttach";
import { closeRoom } from "./whoisfaker/RoomClosure";
import {
  ensureHost,
  ensureUniqueName,
  getRoom,
  isRoundActive,
  requireRound,
  type WhoIsFakerSeatAt,
} from "./whoisfaker/RoomAccess";
import {
  broadcastRoomEvent,
  publishLobby,
  publishRoom,
  publishRoomCalibration,
} from "./whoisfaker/RoomPublish";
import { listRoomSummaries } from "./whoisfaker/RoomViews";

/** 改设置的纯校验产物：失败在产生它之前就抛出，不会留下半截设置。 */
interface SettingsPatch {
  name?: string;
  visibility?: RoomSettings["visibility"];
  allowSpectators?: boolean;
  revealRoleOnDeath?: boolean;
  spectatorsSeeAnswers?: boolean;
  allowAgents?: boolean;
  roleConfig?: RoleConfig;
  /** 需要重新算摘要的明文口令；仅最终为私密房且本次带了口令时才有。 */
  password?: string;
}

export class WhoIsFakerService implements GameService<WhoIsFakerClientMessage> {
  // ==================== 房间与状态机总控 ====================

  /** 上下文：数据与叶子工具都在这里，子模块只拿它，不拿门面。 */
  readonly ctx: WhoIsFakerContext;
  /** 标签页接管 Agent 时按标签页找房间用的上下文。 */
  private readonly tabSeats: TabSeatContext<WhoIsFakerRoomRecord, WhoIsFakerPlayerRecord>;
  private readonly dispatcher: WhoIsFakerDispatcher;

  /** 房间表的只读视图：测试与外部只读它，写入只经上下文里的玩法函数。 */
  get rooms(): ReadonlyMap<string, WhoIsFakerRoomRecord> {
    return this.ctx.rooms;
  }

  constructor(options: WhoIsFakerServiceOptions) {
    this.ctx = createWhoIsFakerContext(options);
    const ctx = this.ctx;
    this.tabSeats = {
      shape: whoIsFakerShape,
      connections: ctx.connectionRegistry,
      rooms: ctx.rooms,
    };
    this.dispatcher = createWhoIsFakerDispatcher(ctx, this);
  }

  registerConnection(connection: ConnectionRecord): void {
    this.ctx.connectionRegistry.registerConnection(connection);
  }

  // 连接断开时只做连接解绑，真正的房间副作用统一交给 handlePlayerOffline。
  async unregisterConnection(connectionId: string): Promise<void> {
    const connection = this.ctx.connectionRegistry.unregisterConnection(connectionId);

    if (!connection || !connection.roomId || !connection.playerId) {
      return;
    }

    const room = this.ctx.rooms.get(connection.roomId);

    if (!room) {
      return;
    }

    const player = room.players[connection.playerId];
    // 非座席主连接断开，不影响座位在线态。
    if (player?.connectionId !== connection.id) return;

    await handlePlayerOffline(this.ctx, room, connection.playerId, "disconnect");
  }

  async execute(connectionId: string, message: WhoIsFakerClientMessage): Promise<unknown> {
    // 所有命令都从这里进入，方便统一做连接上下文解析与后续审计。
    const connection = this.ctx.connectionRegistry.getConnection(connectionId);
    screenCommand(message);
    return dispatchCommand(this.dispatcher, connection, message);
  }

  async runHousekeeping(): Promise<void> {
    // 统一处理空房清理、闲置超时和出题人掉线超时。
    const currentTime = this.ctx.now();
    // 逐房隔离：一间房的状态异常不能让迭代顺序里靠后的房间本轮都不被清理。
    await forEachRoomIsolated(
      this.ctx.rooms,
      (room) => this.housekeepRoom(room, currentTime),
      (room, error) =>
        this.ctx.options.eventLogger.error("房间巡检失败", {
          roomId: room.id,
          ...describeError(error),
        })
    );
  }

  private async housekeepRoom(room: WhoIsFakerRoomRecord, currentTime: number): Promise<void> {
    if (await this.reclaimIdleRoom(room, currentTime)) return;
    await this.removeOfflinePlayers(room, currentTime);
    await this.handOverStalledRoles(room, currentTime);
    await this.finishExpiredPhaseTimer(room, currentTime);
    publishRoomCalibration(this.ctx, room);
  }

  /**
   * 空房与闲置回收，返回本房是否已关闭。
   * 闲置关房前提前一段时间预警，每一段闲置只预警一次，有新活动后重新计。
   * 测试房只豁免「空房回收」：测试房常态是一间等人加入的空房，但长期闲置的测试房
   * 与它加出来的机器人仍要回收，否则只能靠重启释放。
   */
  private async reclaimIdleRoom(room: WhoIsFakerRoomRecord, currentTime: number): Promise<boolean> {
    const onlineCount = countOnline(Object.values(room.players));
    if (isIdleWarningDue(room, onlineCount, currentTime, ROOM_EXPIRING_WARNING_MS)) {
      markIdleWarningSent(room);
      broadcastRoomEvent(this.ctx, room, "room.expiring", {
        roomId: room.id,
        reason: "idle_timeout",
      });
    }
    const verdict = judgeReclaim(room, onlineCount, currentTime, {
      emptyRoomExempt: !shouldAutoCloseWhenEmpty(this.ctx, room),
    });
    // 空房宽限内（grace）与 keep 一样继续后面的步骤：宽限只决定要不要关，不暂停回合推进。
    if (verdict === "close-empty") {
      await closeRoom(this.ctx, room, "empty");
      return true;
    }
    if (verdict === "close-idle") {
      await closeRoom(this.ctx, room, "idle_timeout");
      return true;
    }
    return false;
  }

  /** 清理离线超过保留时长的玩家：时长按席位而定，见 `offlineSeatGraceMs`。 */
  private async removeOfflinePlayers(room: WhoIsFakerRoomRecord, currentTime: number) {
    for (const player of Object.values(room.players)) {
      if (
        player.online ||
        player.isBot ||
        currentTime - player.lastSeenAt < offlineSeatGraceMs(room, player)
      ) {
        continue;
      }
      // 被踢记录在踢人当时已完成强制移除，这里只清掉占位。
      if (player.membership !== "kicked" && room.round && room.round.phase !== "gameOver") {
        if (room.round.questionerPlayerId === player.id) {
          await finishRound(this.ctx, room, "aborted", "出题人掉线超时，本局已结束");
        } else {
          await forceRemovePlayer(this.ctx, room, player.id, "timeout");
        }
      }
      delete room.players[player.id];
      normalizeRoomRoleConfig(room);
      this.ctx.touch(room);
    }
  }

  /**
   * 房主与出题人各自的重连截止时刻到了就交接或结束本局。
   * 房主每一跳都过内核的不变量检查：宽限已过、空缺或悬空时按候选规则改选，选不到下一跳再试。
   */
  private async handOverStalledRoles(room: WhoIsFakerRoomRecord, currentTime: number) {
    await this.settleHostGrace(room, currentTime);

    if (
      room.round?.questionerReconnectDeadlineAt &&
      currentTime >= room.round.questionerReconnectDeadlineAt
    ) {
      await finishRound(this.ctx, room, "aborted", "出题人掉线超时，本局已结束");
    }
  }

  private async finishExpiredPhaseTimer(room: WhoIsFakerRoomRecord, currentTime: number) {
    const activeTimer = room.round?.phaseTimer;
    if (!activeTimer || currentTime < activeTimer.endsAt) return;

    await handlePhaseTimeout(
      this.ctx,
      room.id,
      activeTimer.phase,
      activeTimer.speechMode,
      activeTimer.tieBreakStage
    );
  }

  notifyShutdown(): void {
    this.ctx.connectionRegistry.broadcastToAll(
      createEvent("server.shutdown", {
        message: SERVER_SHUTDOWN_MESSAGE,
      })
    );
  }

  /**
   * 导出全部房间以供停机保存。
   *
   * 走内核的 JSON 往返出口而不是浅拷贝：房间记录将来若混进函数或句柄，浅拷贝会让序列化在
   * 停机路径上抛错，而那段恰恰最不能失败；往返顺带剔除 undefined，落盘内容与线上视图一致。
   */
  exportSnapshots(): SnapshottedRoom[] {
    const snapshots: SnapshottedRoom[] = [];
    for (const room of this.ctx.rooms.values()) {
      try {
        snapshots.push(exportRoomJson(room));
      } catch (error) {
        this.ctx.options.eventLogger?.warn("房间快照导出失败，已跳过该房间", {
          roomId: room.id,
          ...describeError(error),
        });
      }
    }
    return snapshots;
  }

  /**
   * 从快照恢复房间，返回真正恢复的房间数。
   *
   * 关键不是「把对象塞回 Map」，而是把**停机期间流逝的时间**处理干净：
   * 停机时没人在操作，若照原样保留绝对时间戳，倒计时会在恢复瞬间集体到点、
   * 掉线清理会立刻命中，表现为「服务健康、日志正常，但用户回来房间全没了」。
   * 所以下面每个时间字段都要按自己的语义单独处理，不能统一 +pausedMs 了事。
   */
  restoreSnapshots(rooms: readonly SnapshottedRoom[], savedAt: number): number {
    return restoreRooms(
      this.ctx.rooms,
      rooms,
      { savedAt, now: this.ctx.now() },
      {
        adopt: (raw, now, pausedMs) => this.adoptSnapshot(raw, now, pausedMs),
        onRestored: (room) => {
          // 对局记录的开局时间没有进快照：用快照写入时刻当下界，比按恢复时刻起算更接近真实。
          if (room.round) this.ctx.roundStartedAtById.set(room.round.id, savedAt);
          this.ctx.ids.absorb(room);
          // 倒计时只在房间真正登记时才重挂：被判重复而跳过的房间不能留下孤儿定时器。
          const timer = room.round?.phaseTimer;
          if (timer) armPhaseTimer(this.ctx, room, timer, timer.endsAt - this.ctx.now());
        },
        onError: (raw, error) =>
          this.ctx.options.eventLogger?.warn("房间快照恢复失败，已跳过该房间", {
            roomId: raw.id,
            ...describeError(error),
          }),
      }
    );
  }

  /** 单间恢复：形状校验 + 时间字段重算 + 重建倒计时。任何一步不合预期就整间丢弃。 */
  private adoptSnapshot(
    raw: SnapshottedRoom,
    now: number,
    pausedMs: number
  ): WhoIsFakerRoomRecord | undefined {
    if (!hasSnapshotShape(raw)) return undefined;
    const room = raw as unknown as WhoIsFakerRoomRecord;

    // 全员离线、掉线与空房计时从恢复时刻起算：lastSeenAt 留着停机前的值，重启超过 3 分钟
    // 就会在第一次巡检时把全员踢掉，玩家还没机会重连。房主此刻必然离线，一律带一段完整的
    // 重连宽限，否则第一个回来的人会因为「离线房主没有截止」而抢走房主。
    adoptRoomCore(room, Object.values(room.players), now);
    room.updatedAt = now;

    const round = room.round;
    if (round) {
      // 倒计时暂停：停机期间没人能发言或投票，直接按原截止时刻结算等于用故障惩罚玩家。
      if (round.phaseTimer) round.phaseTimer.endsAt += pausedMs;
      if (round.questionerReconnectDeadlineAt !== undefined) {
        round.questionerReconnectDeadlineAt = now + QUESTIONER_RECONNECT_TIMEOUT_MS;
      }
    }

    return room;
  }

  getHealthSnapshot() {
    return {
      roomCount: this.ctx.rooms.size,
      connectionCount: this.ctx.connectionRegistry.stats.totalConnections,
      onlinePlayerCount: [...this.ctx.rooms.values()].reduce(
        (sum, room) => sum + countOnline(Object.values(room.players)),
        0
      ),
    };
  }

  getRoomSummaries(): WhoIsFakerRoomSummary[] {
    return listRoomSummaries(this.ctx);
  }

  adminListRooms(): AdminRoomView[] {
    return [...this.ctx.rooms.values()].map((room) =>
      adminRoomView(room, Object.values(room.players), {
        game: "faker",
        name: room.settings.name,
        phase: room.round?.phase ?? "waiting",
        visibility: room.settings.visibility,
        hidden: this.ctx.testRooms.isTestRoom(room.id),
        roundNumber: room.roundCount ?? 0,
      })
    );
  }

  async adminCloseRoom(roomId: string): Promise<void> {
    await closeRoom(this.ctx, requireAdminRoom(this.ctx.rooms, roomId), ADMIN_CLOSE_REASON);
  }

  async adminKickPlayer(roomId: string, playerId: string): Promise<void> {
    const room = requireAdminRoom(this.ctx.rooms, roomId);
    const target = room.players[playerId];
    if (!target || target.membership === "kicked")
      throw new AppError("PLAYER_NOT_FOUND", "目标玩家不存在");
    await this.kickPlayer(room, target, "管理员");
  }

  async createRoom(
    connection: ConnectionRecord,
    message: Extract<WhoIsFakerClientMessage, { type: "room.create" }>
  ) {
    // 创建房间时同时把当前连接绑定为房主与首个正式玩家。
    const roomId = ensureRoomId(message.payload.roomId, this.ctx.testRooms);
    assertTextAllowed(message.payload.name, message.payload.userName);

    // 同步占号：占号期间同号的第二次建房被拒，而半成品房间不进房间表，入房、大厅、巡检都看不到它。
    const releaseRoomId = this.ctx.reservations.hold(roomId, (id) => this.ctx.rooms.has(id));
    let room: WhoIsFakerRoomRecord;
    let host: WhoIsFakerPlayerRecord;
    try {
      ({ room, host } = await this.buildAndRegisterRoom(connection, message, roomId));
    } finally {
      releaseRoomId();
    }

    const previousRoomUpdate = attachConnection(this.ctx, room, host, connection);
    this.ctx.appendSystemMessage(room, `${host.name} 创建了房间`);
    this.ctx.touch(room);

    await previousRoomUpdate;
    await this.ctx.log({
      type: "room.created",
      createdAt: this.ctx.now(),
      roomId: room.id,
      playerId: host.id,
      payload: {
        visibility: room.settings.visibility,
      },
    });

    publishRoom(this.ctx, room);
    publishLobby(this.ctx);

    return {
      roomId: room.id,
      playerId: host.id,
      sessionToken: host.sessionToken,
    };
  }

  /**
   * 构造房间并登记进房间表。私密房要跨一次 await 算口令摘要：摘要算完、复核连接仍在之后才登记，
   * 登记前任何读房间表的路径都看不到这间房，不会出现「私密却没有口令」的窗口。
   */
  private async buildAndRegisterRoom(
    connection: ConnectionRecord,
    message: Extract<WhoIsFakerClientMessage, { type: "room.create" }>,
    roomId: string
  ): Promise<{ room: WhoIsFakerRoomRecord; host: WhoIsFakerPlayerRecord }> {
    // 私密房口令只存 argon2 摘要：房间记录、快照与日志里都不该出现可读的口令。
    const password =
      message.payload.visibility === "private"
        ? this.ctx.passwords.require(message.payload.password)
        : undefined;

    const room: WhoIsFakerRoomRecord = {
      id: roomId,
      settings: {
        name: normalizeName(message.payload.name),
        visibility: message.payload.visibility,
        allowSpectators: message.payload.allowSpectators,
        roleConfig: createDefaultRoleConfig(),
        revealRoleOnDeath: true,
        spectatorsSeeAnswers: false,
        allowAgents: message.payload.allowAgents === true || connection.agentDriven?.() === true,
      },
      hostPlayerId: "",
      createdAt: this.ctx.now(),
      updatedAt: this.ctx.now(),
      lastActivityAt: this.ctx.now(),
      players: {},
      chat: [],
    };

    const host = this.ctx.createPlayer(
      message.payload.userName,
      false,
      connection.isAgent === true,
      tabSeatId(connection, "faker", room.id)
    );
    room.players[host.id] = host;
    room.hostPlayerId = host.id;

    // 房间名缺省时使用房主昵称，避免千篇一律的"新房间"。
    if (!room.settings.name) {
      room.settings.name = `${host.name}的房间`;
    }

    room.settings.roleConfig = clampRoleConfig(
      message.payload.roleConfig ?? createDefaultRoleConfig(),
      getConfigurableParticipantCount(room)
    );

    if (password) {
      room.passwordHash = await this.ctx.passwords.hash(password);
      // 算摘要期间连接可能已断开：此时再绑定会留下没有任何连接会触发离线的幽灵席位。
      if (!this.ctx.connectionRegistry.findConnection(connection.id)) {
        throw new AppError("CONNECTION_CLOSED", "连接已断开");
      }
    }
    this.ctx.rooms.set(room.id, room);
    return { room, host };
  }

  async joinRoom(
    connection: ConnectionRecord,
    message: Extract<WhoIsFakerClientMessage, { type: "room.join" }>
  ) {
    // 开局后新连接默认只能作为旁观者进入，避免临时插入正式席位打乱本局。
    const roomId = ensureRoomId(message.roomId ?? "", this.ctx.testRooms);
    const room = getRoom(this.ctx, roomId);

    assertAgentAdmission(connection, whoIsFakerShape.admission(room));
    // 同一张标签页再次加入就是回到原座位：已经进过门，不重复核对口令，也不会与自己撞名。
    // 被踢的记录不算座位，再进来走普通加入。
    const seat = findSeat(this.ctx.seatContext, room, connection);
    if (seat) return this.resumeSeat(room, seat, connection);
    await this.ctx.passwords.verify(
      room,
      room.settings.visibility,
      message.payload.password,
      connection.id
    );
    // 比对摘要要跨一次 await，期间房间可能已关闭：写入前先确认拿到的还是登记中的那一份。
    if (this.ctx.rooms.get(room.id) !== room)
      throw new AppError("ROOM_NOT_FOUND", "房间不存在或已关闭");
    // 同理连接也可能在比对期间断开，已不在册就不能再占座位。
    if (!this.ctx.connectionRegistry.findConnection(connection.id))
      throw new AppError("CONNECTION_CLOSED", "连接已断开");
    // 同名重入不按「自己让给自己」放行：掉线席位默认保留在名册里等凭票重连，
    // 例外放行会让名册里同时留下两个同名玩家。要走接管就用 room.reconnect 的会话票据。
    assertTextAllowed(message.payload.userName);
    ensureUniqueName(room, message.payload.userName);

    const joiningAsSpectator = isRoundActive(room);

    if (joiningAsSpectator && !room.settings.allowSpectators) {
      throw new AppError("SPECTATOR_DISABLED", "当前房间不允许旁观");
    }

    const player = this.ctx.createPlayer(
      message.payload.userName,
      false,
      connection.isAgent === true,
      tabSeatId(connection, "faker", room.id)
    );
    player.membership = joiningAsSpectator ? "spectator" : "active";

    room.players[player.id] = player;
    const previousRoomUpdate = attachConnection(this.ctx, room, player, connection);
    normalizeRoomRoleConfig(room);
    this.ctx.appendSystemMessage(room, `${player.name} 加入了房间`);
    this.ctx.touch(room);

    await previousRoomUpdate;
    await this.ctx.log({
      type: "room.joined",
      createdAt: this.ctx.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        membership: player.membership,
      },
    });

    publishRoom(this.ctx, room);
    publishLobby(this.ctx);

    return {
      roomId: room.id,
      playerId: player.id,
      sessionToken: player.sessionToken,
    };
  }

  async reconnectRoom(
    connection: ConnectionRecord,
    message: Extract<WhoIsFakerClientMessage, { type: "room.reconnect" }>
  ) {
    // 重连不会创建新玩家，只会把会话重新挂回原连接。
    const room = getRoom(this.ctx, ensureRoomId(message.payload.roomId, this.ctx.testRooms));
    this.ensureAgentsAllowed(room, connection);

    const player =
      Object.values(room.players).find((item) =>
        safeEqualToken(item.sessionToken, message.payload.sessionToken)
      ) ?? this.tabSeat(room, connection);

    if (!player) {
      throw new AppError("SESSION_NOT_FOUND", "会话凭证无效或座位已不存在");
    }

    return this.resumeSeat(room, player, connection);
  }

  /** 这张标签页在本房的席位记录；没有标签页身份的连接恒为空。 */
  private tabSeat(room: WhoIsFakerRoomRecord, connection: ConnectionRecord) {
    const seatId = tabSeatId(connection, "faker", room.id);
    return seatId ? room.players[seatId] : undefined;
  }

  /** 把连接接回既有席位：重连与同标签页再次加入共用，准入判定只有这一份。 */
  private async resumeSeat(
    room: WhoIsFakerRoomRecord,
    player: WhoIsFakerPlayerRecord,
    connection: ConnectionRecord
  ) {
    // 被踢的记录不能回来；人类的座位只属于人类的标签页，Agent 只能由人类把标签页交出来。
    assertSeatResumable(player, connection);

    return this.restorePlayerConnection(room, player, connection, {
      appendMessage: `${player.name} 已重新连接`,
    });
  }

  async leaveRoom(at: WhoIsFakerSeatAt) {
    const { room, seat: player } = at;
    await handlePlayerOffline(this.ctx, room, player.id, "leave");

    return { left: true };
  }

  requestSync(at: WhoIsFakerSeatAt) {
    const { room, connection } = at;
    connection.resetStateSync?.();
    publishRoom(this.ctx, room, connection);
    return { synced: true };
  }

  async updateSettings(
    at: WhoIsFakerSeatAt,
    payload: Extract<WhoIsFakerClientMessage, { type: "room.updateSettings" }>["payload"]
  ) {
    const { room, seat: player } = at;

    // 两阶段：纯校验产出补丁（失败不改任何状态）→ 必要时 await 慢哈希 → 复核后同步一次写入。
    // 房主与回合空闲由命令表守卫在进入前确认，await 回来后在下面按同一顺序复核。
    const patch = this.buildSettingsPatch(room, payload);
    const passwordHash =
      patch.password === undefined ? undefined : await this.ctx.passwords.hash(patch.password);

    // await 期间房间可能已被关闭、房主换人或开局，回来先复核再写（Spec §4.2）。
    if (this.ctx.rooms.get(room.id) !== room) {
      throw new AppError("ROOM_NOT_FOUND", "房间不存在");
    }
    this.assertSettingsEditable(room, player.id);
    const current = this.buildSettingsPatch(room, payload);
    if (current.password !== patch.password && current.password !== undefined) {
      throw new AppError("SETTINGS_CHANGED", "房间设置刚刚发生变化，请重试");
    }
    this.applySettingsPatch(room, current, passwordHash);

    this.ctx.touch(room);

    await this.ctx.log({
      type: "room.settings_changed",
      createdAt: this.ctx.now(),
      roomId: room.id,
      playerId: player.id,
      payload: room.settings,
    });

    publishRoom(this.ctx, room);
    publishLobby(this.ctx);

    return {
      settings: room.settings,
    };
  }

  /** await 之后的复核：仍是房主、且回合没有开始；与命令表声明的守卫同序同码。 */
  private assertSettingsEditable(room: WhoIsFakerRoomRecord, playerId: string): void {
    ensureHost(room, playerId);

    if (isRoundActive(room)) {
      throw new AppError("ROUND_ACTIVE", "游戏进行中无法修改房间设置");
    }
  }

  /** 校验全部字段，返回补丁；不写房间。 */
  private buildSettingsPatch(
    room: WhoIsFakerRoomRecord,
    payload: Extract<WhoIsFakerClientMessage, { type: "room.updateSettings" }>["payload"]
  ): SettingsPatch {
    const patch: SettingsPatch = {
      visibility: payload.visibility ?? undefined,
      allowSpectators: payload.allowSpectators ?? undefined,
      revealRoleOnDeath: payload.revealRoleOnDeath ?? undefined,
      spectatorsSeeAnswers: payload.spectatorsSeeAnswers ?? undefined,
      allowAgents: payload.allowAgents ?? undefined,
      roleConfig: payload.roleConfig ?? undefined,
    };

    if (payload.name != null) {
      const normalized = normalizeName(payload.name);
      assertTextAllowed(normalized);

      if (!normalized) {
        throw new AppError("INVALID_ROOM_NAME", "房间名不能为空");
      }

      patch.name = normalized;
    }

    if (
      patch.allowSpectators === false &&
      Object.values(room.players).some((item) => item.membership === "spectator")
    ) {
      throw new AppError("SPECTATOR_EXISTS", "房间内仍有旁观者，无法关闭旁观");
    }

    // 公开房没有口令；私密房本次带了口令就换新，没带则沿用已有摘要，两者都没有才拒绝。
    if ((patch.visibility ?? room.settings.visibility) === "private") {
      if (payload.password != null) {
        patch.password = this.ctx.passwords.require(payload.password);
      } else if (!room.passwordHash) {
        throw new AppError("PASSWORD_REQUIRED", "私密房间必须设置密码");
      }
    }

    return patch;
  }

  /** 同步写入已通过校验的补丁；`passwordHash` 与补丁里的明文口令一一对应。 */
  private applySettingsPatch(
    room: WhoIsFakerRoomRecord,
    patch: SettingsPatch,
    passwordHash: string | undefined
  ): void {
    const settings = room.settings;
    if (patch.name !== undefined) settings.name = patch.name;
    if (patch.visibility !== undefined) settings.visibility = patch.visibility;
    if (patch.allowSpectators !== undefined) settings.allowSpectators = patch.allowSpectators;
    if (patch.revealRoleOnDeath !== undefined) {
      settings.revealRoleOnDeath = patch.revealRoleOnDeath;
    }
    if (patch.spectatorsSeeAnswers !== undefined) {
      settings.spectatorsSeeAnswers = patch.spectatorsSeeAnswers;
    }
    if (patch.allowAgents !== undefined) settings.allowAgents = patch.allowAgents;

    if (settings.visibility === "public") {
      room.passwordHash = undefined;
    } else if (passwordHash !== undefined) {
      room.passwordHash = passwordHash;
    }

    if (patch.roleConfig) {
      // 人数不够时不再直接拒绝保存，而是静默夹到当前允许的范围；这样房主依然能把
      // 其它设置（房间名、私密、旁观等）改掉。前端通过 roleLimits 给出禁用提示。
      settings.roleConfig = clampRoleConfig(
        patch.roleConfig,
        getConfigurableParticipantCount(room)
      );
    } else {
      normalizeRoomRoleConfig(room);
    }
  }

  async kick(at: WhoIsFakerSeatAt, targetPlayerId: string) {
    const { room, seat: player } = at;

    if (targetPlayerId === player.id) {
      throw new AppError("INVALID_KICK", "房主不能踢出自己");
    }

    const target = room.players[targetPlayerId];

    if (!target) {
      throw new AppError("PLAYER_NOT_FOUND", "目标玩家不存在");
    }

    // 已被踢的记录只是等待清理的占位，重复踢不再重走一遍移除与日志。
    if (target.membership !== "kicked") {
      await this.kickPlayer(room, target, "房主");
    }
    return { playerId: target.id };
  }

  /** 房主踢人与后台移人共用：出题人被移出时本局中止，其余按强制移除结算。 */
  private async kickPlayer(
    room: WhoIsFakerRoomRecord,
    target: WhoIsFakerPlayerRecord,
    by: "房主" | "管理员"
  ) {
    if (isRoundActive(room) && room.round?.questionerPlayerId === target.id) {
      await finishRound(this.ctx, room, "aborted", `出题人被${by}移出，本局中止`);
    }

    await forceRemovePlayer(this.ctx, room, target.id, `${by}已将其移出房间`);

    publishRoom(this.ctx, room);
    publishLobby(this.ctx);
    await runBots(this.ctx, room);
  }

  async assignQuestioner(at: WhoIsFakerSeatAt, targetPlayerId: string) {
    // 出题人可以是正式玩家，也可以是旁观者；旁观者出题时所有正式玩家直接参赛。
    // 房主、回合存在与阶段由命令表守卫确认，这里取出回合只为收窄类型。
    const { room } = at;
    const round = requireRound(room);

    const target = room.players[targetPlayerId];

    if (
      !target ||
      (target.membership !== "active" && target.membership !== "spectator") ||
      !target.online
    ) {
      throw new AppError("PLAYER_NOT_FOUND", "目标玩家不存在、离线或已离开");
    }

    // 旁观者出题 → 正式玩家全员参战；正式玩家出题 → 扣掉自身名额。
    const participantCount = getParticipantCount(room, target.id);

    // 正式玩家担任出题人时若人数不够，自动把卧底数夹到上限（而不是直接拒绝）。
    if (target.membership === "active") {
      room.settings.roleConfig = clampRoleConfig(room.settings.roleConfig, participantCount);
    }

    validateRoleConfig(room.settings.roleConfig, participantCount);

    clearPhaseTimer(this.ctx, room);
    round.questionerPlayerId = target.id;
    round.phase = "wordSubmission";
    round.speechMode = undefined;
    this.ctx.touch(room);

    await this.ctx.log({
      type: "game.questioner_assigned",
      createdAt: this.ctx.now(),
      roomId: room.id,
      playerId: target.id,
    });

    publishRoom(this.ctx, room);
    await runBots(this.ctx, room);

    return { questionerPlayerId: target.id };
  }

  async submitWords(
    at: WhoIsFakerSeatAt,
    words: [string, string],
    blankHint?: string,
    manualRoles?: Record<string, WhoIsFakerRole>
  ) {
    // 提交词语后，真正的身份分配与词语映射都在服务端一次性完成。
    // 出题人与阶段由命令表守卫确认，这里取出回合只为收窄类型。
    const { room, seat: player } = at;
    const round = requireRound(room);
    assertTextAllowed(words[0], words[1], blankHint);

    let participantIds = listPlayablePlayerIds(room).filter(
      (item) => item !== round.questionerPlayerId
    );

    if (participantIds.length === 0 && this.ctx.testRooms.isTestRoom(room.id)) {
      // 单人测试房间允许房主先以出题人视角输入词语，再切回参赛者视角验收后续 UI。
      participantIds = [player.id];
      round.questionerPlayerId = undefined;
    }

    if (participantIds.length === 0) {
      throw new AppError("INSUFFICIENT_PLAYERS", "缺少可参与游戏的玩家");
    }

    validateRoleConfig(room.settings.roleConfig, participantIds.length);

    if (room.settings.roleConfig.hasBlank && !normalizeWord(blankHint ?? "")) {
      throw new AppError("BLANK_HINT_REQUIRED", "开启白板时必须填写提示");
    }

    const assigned = assignRoles(
      participantIds,
      room.settings.roleConfig,
      words,
      blankHint ? normalizeWord(blankHint) : undefined,
      this.ctx.random,
      manualRoles
    );

    clearPhaseTimer(this.ctx, room);
    round.words = {
      pair: assigned.pair,
      civilianWord: assigned.civilianWord,
      undercoverWord: assigned.undercoverWord,
      blankHint: blankHint ? normalizeWord(blankHint) : undefined,
    };
    round.assignments = assigned.assignments;
    round.phase = "description";
    round.speechMode = "normal";
    round.descriptionCycle = 1;
    round.descriptionOrder = createDescriptionOrder(this.ctx, room);
    round.descriptionSubmittedBy = [];
    round.votes = [];
    round.voteHistory = [];
    round.history = [];
    round.tieBreak = undefined;
    round.nightActions = [];
    round.blankGuessContext = undefined;
    this.ctx.touch(room);

    // 异步后台保存词库，避免阻塞 WebSocket 主流程
    void this.ctx.options.wordBankRepository?.savePair(words).catch((error: unknown) => {
      this.ctx.options.eventLogger.error("词库异步保存失败", {
        ...describeError(error),
        roomId: room.id,
        playerId: player.id,
      });
    });

    await this.ctx.log({
      type: "game.words_submitted",
      createdAt: this.ctx.now(),
      roomId: room.id,
      playerId: player.id,
    });

    publishRoom(this.ctx, room);
    await runBots(this.ctx, room);

    return { phase: round.phase };
  }

  async submitDescription(at: WhoIsFakerSeatAt, text: string) {
    // 描述和 PK 补充描述都复用同一份存储结构，只靠 kind 区分。
    const { room, seat: player } = at;
    const round = requireRound(room);
    const normalized = normalizeWord(text);

    if (!normalized) {
      throw new AppError("INVALID_DESCRIPTION", "描述不能为空");
    }
    assertTextAllowed(normalized);

    const pendingSupplement =
      round.supplement?.requestedPlayerIds.includes(player.id) &&
      !round.supplement.donePlayers.includes(player.id);

    // 补充发言优先：统一切换到 description/supplement 子状态后提交。
    if (round.supplement && round.speechMode === "supplement" && pendingSupplement) {
      this.submitSupplementDescription(room, round, round.supplement, player, normalized);
    } else if (round.phase === "description" && round.speechMode !== "supplement") {
      this.submitNormalDescription(round, player, normalized);
    } else if (round.phase === "tieBreak" && round.tieBreak?.stage === "description") {
      this.submitTieBreakDescription(round, round.tieBreak, player, normalized);
    } else {
      throw new AppError("INVALID_PHASE", "当前阶段不能提交描述");
    }

    this.ctx.touch(room);
    // 补充发言完成会直接切回原阶段，同样要重新检查掉线玩家。
    requeuePendingDisconnects(this.ctx, room);
    await this.ctx.log({
      type: "game.description_submitted",
      createdAt: this.ctx.now(),
      roomId: room.id,
      playerId: player.id,
    });
    publishRoom(this.ctx, room);
    await runBots(this.ctx, room);

    return { submitted: true };
  }

  private submitSupplementDescription(
    room: WhoIsFakerRoomRecord,
    round: GameRound,
    supplement: NonNullable<GameRound["supplement"]>,
    player: WhoIsFakerPlayerRecord,
    text: string
  ) {
    if (!round.assignments[player.id]?.alive || round.phase !== "description") {
      throw new AppError("ACTION_FORBIDDEN", "当前玩家不能补充发言");
    }
    supplement.donePlayers.push(player.id);
    const order = (supplement.requestedPlayerIds ?? []).indexOf(player.id) + 1;
    round.descriptions.push(
      createDescription(this.ctx, player, text, "supplement", round.descriptionCycle, {
        supplementIndex: supplement.index,
        order: order > 0 ? order : undefined,
      })
    );
    completeSupplementIfReady(this.ctx, room);
  }

  private submitNormalDescription(round: GameRound, player: WhoIsFakerPlayerRecord, text: string) {
    if (!round.assignments[player.id]?.alive) {
      throw new AppError("ACTION_FORBIDDEN", "当前玩家不能描述");
    }
    if (round.descriptionSubmittedBy.includes(player.id)) {
      throw new AppError("ALREADY_SUBMITTED", "你已经提交过描述");
    }
    round.descriptionSubmittedBy.push(player.id);
    const order = (round.descriptionOrder ?? []).indexOf(player.id) + 1;
    round.descriptions.push(
      createDescription(this.ctx, player, text, "description", round.descriptionCycle, {
        order: order > 0 ? order : undefined,
      })
    );
  }

  private submitTieBreakDescription(
    round: GameRound,
    tieBreak: NonNullable<GameRound["tieBreak"]>,
    player: WhoIsFakerPlayerRecord,
    text: string
  ) {
    round.speechMode = "tieBreak";
    if (!tieBreak.candidateIds.includes(player.id)) {
      throw new AppError("ACTION_FORBIDDEN", "只有平票玩家可以补充描述");
    }

    if (tieBreak.descriptionsDone.includes(player.id)) {
      throw new AppError("ALREADY_SUBMITTED", "你已经提交过补充描述");
    }

    tieBreak.descriptionsDone.push(player.id);
    const order = (tieBreak.candidateIds ?? []).indexOf(player.id) + 1;
    round.descriptions.push(
      createDescription(this.ctx, player, text, "tieBreak", round.descriptionCycle, {
        tieBreakIndex: round.tieBreakCount,
        order: order > 0 ? order : undefined,
      })
    );
  }

  async cancelVote(at: WhoIsFakerSeatAt) {
    // 撤销设计为幂等操作：客户端重试或快速连点时仍会收到最新私有状态。
    const { room, seat: player } = at;
    const round = requireRound(room);
    let cancelled: boolean;

    if (round.phase === "voting") {
      cancelled = round.votes.some((v) => v.voterId === player.id);
      round.votes = round.votes.filter((v) => v.voterId !== player.id);
    } else if (round.phase === "tieBreak" && round.tieBreak?.stage === "vote") {
      cancelled = round.tieBreak.votes.some((v) => v.voterId === player.id);
      round.tieBreak.votes = round.tieBreak.votes.filter((v) => v.voterId !== player.id);
    } else {
      throw new AppError("INVALID_PHASE", "当前阶段不能撤销投票");
    }

    this.ctx.touch(room);
    publishRoom(this.ctx, room);
    return { cancelled };
  }

  async cancelNightAction(at: WhoIsFakerSeatAt) {
    // 允许已提交夜晚操作的玩家在主持人推进前撤销。回合存在与夜晚阶段由命令表守卫确认。
    const { room, seat: player } = at;
    const round = requireRound(room);

    const cancelled = round.nightActions.some((a) => a.actorId === player.id);
    round.nightActions = round.nightActions.filter((a) => a.actorId !== player.id);
    this.ctx.touch(room);
    publishRoom(this.ctx, room);
    return { cancelled };
  }

  async requestSupplement(at: WhoIsFakerSeatAt, playerIds: string[]) {
    // 出题人在本轮描述完成后、投票结算前，可点名若干玩家补充发言一次。
    // 出题人判定由命令表守卫完成，这里取出回合只为收窄类型。
    const { room } = at;
    const round = requireRound(room);

    if (
      (round.phase !== "description" || round.speechMode !== "normal") &&
      round.phase !== "voting"
    ) {
      throw new AppError("INVALID_PHASE", "只能在本轮描述完成后、正常投票结算前发起补充");
    }

    if (!isDescriptionComplete(round)) {
      throw new AppError("PHASE_INCOMPLETE", "所有玩家完成描述后才能发起补充");
    }

    if (round.supplement) {
      throw new AppError("ACTION_FORBIDDEN", "当前已有进行中的补充请求，请等待完成");
    }

    if (!playerIds.length) {
      throw new AppError("INVALID_MESSAGE", "至少需要指定一名玩家补充发言");
    }

    // 校验所有被点名玩家均为存活的非出题人玩家。
    for (const id of playerIds) {
      const state = round.assignments[id];
      if (!state?.alive) {
        throw new AppError("INVALID_MESSAGE", `玩家 ${id} 不在局内或已出局，不能被要求补充`);
      }
      if (id === round.questionerPlayerId) {
        throw new AppError("INVALID_MESSAGE", "出题人不能要求自己补充发言");
      }
    }

    // 计算本局第几次补充（在所有轮次描述中找最大 supplementIndex + 1）。
    const maxSuppIdx = round.descriptions.reduce(
      (max, d) =>
        d.supplementIndex !== undefined && d.supplementIndex > max ? d.supplementIndex : max,
      0
    );

    clearPhaseTimer(this.ctx, room);
    round.supplement = {
      index: maxSuppIdx + 1,
      requestedPlayerIds: [...new Set(playerIds)],
      donePlayers: [],
      resumePhase: round.phase,
    };
    round.phase = "description";
    round.speechMode = "supplement";

    this.ctx.touch(room);
    requeuePendingDisconnects(this.ctx, room);
    await runBots(this.ctx, room);
    publishRoom(this.ctx, room);
    return { requested: true };
  }

  async submitVote(at: WhoIsFakerSeatAt, targetId: string) {
    // 第一轮投票与平票第二轮投票复用同一个入口，但资格校验不同。
    const { room, seat: player } = at;
    const round = requireRound(room);

    if (round.phase === "voting") {
      ensureCanVote(this.ctx, room, player.id, targetId, false);
      round.votes = replaceVote(round.votes, player.id, targetId);
    } else if (round.phase === "tieBreak" && round.tieBreak?.stage === "vote") {
      ensureCanVote(this.ctx, room, player.id, targetId, true);
      round.tieBreak.votes = replaceVote(round.tieBreak.votes, player.id, targetId);
    } else {
      throw new AppError("INVALID_PHASE", "当前阶段不能提交投票");
    }

    this.ctx.touch(room);
    await this.ctx.log({
      type: "game.vote_submitted",
      createdAt: this.ctx.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        targetId,
        tieBreak: round.phase === "tieBreak",
      },
    });
    publishRoom(this.ctx, room);
    await runBots(this.ctx, room);

    return { submitted: true };
  }

  async submitNightAction(at: WhoIsFakerSeatAt, targetId?: string | null) {
    // 空 targetId 表示“本夜不行动”，不是错误输入。回合存在与夜晚阶段由命令表守卫确认。
    const { room, seat: player } = at;
    const round = requireRound(room);

    const state = round.assignments[player.id];

    if (!state?.alive || (state.role !== "civilian" && state.role !== "undercover")) {
      throw new AppError("ACTION_FORBIDDEN", "当前玩家没有夜晚操作资格");
    }

    if (targetId) {
      const targetState = round.assignments[targetId];

      // 不能刀自己，测试房间同样适用。
      if (!targetState?.alive || targetId === player.id) {
        throw new AppError("INVALID_TARGET", "夜晚目标无效");
      }
    }

    round.nightActions = replaceNightAction(round.nightActions, player.id, {
      actorId: player.id,
      actorRole: state.role,
      targetId: targetId ?? undefined,
    });
    this.ctx.touch(room);

    await this.ctx.log({
      type: "game.night_action_submitted",
      createdAt: this.ctx.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        hasTarget: Boolean(targetId),
      },
    });

    publishRoom(this.ctx, room);
    await runBots(this.ctx, room);

    return { submitted: true };
  }

  private chatChannelOf(
    room: WhoIsFakerRoomRecord,
    player: WhoIsFakerPlayerRecord
  ): { channel: ChatChannel; ghostRole?: "dead" | "spectator" } {
    const isIngame = Boolean(
      room.round &&
      ["description", "voting", "tieBreak", "night", "blankGuess", "feedback"].includes(
        room.round.phase
      )
    );
    if (!isIngame) return { channel: "main" };
    const isSpectator =
      player.membership === "spectator" && room.round?.questionerPlayerId !== player.id;
    const isDead = room.round?.assignments[player.id]?.alive === false;
    if (isSpectator || isDead) {
      return { channel: "ghost", ghostRole: isSpectator ? "spectator" : "dead" };
    }
    return { channel: "main" };
  }

  async sendChat(at: WhoIsFakerSeatAt, text: string) {
    // 聊天区在任意阶段都开放，所以不受 round.phase 限制。
    const { room, seat: player, connection } = at;
    this.ctx.chatLimiter.consume(connection.id);
    const normalized = acceptChatText(text, {
      maxLength: undefined,
      emptyError: { code: "INVALID_CHAT", message: "聊天内容不能为空" },
    });

    const { channel, ghostRole } = this.chatChannelOf(room, player);

    appendChat(room, {
      id: this.ctx.createId("chat"),
      playerId: player.id,
      playerName: player.name,
      text: normalized,
      createdAt: this.ctx.now(),
      system: false,
      channel,
      ghostRole,
    });
    this.ctx.touch(room);

    await this.ctx.log({
      type: "chat.sent",
      createdAt: this.ctx.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        text: normalized,
        channel,
        ghostRole,
      },
    });

    publishRoom(this.ctx, room);
    return { sent: true };
  }

  async transferHost(at: WhoIsFakerSeatAt, targetPlayerId: string) {
    // 房主手动转移：任意阶段均可，目标必须是在线的正式玩家（真人）。房主判定由命令表守卫完成。
    const { room, seat: player } = at;

    if (targetPlayerId === player.id) {
      throw new AppError("INVALID_TARGET", "不能将房主转移给自己");
    }

    const target = room.players[targetPlayerId];

    if (!target || target.membership === "kicked") {
      throw new AppError("PLAYER_NOT_FOUND", "目标玩家不存在");
    }

    transferHost(room, target);
    this.ctx.touch(room);
    this.ctx.appendSystemMessage(room, `${player.name} 将房主转移给了 ${target.name}`);

    await this.ctx.log({
      type: "room.host_transferred",
      createdAt: this.ctx.now(),
      roomId: room.id,
      playerId: player.id,
      payload: { nextHostId: target.id },
    });

    publishRoom(this.ctx, room);
    publishLobby(this.ctx);
    return { hostPlayerId: target.id };
  }

  private async restorePlayerConnection(
    room: WhoIsFakerRoomRecord,
    player: WhoIsFakerPlayerRecord,
    connection: ConnectionRecord,
    options: {
      appendMessage: string;
    }
  ) {
    const previousRoomUpdate = attachConnection(this.ctx, room, player, connection);

    if (room.round) {
      clearPendingDisconnect(room.round, player.id);
    }

    if (room.round?.questionerPlayerId === player.id) {
      room.round.questionerReconnectDeadlineAt = undefined;
    }

    this.ctx.touch(room);
    this.ctx.appendSystemMessage(room, options.appendMessage);

    await previousRoomUpdate;
    await this.ctx.log({
      type: "room.reconnected",
      createdAt: this.ctx.now(),
      roomId: room.id,
      playerId: player.id,
    });

    publishRoom(this.ctx, room);
    publishLobby(this.ctx);

    return {
      roomId: room.id,
      playerId: player.id,
      sessionToken: player.sessionToken,
    };
  }

  private ensureAgentsAllowed(room: WhoIsFakerRoomRecord, connection: ConnectionRecord) {
    if (connection.isAgent === true && room.settings.allowAgents !== true) {
      throw new AppError("AGENTS_NOT_ALLOWED", "房主已禁止 Agent 进入");
    }
  }

  /** 这张标签页要交给 Agent：它坐着的房间必须开着 MCP，否则其他玩家的知情就被绕过了。 */
  assertTabAgentsAllowed(tabKey: string): void {
    assertTabAgentsAllowed(this.tabSeats, tabKey);
  }

  /** 接管开始或结束：同房玩家要立刻看到座位上的 MCP 徽标变化。 */
  publishTabRooms(tabKey: string): void {
    for (const room of roomsOfTab(this.tabSeats, tabKey)) publishRoom(this.ctx, room);
  }

  private async settleHostGrace(room: WhoIsFakerRoomRecord, currentTime: number) {
    const { changed, previous, next } = resolveHostGrace(
      room,
      Object.values(room.players),
      currentTime
    );
    if (!changed) return;

    this.ctx.touch(room);
    if (next) {
      this.ctx.appendSystemMessage(
        room,
        previous
          ? `${previous.name} 断线超时，房主已转移给 ${next.name}`
          : `房主已转移给 ${next.name}`
      );
      await this.ctx.log({
        type: "room.host_transferred",
        createdAt: this.ctx.now(),
        roomId: room.id,
        payload: {
          previousHostId: previous?.id,
          nextHostId: next.id,
          reason: "disconnect_timeout",
        },
      });
    }

    publishRoom(this.ctx, room);
    publishLobby(this.ctx);
  }

  async drainPendingWrites(): Promise<void> {
    await this.ctx.options.wordBankRepository?.drainWrites();
  }
}
