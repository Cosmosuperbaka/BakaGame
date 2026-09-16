import {
  BOT_NAME_SUFFIXES,
  CHAT_LIMIT,
  HOST_RECONNECT_TIMEOUT_MS,
  PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS,
  ROOM_EMPTY_GRACE_PERIOD_MS,
  ROOM_IDLE_TIMEOUT_MS,
  TEST_BOT_BATCH_LIMIT,
} from "../config/Constants";
import { AppError } from "../domain/Errors";
import { ensureRoomId, normalizeName, normalizeWord } from "../domain/Rules";
import { ROOM_ID_TEST_MODE, type ConnectionRecord, type RoomVisibility } from "../domain/Model";
import type { EventLogger } from "../infrastructure/EventLogger";
import {
  CCB_PLAYER_MESSAGE_LIMIT,
  DEFAULT_CCB_SETTINGS,
  SERVER_SHUTDOWN_MESSAGE,
  type ChatMessage,
  type CCBClientMessage,
  type CCBGameSettings,
  type CCBPlayerRecord,
  type CCBPlayerView,
  type CCBPrivateState,
  type CCBRoomRecord,
  type CCBRoomSnapshot,
  type CCBRoomSummary,
} from "../shared/Index";
import { createEvent } from "../transport/Packets";
import { ConnectionRegistry } from "./ConnectionRegistry";

// CCB 的服务端权威边界与另两个游戏一致：房间生命周期、成员身份、聊天与（P1 起）对局判定
// 全部在服务端完成。原版把出题与 `isPartialCorrect` 放在客户端，本实现不予沿用。

export interface CCBServiceOptions {
  now?: () => number;
  eventLogger?: EventLogger;
}

const clampInt = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, Math.round(value)));

const cloneSettings = (settings: CCBGameSettings): CCBGameSettings => ({
  ...settings,
  subjectTypes: [...settings.subjectTypes],
});

/**
 * 把设置补丁应用到目标设置上。
 *
 * 创建房间与修改设置共用这一份归一化，避免两处字段处理漂移。
 * 取值区间由传输层的 Schema 保证（`Spec.md §8.1`：入口立契约，内部去噪音），
 * 这里只负责数组字段的拷贝与 Schema 表达不了的跨字段约束。
 */
const applySettingsPatch = (settings: CCBGameSettings, patch: Partial<CCBGameSettings>): void => {
  if (patch.mode !== undefined) settings.mode = patch.mode;
  if (patch.topNSubjects !== undefined) settings.topNSubjects = patch.topNSubjects;
  if (patch.startYear !== undefined) settings.startYear = patch.startYear;
  if (patch.endYear !== undefined) settings.endYear = patch.endYear;
  if (patch.subjectTypes !== undefined) settings.subjectTypes = [...patch.subjectTypes];
  if (patch.guessLimit !== undefined) settings.guessLimit = patch.guessLimit;
  if (patch.timeLimitMs !== undefined) settings.timeLimitMs = patch.timeLimitMs;
  if (patch.textHint !== undefined) settings.textHint = patch.textHint;
  if (patch.blurHint !== undefined) settings.blurHint = patch.blurHint;
  if (patch.tagBan !== undefined) settings.tagBan = patch.tagBan;
  if (patch.globalPick !== undefined) settings.globalPick = patch.globalPick;

  if (
    settings.startYear !== undefined &&
    settings.endYear !== undefined &&
    settings.startYear > settings.endYear
  ) {
    throw new AppError("INVALID_SETTINGS", "起始年份不能晚于结束年份");
  }
};

export class CCBService {
  private readonly rooms = new Map<string, CCBRoomRecord>();
  private readonly connections = new ConnectionRegistry();
  private readonly now: () => number;

  private idCounter = 0;

