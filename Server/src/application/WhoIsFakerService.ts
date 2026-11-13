import { ADMIN_CLOSE_REASON, type AdminRoomView } from "../domain/AdminRoom";
import { assertTextAllowed } from "../infrastructure/SensitiveText";
import { AppError } from "../domain/Errors";
import {
  type ConnectionRecord,
  type WhoIsFakerPlayerRecord,
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
  ensureRoomId,
  normalizeName,
  safeEqualToken,
} from "../domain/Rules";

import { createEvent } from "../transport/Packets";
import type { WhoIsFakerClientMessage } from "../transport/WhoIsFakerProtocol";

import {
  COMMAND_RATE_LIMIT_PER_CONNECTION,
  COMMAND_RATE_LIMIT_WINDOW_MS,
} from "../config/Constants";
import { transferHost } from "./room/HostPolicy";
import { adminRoomView, countOnline, requireAdminRoom } from "./room/RoomSummaries";
import {
  assertAgentAdmission,
  assertSeatResumable,
  assertTabAgentsAllowed,
  findSeat,
  roomsOfTab,
  type TabSeatContext,
} from "./room/SeatBinding";
import { whoIsFakerShape } from "./whoisfaker/RoomShape";
import {
  createWhoIsFakerDispatcher,
  screenCommand,
  type WhoIsFakerDispatcher,
} from "./whoisfaker/Commands";
import { CommandQuota, dispatchCommand } from "./room/CommandTable";
import { createWhoIsFakerContext, type WhoIsFakerContext } from "./whoisfaker/Context";
import type { WhoIsFakerServiceOptions } from "./whoisfaker/Options";
import { forceRemovePlayer } from "./whoisfaker/ForcedRemoval";
import { handlePlayerOffline } from "./whoisfaker/OfflineSettlement";
import { runHousekeeping } from "./whoisfaker/Housekeeping";
import { exportSnapshots, restoreSnapshots } from "./whoisfaker/SnapshotPersistence";
import { clearPendingDisconnect } from "./whoisfaker/PendingDisconnects";
import { handlePhaseTimeout } from "./whoisfaker/PhaseTimeouts";
import { finishRound } from "./whoisfaker/RoundSettlement";
import { runBots } from "./whoisfaker/dev/BotActors";
import {
  clampRoleConfig,
  getConfigurableParticipantCount,
  normalizeRoomRoleConfig,
} from "./whoisfaker/RoundRules";
import { attachConnection } from "./whoisfaker/RoomAttach";
import { closeRoom } from "./whoisfaker/RoomClosure";
import {
  ensureHost,
  ensureUniqueName,
  getRoom,
  isRoundActive,
  type WhoIsFakerSeatAt,
} from "./whoisfaker/RoomAccess";
import { publishLobby, publishRoom } from "./whoisfaker/RoomPublish";
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
  /** 每连接的命令总额度：在预检、解析与守卫之前扣，高频乱发的连接在最便宜的地方被挡住。 */
  private readonly commandQuota: CommandQuota;

  /** 房间表的只读视图：测试与外部只读它，写入只经上下文里的玩法函数。 */
  get rooms(): ReadonlyMap<string, WhoIsFakerRoomRecord> {
    return this.ctx.rooms;
  }

  constructor(options: WhoIsFakerServiceOptions) {
    this.ctx = createWhoIsFakerContext(
      options,
      (roomId, expectedPhase, expectedSpeechMode, expectedTieBreakStage) =>
        handlePhaseTimeout(
          this.ctx,
          roomId,
          expectedPhase,
          expectedSpeechMode,
          expectedTieBreakStage
        )
    );
    const ctx = this.ctx;
    this.tabSeats = {
      shape: whoIsFakerShape,
      connections: ctx.connectionRegistry,
      rooms: ctx.rooms,
    };
    this.dispatcher = createWhoIsFakerDispatcher(ctx, this);
    this.commandQuota = new CommandQuota({
      now: () => ctx.now(),
      windowMs: COMMAND_RATE_LIMIT_WINDOW_MS,
      maxRequests: COMMAND_RATE_LIMIT_PER_CONNECTION,
    });
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
    // 额度排在预检之前：预检里有敏感词扫描，高频草稿不该先白白扫一遍再被限流。
    this.commandQuota.consume(connection);
    screenCommand(message);
    return dispatchCommand(this.dispatcher, connection, message);
  }

  async runHousekeeping(): Promise<void> {
    await runHousekeeping(this.ctx);
  }

  notifyShutdown(): void {
    this.ctx.connectionRegistry.broadcastToAll(
      createEvent("server.shutdown", {
        message: SERVER_SHUTDOWN_MESSAGE,
      })
    );
  }

  exportSnapshots(): SnapshottedRoom[] {
    return exportSnapshots(this.ctx);
  }

  restoreSnapshots(rooms: readonly SnapshottedRoom[], savedAt: number): number {
    return restoreSnapshots(this.ctx, rooms, savedAt);
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

  async drainPendingWrites(): Promise<void> {
    await this.ctx.options.wordBankRepository?.drainWrites();
  }
}