  constructor(private readonly options: CCBServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  registerConnection(connection: ConnectionRecord): void {
    this.connections.registerConnection(connection);
  }

  getHealthSnapshot() {
    return {
      roomCount: this.rooms.size,
      connectionCount: this.connections.stats.totalConnections,
      onlinePlayerCount: [...this.rooms.values()].reduce(
        (sum, room) => sum + this.onlineCount(room),
        0,
      ),
    };
  }

  notifyShutdown(): void {
    this.connections.broadcastToAll(
      createEvent("server.shutdown", {
        message: SERVER_SHUTDOWN_MESSAGE,
      }),
    );
  }

  async unregisterConnection(connectionId: string): Promise<void> {
    const connection = this.connections.unregisterConnection(connectionId);
    if (!connection?.roomId || !connection.playerId) return;
    const room = this.rooms.get(connection.roomId);
    const player = room?.players[connection.playerId];
    if (!room || !player) return;

    player.online = false;
    player.connectionId = undefined;
    player.lastSeenAt = this.now();
    connection.roomId = undefined;
    connection.playerId = undefined;

    if (this.onlineCount(room) === 0 && !this.isTestRoom(room)) {
      room.emptySinceAt ??= this.now();
    }

    // 0 分的旁观者掉线立即移除：他们不占正式席位，也没有重连价值。
    if (
      player.membership === "spectator" &&
      player.score === 0 &&
      !player.isBot &&
      room.hostPlayerId !== player.id
    ) {
      delete room.players[player.id];
    }

    // 断线不等于显式离开：保留房主身份与席位，给移动端切后台重连留出宽限期。
    if (room.hostPlayerId === player.id && !this.isTestRoom(room)) {
      room.hostReconnectDeadlineAt = this.now() + HOST_RECONNECT_TIMEOUT_MS;
    }

    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    this.log("ccb.player.disconnected", room.roomId, player.id);
  }

  async execute(connectionId: string, message: CCBClientMessage): Promise<unknown> {
    const connection = this.connections.getConnection(connectionId);

    switch (message.type) {
      case "ccb.lobby.subscribeRooms":
        connection.lobbySubscribed = true;
        this.publishLobby();
        return { subscribed: true };
      case "ccb.room.create":
        return this.createRoom(connection, message.payload);
      case "ccb.room.join":
        return this.joinRoom(connection, message.roomId, message.payload);
      case "ccb.room.reconnect":
        return this.reconnectRoom(connection, message.payload.roomId, message.payload.sessionToken);
      case "ccb.room.leave":
        return this.leaveRoom(connection);
      case "ccb.room.requestSync":
        return this.requestSync(connection);
      case "ccb.room.updateSettings":
        return this.updateSettings(connection, message.payload);
      case "ccb.room.kick":
        return this.kick(connection, message.payload.playerId);
      case "ccb.room.transferHost":
        return this.transferHost(connection, message.payload.playerId);
      case "ccb.player.setReady":
        return this.setReady(connection, message.payload.ready);
      case "ccb.player.setSpectator":
        return this.setSpectator(connection, message.payload.spectator);
      case "ccb.player.setMessage":
        return this.setMessage(connection, message.payload.message);
      case "ccb.chat.send":
        return this.sendChat(connection, message.payload.text);
      case "ccb.test.addBot":
        return this.addBots(connection, message.payload.count);
      case "ccb.test.removeBot":
        return this.removeBots(connection, message.payload.count);
    }
  }

  async runHousekeeping(): Promise<void> {
    const currentTime = this.now();
    for (const room of [...this.rooms.values()]) {
      if (this.isTestRoom(room)) continue;
      if (this.onlineCount(room) === 0 || currentTime - room.lastActivityAt >= ROOM_IDLE_TIMEOUT_MS) {
        if (this.onlineCount(room) === 0) {
          room.emptySinceAt ??= currentTime;
          if (currentTime - room.emptySinceAt < ROOM_EMPTY_GRACE_PERIOD_MS) {
            this.publishRoomCalibration(room);
            continue;
          }
        }
        this.closeRoom(room, this.onlineCount(room) === 0 ? "empty" : "idle_timeout");
        continue;
      }
      room.emptySinceAt = undefined;

      // 清理掉线超过 3 分钟的玩家
      for (const player of Object.values(room.players)) {
        if (
          !player.online &&
          !player.isBot &&
          currentTime - player.lastSeenAt >= PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS
        ) {
          delete room.players[player.id];
          if (room.hostPlayerId === player.id) {
            this.reassignHost(room);
          }
          this.touch(room);
          if (this.onlineCount(room) === 0) {
            this.closeRoom(room, "empty");
            continue;
          }
          this.publishRoom(room);
          this.publishLobby();
        }
      }

      if (this.rooms.get(room.roomId) !== room) continue;

      if (
        room.hostReconnectDeadlineAt !== undefined &&
        currentTime >= room.hostReconnectDeadlineAt
      ) {
        this.transferHostAfterDisconnect(room);
      }

      this.publishRoomCalibration(room);
    }
  }

  getRoomSummaries(): CCBRoomSummary[] {
    return [...this.rooms.values()]
      .filter((room) => !this.isTestRoom(room))
      .map((room) => this.buildRoomSummary(room))
      .sort((left, right) => left.roomId.localeCompare(right.roomId));
  }

  private createRoom(
    connection: ConnectionRecord,
    payload: Extract<CCBClientMessage, { type: "ccb.room.create" }>["payload"],
  ) {
    this.ensureConnectionFree(connection);
    const roomId = ensureRoomId(payload.roomId);
    if (this.rooms.has(roomId)) throw new AppError("ROOM_EXISTS", "房间号已被使用");

    const player = this.createPlayer(payload.userName, true);
    const now = this.now();
    const settings = cloneSettings(DEFAULT_CCB_SETTINGS);
    applySettingsPatch(settings, payload.settings ?? {});

    const room: CCBRoomRecord = {
      roomId,
      name: normalizeWord(payload.name),
      visibility: payload.visibility,
      password: payload.visibility === "private" ? this.requirePassword(payload.password) : undefined,
      allowSpectators: payload.allowSpectators,
      hostPlayerId: player.id,
      settings,
      phase: "waiting",
      roundNumber: 0,
      players: { [player.id]: player },
      chat: [],
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    };

    this.rooms.set(roomId, room);
    this.attachConnection(room, player, connection);
    this.appendSystemMessage(room, `${player.name} 创建了房间`);
    this.publishRoom(room);
    this.publishLobby();
    this.log("ccb.room.created", room.roomId, player.id);
    return {
      roomId,
      playerId: player.id,
      sessionToken: player.sessionToken,
      snapshot: this.buildRoomSnapshot(room),
      privateState: this.buildPrivateState(room, player),
    };
  }

  private joinRoom(
    connection: ConnectionRecord,
    roomIdValue: string | undefined,
    payload: Extract<CCBClientMessage, { type: "ccb.room.join" }>["payload"],
  ) {
    this.ensureConnectionFree(connection);
    const room = this.getRoom(ensureRoomId(roomIdValue ?? ""));
    this.ensurePassword(room, payload.password);
    const name = this.requireName(payload.userName);
    if (Object.values(room.players).some((player) => player.name === name && player.membership !== "kicked")) {
      throw new AppError("NAME_CONFLICT", "该用户名已在房间中");
    }

    const membership = room.phase === "waiting" ? "active" : "spectator";
    if (membership === "spectator" && !room.allowSpectators) {
      throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
    }

    const player = this.createPlayer(name, false);
    player.membership = membership;
    room.players[player.id] = player;

    const currentHost = room.players[room.hostPlayerId];
    const hostGraceExpired = room.hostReconnectDeadlineAt === undefined ||
      this.now() >= room.hostReconnectDeadlineAt;
    if (
      !currentHost ||
      currentHost.isBot ||
      currentHost.membership === "kicked" ||
      (!currentHost.online && (this.isTestRoom(room) || hostGraceExpired))
    ) {
      room.hostPlayerId = player.id;
      room.hostReconnectDeadlineAt = undefined;
      player.isReady = true;
    }

    this.attachConnection(room, player, connection);
    this.touch(room);
    this.appendSystemMessage(room, `${player.name} 加入了房间`);
    this.publishRoom(room);
    this.publishLobby();
    this.log("ccb.room.joined", room.roomId, player.id);
    return {
      roomId: room.roomId,
      playerId: player.id,
      sessionToken: player.sessionToken,
      snapshot: this.buildRoomSnapshot(room),
      privateState: this.buildPrivateState(room, player),
    };
  }

  private reconnectRoom(connection: ConnectionRecord, roomIdValue: string, token: string) {
    this.ensureConnectionFree(connection);
    const room = this.getRoom(ensureRoomId(roomIdValue));
    const player = Object.values(room.players).find(
      (candidate) => candidate.sessionToken === token && candidate.membership !== "kicked",
    );
    if (!player) throw new AppError("SESSION_INVALID", "会话令牌无效");

    this.attachConnection(room, player, connection);
    room.emptySinceAt = undefined;
    if (room.hostPlayerId === player.id) room.hostReconnectDeadlineAt = undefined;
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    this.log("ccb.room.reconnected", room.roomId, player.id);
    return {
      roomId: room.roomId,
      playerId: player.id,
      sessionToken: player.sessionToken,
      snapshot: this.buildRoomSnapshot(room),
      privateState: this.buildPrivateState(room, player),
    };
  }

  private leaveRoom(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    delete room.players[player.id];
    connection.roomId = undefined;
    connection.playerId = undefined;

    if (Object.keys(room.players).length === 0 && !this.isTestRoom(room)) {
      this.closeRoom(room, "empty");
      this.log("player.leave", room.roomId, player.id);
      return { left: true, roomClosed: true };
    }

    if (room.hostPlayerId === player.id) {
      room.hostPlayerId = "";
      room.hostReconnectDeadlineAt = undefined;
      this.reassignHost(room);
    }

    this.touch(room);
    this.appendSystemMessage(room, `${player.name} 离开了房间`);
    this.publishRoom(room);
    this.publishLobby();
    this.log("player.leave", room.roomId, player.id);
    return { left: true, roomClosed: false };
  }

  private requestSync(connection: ConnectionRecord) {
    const { room } = this.requireRoomPlayer(connection);
    connection.resetStateSync?.();
    this.publishRoom(room, connection);
    return { synced: true };
  }

  private setReady(connection: ConnectionRecord, ready: boolean) {
    const { room, player } = this.requireRoomPlayer(connection);
    if (room.phase !== "waiting") throw new AppError("INVALID_PHASE", "只能在等待阶段准备");
    if (player.membership !== "active") throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能准备");
    player.isReady = player.id === room.hostPlayerId ? true : ready;
    this.touch(room);
    this.publishRoom(room);
    this.log("player.ready_changed", room.roomId, player.id, { ready: player.isReady });
    return { ready: player.isReady };
  }

  private setSpectator(connection: ConnectionRecord, spectator: boolean) {
    const { room, player } = this.requireRoomPlayer(connection);
    if (room.phase !== "waiting") {
      throw new AppError("INVALID_PHASE", "只有等待阶段可以切换观战身份");
    }
    const nextMembership = spectator ? "spectator" : "active";
    if (player.membership === nextMembership) return { spectator, changed: false };
    if (spectator) {
      if (!room.allowSpectators) throw new AppError("SPECTATORS_DISABLED", "当前房间不允许旁观");
      player.membership = "spectator";
      player.isReady = false;
    } else {
      player.membership = "active";
      player.isReady = player.id === room.hostPlayerId;
    }
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    this.log("player.membership_changed", room.roomId, player.id, { membership: player.membership });
    return { spectator, changed: true };
  }

  private setMessage(connection: ConnectionRecord, rawMessage: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    player.message = normalizeWord(rawMessage).slice(0, CCB_PLAYER_MESSAGE_LIMIT);
    this.touch(room);
    this.publishRoom(room);
    return { message: player.message };
  }

  private updateSettings(
    connection: ConnectionRecord,
    payload: Extract<CCBClientMessage, { type: "ccb.room.updateSettings" }>["payload"],
  ) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (room.phase !== "waiting") {
      throw new AppError("INVALID_PHASE", "只能在等待阶段修改房间设置");
    }
    if (payload.name !== undefined) room.name = normalizeWord(payload.name) || room.name;
    if (payload.visibility !== undefined) room.visibility = payload.visibility;
    if (payload.allowSpectators !== undefined) room.allowSpectators = payload.allowSpectators;
    if (payload.visibility === "public") room.password = undefined;
    if (room.visibility === "private" && payload.password !== undefined) {
      room.password = payload.password.trim() ? payload.password.trim() : room.password;
    }
    if (room.visibility === "private" && !room.password) {
      throw new AppError("PASSWORD_REQUIRED", "私密房间需要密码");
    }

    const nextSettings = cloneSettings(room.settings);
    applySettingsPatch(nextSettings, payload);
    room.settings = nextSettings;

    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    this.log("room.settings_changed", room.roomId, player.id);
    return { settings: room.settings };
  }

  private kick(connection: ConnectionRecord, targetPlayerId: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (targetPlayerId === player.id) throw new AppError("INVALID_TARGET", "房主不能踢出自己");
    const target = room.players[targetPlayerId];
    if (!target || target.membership === "kicked") throw new AppError("PLAYER_NOT_FOUND", "玩家不存在");

    target.membership = "kicked";
    target.online = false;
    const targetConnection = this.connections.findConnectionByPlayer(room.roomId, target.id);
    if (targetConnection) {
      (targetConnection.sendPacket ?? targetConnection.send)(
        createEvent("ccb.room.kicked", { roomId: room.roomId }),
      );
      targetConnection.roomId = undefined;
      targetConnection.playerId = undefined;
      targetConnection.close(4003, "kicked");
    }

    this.touch(room);
    this.appendSystemMessage(room, `${target.name} 被移出房间`);
    this.publishRoom(room);
    this.publishLobby();
    this.log("player.kicked", room.roomId, target.id);
    return { kicked: true };
  }

  private transferHost(connection: ConnectionRecord, targetPlayerId: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    const target = room.players[targetPlayerId];
    if (!target || !target.online || target.membership !== "active") {
      throw new AppError("INVALID_TARGET", "只能转让给在线正式玩家");
    }
    room.hostPlayerId = target.id;
    room.hostReconnectDeadlineAt = undefined;
    target.isReady = true;
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    this.log("room.host_transferred", room.roomId, target.id);
    return { hostPlayerId: target.id };
  }

  private sendChat(connection: ConnectionRecord, rawText: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    const text = normalizeWord(rawText).slice(0, 200);
    if (!text) throw new AppError("INVALID_MESSAGE", "消息不能为空");
    const message: ChatMessage = {
      id: this.createId("ccb_chat"),
      playerId: player.id,
      playerName: player.name,
      text,
      createdAt: this.now(),
      system: false,
    };
    room.chat = [...room.chat, message].slice(-CHAT_LIMIT);
    this.touch(room);
    this.publishRoom(room);
    this.log("chat.sent", room.roomId, player.id);
    return { sent: true };
  }

  private addBots(connection: ConnectionRecord, countValue?: number) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    const count = clampInt(countValue ?? 1, 1, TEST_BOT_BATCH_LIMIT);
    const added: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const botIndex = Object.values(room.players).filter((candidate) => candidate.isBot).length;
      const suffix = BOT_NAME_SUFFIXES[botIndex] ?? String(botIndex + 1);
      const bot = this.createPlayer(`测试人机 ${suffix}`, false, true);
      room.players[bot.id] = bot;
      added.push(bot.id);
    }
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return { added };
  }

  private removeBots(connection: ConnectionRecord, countValue?: number) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    const count = clampInt(countValue ?? 1, 1, TEST_BOT_BATCH_LIMIT);
    const bots = Object.values(room.players)
      .filter((candidate) => candidate.isBot)
      .slice(-count);
    for (const bot of bots) delete room.players[bot.id];
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return { removed: bots.map((bot) => bot.id) };
  }

  private buildRoomSummary(room: CCBRoomRecord): CCBRoomSummary {
    const players = Object.values(room.players).filter(
      (player) => player.membership !== "kicked",
    );
    return {
      roomId: room.roomId,
      name: room.name,
      visibility: room.visibility,
      allowSpectators: room.allowSpectators,
      hasPassword: Boolean(room.password),
      playerCount: players.filter((player) => player.membership === "active").length,
      spectatorCount: players.filter((player) => player.membership === "spectator").length,
      onlineCount: this.onlineCount(room),
      phase: room.phase,
    };
  }

  private buildRoomSnapshot(room: CCBRoomRecord): CCBRoomSnapshot {
    return {
      roomId: room.roomId,
      name: room.name,
      visibility: room.visibility,
      allowSpectators: room.allowSpectators,
      hasPassword: Boolean(room.password),
      hostPlayerId: room.hostPlayerId,
      testMode: this.isTestRoom(room),
      settings: room.settings,
      phase: room.phase,
      roundNumber: room.roundNumber,
      answerSetterPlayerId: room.answerSetterPlayerId,
      players: Object.values(room.players)
        .filter((player) => player.membership !== "kicked")
        .sort((left, right) => left.joinedAt - right.joinedAt)
        .map((player) => this.buildPlayerView(room, player)),
      chat: room.chat,
    };
  }

  private buildPlayerView(room: CCBRoomRecord, player: CCBPlayerRecord): CCBPlayerView {
    return {
      id: player.id,
      name: player.name,
      score: player.score,
      membership: player.membership,
      online: player.online,
      isReady: player.isReady,
      isBot: player.isBot,
      isHost: room.hostPlayerId === player.id,
      message: player.message,
      marks: player.marks,
      guessCount: player.guessCount,
      finished: player.finished,
      team: player.team,
    };
  }

  private buildPrivateState(
    room: CCBRoomRecord,
    player: CCBPlayerRecord,
  ): CCBPrivateState {
    const isActive = player.membership === "active";
    const guessLimit = room.settings.guessLimit;
    return {
      playerId: player.id,
      sessionToken: player.sessionToken,
      // 对局指令（`ccb.game.*`）随 P1 挂载，在此之前不向客户端宣称任何对局能力。
      canSetAnswer: false,
      canGuess: false,
      canSurrender: false,
      canStartRound: false,
      remainingGuesses: isActive ? Math.max(0, guessLimit - player.guessCount) : 0,
      ownGuesses: [],
      hints: [],
    };
  }

  private publishRoom(room: CCBRoomRecord, targetConnection?: ConnectionRecord) {
    const snapshot = this.buildRoomSnapshot(room);
    const connections = targetConnection
      ? [targetConnection]
      : this.connections.getRoomConnections(room.roomId);
    for (const connection of connections) {
      connection.send(createEvent("ccb.room.snapshot", snapshot));
      if (connection.playerId) {
        const player = room.players[connection.playerId];
        if (player) {
          connection.send(createEvent("ccb.game.privateState", this.buildPrivateState(room, player)));
        }
      }
    }
  }

  private publishRoomCalibration(room: CCBRoomRecord) {
    const snapshot = this.buildRoomSnapshot(room);
    for (const connection of this.connections.getRoomConnections(room.roomId)) {
      connection.sendStateSyncCalibration?.(createEvent("ccb.room.snapshot", snapshot));
      if (!connection.playerId) continue;
      const player = room.players[connection.playerId];
      if (player) {
        connection.sendStateSyncCalibration?.(
          createEvent("ccb.game.privateState", this.buildPrivateState(room, player)),
        );
      }
    }
  }

  private publishLobby() {
    this.connections.broadcastToLobby(createEvent("ccb.lobby.rooms", this.getRoomSummaries()));
  }

  private closeRoom(room: CCBRoomRecord, reason: string) {
    this.connections.broadcastToRoom(
      room.roomId,
      createEvent("ccb.room.closed", { roomId: room.roomId, reason }),
    );
    for (const connection of this.connections.getRoomConnections(room.roomId)) {
      connection.roomId = undefined;
      connection.playerId = undefined;
    }
    this.rooms.delete(room.roomId);
    this.publishLobby();
    this.log("room.closed", room.roomId, undefined, { reason });
  }

  private attachConnection(
    room: CCBRoomRecord,
    player: CCBPlayerRecord,
    connection: ConnectionRecord,
  ) {
    const previous = this.connections.findConnectionByPlayer(room.roomId, player.id);
    if (previous && previous.id !== connection.id) {
      (previous.sendPacket ?? previous.send)(createEvent("session.replaced", { roomId: room.roomId }));
      previous.roomId = undefined;
      previous.playerId = undefined;
      previous.close(4001, "session_replaced");
    }
    player.online = true;
    player.connectionId = connection.id;
    player.lastSeenAt = this.now();
    connection.resetStateSync?.();
    connection.roomId = room.roomId;
    connection.playerId = player.id;
  }

  private appendSystemMessage(room: CCBRoomRecord, text: string) {
    room.chat = [
      ...room.chat,
      {
        id: this.createId("ccb_chat"),
        playerId: "system",
        playerName: "系统",
        text,
        createdAt: this.now(),
        system: true,
      },
    ].slice(-CHAT_LIMIT);
  }

  private createPlayer(nameValue: string, host: boolean, isBot = false): CCBPlayerRecord {
    const name = this.requireName(nameValue);
    const now = this.now();
    return {
      id: this.createId(isBot ? "ccb_bot" : "ccb_player"),
      sessionToken: `${this.createId("ccb_session")}_${crypto.randomUUID()}`,
      name,
      membership: "active",
      online: true,
      isReady: host,
      isBot,
      score: 0,
      message: "",
      marks: "",
      guessCount: 0,
      finished: false,
      team: null,
      joinedAt: now,
      lastSeenAt: now,
    };
  }

  private onlineCount(room: CCBRoomRecord) {
    return Object.values(room.players).filter(
      (player) => player.online && player.membership !== "kicked",
    ).length;
  }

  private requireRoomPlayer(connection: ConnectionRecord) {
    if (!connection.roomId || !connection.playerId) {
      throw new AppError("PLAYER_NOT_IN_ROOM", "当前连接尚未加入房间");
    }
    const room = this.getRoom(connection.roomId);
    const player = room.players[connection.playerId];
    if (!player || player.membership === "kicked") throw new AppError("PLAYER_NOT_FOUND", "玩家不存在");
    return { room, player };
  }

  private getRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) throw new AppError("ROOM_NOT_FOUND", "房间不存在");
    return room;
  }

  private ensureConnectionFree(connection: ConnectionRecord) {
    if (connection.roomId || connection.playerId) {
      connection.roomId = undefined;
      connection.playerId = undefined;
    }
  }

  private ensureHost(room: CCBRoomRecord, playerId: string) {
    if (room.hostPlayerId !== playerId) throw new AppError("FORBIDDEN", "只有房主可以执行该操作");
  }

  private ensurePassword(room: CCBRoomRecord, password?: string) {
    if (room.visibility === "private" && room.password !== password?.trim()) {
      throw new AppError("PASSWORD_INCORRECT", "房间密码错误");
    }
  }

  private requirePassword(password?: string) {
    const normalized = password?.trim();
    if (!normalized) throw new AppError("PASSWORD_REQUIRED", "私密房间需要密码");
    return normalized;
  }

  private requireName(value: string) {
    const normalized = normalizeName(value).slice(0, 20);
    if (!normalized) throw new AppError("INVALID_NAME", "用户名不能为空");
    return normalized;
  }

  private reassignHost(room: CCBRoomRecord) {
    const candidates = Object.values(room.players).filter(
      (player) => player.online && player.membership !== "kicked" && !player.isBot,
    );
    const next =
      candidates
        .filter((player) => player.membership === "active")
        .sort((left, right) => left.joinedAt - right.joinedAt)[0] ??
      candidates.sort((left, right) => left.joinedAt - right.joinedAt)[0];
    if (next) {
      room.hostPlayerId = next.id;
      next.isReady = true;
    } else {
      room.hostPlayerId = "";
    }
  }

  private transferHostAfterDisconnect(room: CCBRoomRecord) {
    const previousHost = room.players[room.hostPlayerId];
    if (!previousHost || previousHost.online || previousHost.membership === "kicked") {
      room.hostReconnectDeadlineAt = undefined;
      return;
    }
    room.hostReconnectDeadlineAt = undefined;
    this.reassignHost(room);
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
  }

  private isTestRoom(room: CCBRoomRecord) {
    return room.roomId.toLowerCase() === ROOM_ID_TEST_MODE.toLowerCase();
  }

  private touch(room: CCBRoomRecord) {
    room.updatedAt = this.now();
    room.lastActivityAt = this.now();
  }

  private createId(prefix: string) {
    this.idCounter += 1;
    return `${prefix}_${this.idCounter.toString(36)}`;
  }

  private log(type: string, roomId?: string, playerId?: string, payload?: unknown) {
    void this.options.eventLogger?.write({
      type,
      roomId,
      playerId,
      payload,
      createdAt: this.now(),
    });
  }
}
