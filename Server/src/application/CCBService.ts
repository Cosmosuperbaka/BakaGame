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
  type CCBAnswerView,
  type CCBCharacterSearchResult,
  type CCBGuessRecord,
  type CCBPrivateState,
  type CCBRoomRecord,
  type CCBRoomSnapshot,
  type CCBRoomSummary,
  type CCBRoundRecord,
  type CCBSubjectPick,
} from "../shared/Index";
import {
  CCB_ATTEMPT_MARKS,
  CCB_END_MARK,
  appendCCBEndMarkOnce,
  calculateCCBWinnerScore,
  computeCCBPartialAwardees,
  countCCBAttemptMarks,
  evaluateCCBAttemptLimit,
  generateCCBFeedback,
  isCCBBigWin,
  resolveCCBTimeLimitMs,
  type CCBCharacterView,
  type CCBPartialGuessEntry,
} from "../domain/CCBRules";
import { createEvent } from "../transport/Packets";
import { ConnectionRegistry } from "./ConnectionRegistry";

// CCB 的服务端权威边界与另两个游戏一致：房间生命周期、成员身份、聊天与（P1 起）对局判定
// 全部在服务端完成。原版把出题与 `isPartialCorrect` 放在客户端，本实现不予沿用。

/**
 * 出题与反馈所需的数据源。由 infrastructure 的 `CCBCharacterRepository` 实现；
 * 在 application 层声明接口，是为了不让应用层反向依赖具体仓储实现。
 */
export interface CCBCharacterSource {
  pickRandomSubject(settings: CCBGameSettings): CCBSubjectPick | undefined;
  pickRandomCharacter(subjectId: number, settings: CCBGameSettings): number | undefined;
  buildCharacterView(characterId: number, settings: CCBGameSettings): CCBCharacterView | undefined;
  searchCharacters(keyword: string, limit?: number): CCBCharacterSearchResult[];
}

export interface CCBServiceOptions {
  now?: () => number;
  eventLogger?: EventLogger;
  /** 未注入时对局指令一律报 `CCB_DATA_UNAVAILABLE`（房间骨架仍可用）。 */
  characters?: CCBCharacterSource;
  /** 角色立绘回源；未注入时反馈里不带图。 */
  resolveCharacterImage?: (characterId: number) => Promise<string | undefined>;
}

/** 普通/同步模式的胜者底分（原版固定 2）。 */
const CCB_WINNER_BASE_SCORE = 2;
/** 作品分加成（原版固定 +1）。 */
const CCB_PARTIAL_BONUS_SCORE = 1;
/** 单次角色检索返回上限。 */
const CCB_SEARCH_LIMIT = 20;
/** 抽到「没有主角/配角」的作品时的重试上限。 */
const ROUND_SAMPLE_ATTEMPTS = 8;

const clampInt = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, Math.round(value)));

/** 深拷贝：`metaTags` / `useHints` 是数组，不拷贝会与默认值共享引用。 */
const cloneSettings = (settings: CCBGameSettings): CCBGameSettings => ({
  ...settings,
  metaTags: [...settings.metaTags],
  useHints: [...settings.useHints],
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
  if (patch.metaTags !== undefined) settings.metaTags = [...patch.metaTags];
  if (patch.startYear !== undefined) settings.startYear = patch.startYear;
  if (patch.endYear !== undefined) settings.endYear = patch.endYear;
  if (patch.topNSubjects !== undefined) settings.topNSubjects = patch.topNSubjects;
  if (patch.useSubjectPerYear !== undefined) settings.useSubjectPerYear = patch.useSubjectPerYear;
  if (patch.characterNum !== undefined) settings.characterNum = patch.characterNum;
  if (patch.mainCharacterOnly !== undefined) settings.mainCharacterOnly = patch.mainCharacterOnly;
  if (patch.maxAttempts !== undefined) settings.maxAttempts = patch.maxAttempts;
  if (patch.timeLimitMs !== undefined) settings.timeLimitMs = patch.timeLimitMs;
  if (patch.useHints !== undefined) settings.useHints = [...patch.useHints];
  if (patch.useImageHint !== undefined) settings.useImageHint = patch.useImageHint;
  if (patch.commonTags !== undefined) settings.commonTags = patch.commonTags;
  if (patch.subjectTagNum !== undefined) settings.subjectTagNum = patch.subjectTagNum;
  if (patch.characterTagNum !== undefined) settings.characterTagNum = patch.characterTagNum;
  if (patch.tagBan !== undefined) settings.tagBan = patch.tagBan;
  if (patch.globalPick !== undefined) settings.globalPick = patch.globalPick;
  if (patch.subjectSearch !== undefined) settings.subjectSearch = patch.subjectSearch;

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

  private readonly characters?: CCBCharacterSource;
  private readonly resolveCharacterImage?: (characterId: number) => Promise<string | undefined>;

  constructor(private readonly options: CCBServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.characters = options.characters;
    this.resolveCharacterImage = options.resolveCharacterImage;
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
      case "ccb.character.search":
        return this.searchCharacters(message.payload.keyword);
      case "ccb.game.start":
        return this.startRound(connection);
      case "ccb.game.guess":
        return await this.guess(connection, message.payload.characterId);
      case "ccb.game.surrender":
        return this.surrender(connection);
      case "ccb.game.nextRound":
        return this.startRound(connection);
      case "ccb.game.finish":
        return this.finishGame(connection);
    }
  }

  async runHousekeeping(): Promise<void> {
    const currentTime = this.now();
    for (const room of [...this.rooms.values()]) {
      // 限时到点必须排在「测试房直接跳过」之前：测试房同样要计时。
      if (
        room.phase === "guessing" &&
        room.currentRound?.deadlineAt !== undefined &&
        currentTime >= room.currentRound.deadlineAt
      ) {
        this.applyRoundTimeout(room);
        continue;
      }

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

  // ==================== 对局（P1b：普通模式） ====================
  //
  // 与原版的**根本区别**：出题与反馈判定都在服务端。原版把「选答案」与 `isPartialCorrect`
  // 放在客户端（可作弊），本实现只接受角色 id，其余全部由 `CCBRules` 与本地数据集决定。
  //
  // P1b 范围：普通模式的一局闭环（出题 → 猜测 → 结算 → 下一局）。同步/血战见 P2。

  private requireCharacters(): CCBCharacterSource {
    if (!this.characters) {
      throw new AppError("CCB_DATA_UNAVAILABLE", "角色数据集未接入，无法开局");
    }
    return this.characters;
  }

  /** 正式玩家（含人机）。计分时另行排除人机。 */
  private activePlayers(room: CCBRoomRecord): CCBPlayerRecord[] {
    return Object.values(room.players).filter((candidate) => candidate.membership === "active");
  }

  /**
   * 两级采样：先抽作品、再从该作品的角色里抽一个。
   * 抽到「没有主角/配角」的作品就重试 —— 原版靠 API 返回值重试，这里用固定上限兜底。
   */
  private sampleAnswerCharacter(room: CCBRoomRecord): number {
    const source = this.requireCharacters();
    for (let attempt = 0; attempt < ROUND_SAMPLE_ATTEMPTS; attempt += 1) {
      const subject = source.pickRandomSubject(room.settings);
      if (!subject) break;
      const characterId = source.pickRandomCharacter(subject.id, room.settings);
      if (characterId !== undefined) return characterId;
    }
    throw new AppError(
      "NO_CHARACTER_AVAILABLE",
      "当前设置下抽不到可出题的角色，请放宽年份或题库范围",
    );
  }

  private startRound(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (room.phase === "guessing" || room.phase === "answering") {
      throw new AppError("INVALID_PHASE", "本局尚未结束");
    }

    const actives = this.activePlayers(room);
    if (actives.length === 0) throw new AppError("NO_ACTIVE_PLAYER", "房间里没有正式玩家");
    // 房主默认恒为已准备，所以只需检查其他玩家。
    if (actives.some((candidate) => !candidate.isReady)) {
      throw new AppError("PLAYER_NOT_READY", "还有玩家未准备");
    }

    const answerCharacterId = this.sampleAnswerCharacter(room);
    this.beginRound(room, answerCharacterId);

    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    this.log("game.round_started", room.roomId, player.id, { roundNumber: room.roundNumber });
    return { roundNumber: room.roundNumber };
  }

  private beginRound(room: CCBRoomRecord, answerCharacterId: number) {
    const currentTime = this.now();
    const timeLimitMs = resolveCCBTimeLimitMs(room.settings);

    room.roundNumber += 1;
    room.phase = "guessing";
    // 增强版由服务端出题，这里记录「若为手动出题本该是谁」——出题人分在 P3 才启用。
    room.answerSetterPlayerId = room.hostPlayerId;
    room.revealedAnswer = undefined;

    for (const candidate of Object.values(room.players)) {
      candidate.marks = "";
      candidate.guessCount = 0;
      // 三种人本局不猜测，直接算「已结束」，否则 allSettled 永远为假、整局卡死：
      // 非正式成员、人机（P1b 限制）、以及出题人自己。
      candidate.finished =
        candidate.membership !== "active" ||
        candidate.isBot ||
        candidate.id === room.answerSetterPlayerId;
    }

    room.currentRound = {
      roundNumber: room.roundNumber,
      answerCharacterId,
      answerSetterPlayerId: room.hostPlayerId,
      startedAt: currentTime,
      deadlineAt: timeLimitMs > 0 ? currentTime + timeLimitMs : undefined,
      guesses: {},
      solvedPlayerIds: [],
      bannedTags: [],
    };
  }

  private async guess(connection: ConnectionRecord, characterId: number) {
    const { room, player } = this.requireRoomPlayer(connection);
    const round = room.currentRound;
    if (room.phase !== "guessing" || !round) {
      throw new AppError("INVALID_PHASE", "当前不在猜测阶段");
    }
    if (player.membership !== "active") throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能猜测");
    if (player.finished) throw new AppError("PLAYER_FINISHED", "本局你已经结束了");
    if (player.id === room.answerSetterPlayerId) {
      throw new AppError("SETTER_FORBIDDEN", "出题人不能参与猜测");
    }
    if (this.hasGuessedCharacter(round, player.id, characterId)) {
      throw new AppError("CHARACTER_ALREADY_PICKED", "你已经猜过这个角色了");
    }
    if (room.settings.globalPick && this.isPickedByOthers(round, player.id, characterId)) {
      throw new AppError("CHARACTER_ALREADY_PICKED", "该角色已被其他玩家猜过");
    }

    const source = this.requireCharacters();
    const answer = source.buildCharacterView(round.answerCharacterId, room.settings);
    if (!answer) throw new AppError("CHARACTER_NOT_FOUND", "答案角色数据缺失，请重开一局");
    const guessed = source.buildCharacterView(characterId, room.settings);
    if (!guessed) throw new AppError("CHARACTER_NOT_FOUND", "角色不存在");

    const isCorrect = characterId === round.answerCharacterId;
    const feedback = generateCCBFeedback(guessed, answer, room.settings);

    // 标记顺序照原版：先写尝试标记（✔/❌），猜错且与答案有共同作品时再补 💡，
    // 最后才决定结束标记（✌/👑/💀）。
    let marks = player.marks + (isCorrect ? CCB_ATTEMPT_MARKS.correct : CCB_ATTEMPT_MARKS.wrong);
    if (!isCorrect && feedback.shared_appearances.count > 0) {
      marks += CCB_ATTEMPT_MARKS.partial;
    }

    if (isCorrect) {
      // 大赢家必须在「已含本次尝试标记、尚未追加结束标记」的串上判定：
      // 该函数以尝试次数 === 1 表示「首猜即中」。增强版没有本命头像，故 avatarId 传 null。
      const bigWin = isCCBBigWin({
        marksBeforeGuess: marks,
        avatarId: null,
        answerId: round.answerCharacterId,
      });
      marks = appendCCBEndMarkOnce(marks, bigWin ? CCB_END_MARK.bigWin : CCB_END_MARK.win);
      player.finished = true;
      round.solvedPlayerIds.push(player.id);
    } else {
      const verdict = evaluateCCBAttemptLimit({ marks, maxAttempts: room.settings.maxAttempts });
      if (verdict.shouldApplyDeath) {
        marks = appendCCBEndMarkOnce(marks, CCB_END_MARK.dead);
        player.finished = true;
      }
    }

    player.marks = marks;
    player.guessCount = countCCBAttemptMarks(marks);

    const record: CCBGuessRecord = {
      characterId,
      characterName: guessed.name,
      characterNameCn: guessed.nameCn || guessed.name,
      imageUrl: await this.resolveImage(characterId),
      submittedAt: this.now(),
      correct: isCorrect,
      feedback,
    };
    round.guesses[player.id] = [...(round.guesses[player.id] ?? []), record];

    if (isCorrect) this.appendSystemMessage(room, `${player.name} 猜中了！`);

    this.touch(room);
    this.settleIfRoundEnds(room);
    this.log("game.guessed", room.roomId, player.id, { correct: isCorrect });
    return { correct: isCorrect, feedback };
  }

  private surrender(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    if (room.phase !== "guessing") throw new AppError("INVALID_PHASE", "当前不在猜测阶段");
    if (player.membership !== "active") throw new AppError("SPECTATOR_FORBIDDEN", "旁观者不能投降");
    if (player.finished) throw new AppError("PLAYER_FINISHED", "本局你已经结束了");

    player.marks = appendCCBEndMarkOnce(player.marks, CCB_END_MARK.surrender);
    player.finished = true;
    this.appendSystemMessage(room, `${player.name} 投降了`);
    this.touch(room);
    this.settleIfRoundEnds(room);
    this.log("game.surrendered", room.roomId, player.id);
    return { surrendered: true };
  }

  /**
   * 收尾：该结算就结算，否则只广播。
   *
   * ⚠️ **普通模式一旦出现胜者立即结算**（`Agents/CCB.md §6.4 结束条件`），不是等全员结束；
   * 同步/血战模式（P2）才要等本轮全员完成。这里按 `mode` 分流。
   */
  private settleIfRoundEnds(room: CCBRoomRecord) {
    if (room.phase !== "guessing") {
      this.publishRoom(room);
      return;
    }
    const hasWinner = (room.currentRound?.solvedPlayerIds.length ?? 0) > 0;
    const winnerEndsRound = room.settings.mode === "normal" && hasWinner;
    if (winnerEndsRound || this.allSettled(room)) this.settleRound(room);
    else this.publishRoom(room);
  }

  private allSettled(room: CCBRoomRecord): boolean {
    if (!room.currentRound) return false;
    return this.activePlayers(room).every((candidate) => candidate.finished);
  }

  /**
   * 结算一局。
   *
   * **不结算出题人分**：增强版由服务端出题，没有任何玩家承担「出题人」这个角色，
   * 照原版把出题人分记在房主头上属于凭空加减分。原版那套出题人计分（含血战版）留在
   * `CCBRules` 里，等 P3 的手动出题模式恢复。已登记在 `Agents/CCB.md`。
   */
  private settleRound(room: CCBRoomRecord) {
    const round = room.currentRound;
    if (!round) return;

    room.phase = "settled";
    round.deadlineAt = undefined;

    const active = this.activePlayers(room);
    const winnerIds = new Set(round.solvedPlayerIds);
    const scorers = active.filter((candidate) => !candidate.isBot);

    for (const candidate of scorers) {
      if (!winnerIds.has(candidate.id)) continue;
      const result = calculateCCBWinnerScore({
        guesses: candidate.marks,
        baseScore: CCB_WINNER_BASE_SCORE,
        totalRounds: room.settings.maxAttempts,
      });
      candidate.score += result.totalScore;
    }

    // 作品分：每队/每人只取最早那一次 💡，胜者与出题人不参与。
    const awardees = computeCCBPartialAwardees(this.buildPartialEntries(room));
    for (const candidate of scorers) {
      if (!awardees.has(candidate.id) || winnerIds.has(candidate.id)) continue;
      candidate.score += CCB_PARTIAL_BONUS_SCORE;
    }

    room.revealedAnswer = this.buildRevealedAnswer(room, round.answerCharacterId);
    this.appendSystemMessage(room, this.buildSettleMessage(room, scorers, winnerIds));
    this.touch(room);
    this.publishRoom(room);

    // 答案图要回源，异步补一次发布；拿不到就算了（图片只是装饰）。
    void this.resolveImage(round.answerCharacterId).then((url) => {
      if (!url || !room.revealedAnswer) return;
      room.revealedAnswer = { ...room.revealedAnswer, imageUrl: url };
      this.publishRoom(room);
    });

    this.log("game.round_settled", room.roomId, undefined, { roundNumber: round.roundNumber });
  }

  /** 按原版的判定顺序（先收藏顺序、再同序号按用户名升序）整理作品分候选。 */
  private buildPartialEntries(room: CCBRoomRecord): CCBPartialGuessEntry[] {
    const round = room.currentRound;
    if (!round) return [];
    const entries: CCBPartialGuessEntry[] = [];
    let index = 0;
    for (const candidate of this.activePlayers(room)) {
      for (const record of round.guesses[candidate.id] ?? []) {
        entries.push({
          playerId: candidate.id,
          username: candidate.name,
          index,
          team: candidate.team,
          isAnswerSetter: candidate.id === round.answerSetterPlayerId,
          isPartialCorrect: !record.correct && record.feedback.shared_appearances.count > 0,
          isCorrect: record.correct,
        });
        index += 1;
      }
    }
    return entries;
  }

  private buildRevealedAnswer(room: CCBRoomRecord, characterId: number): CCBAnswerView | undefined {
    const view = this.requireCharacters().buildCharacterView(characterId, room.settings);
    if (!view) return undefined;
    return {
      id: view.id,
      name: view.name,
      nameCn: view.nameCn || view.name,
      revealed: true,
    };
  }

  private buildSettleMessage(
    room: CCBRoomRecord,
    scorers: CCBPlayerRecord[],
    winnerIds: Set<string>,
  ): string {
    const winners = scorers.filter((candidate) => winnerIds.has(candidate.id));
    if (winners.length === 0) return `第 ${room.roundNumber} 局结束，无人猜中`;
    return `第 ${room.roundNumber} 局结束，${winners.map((candidate) => candidate.name).join("、")} 猜中`;
  }

  /** 限时到点：未结束的正式玩家记一次 ⏱️ 并结束，随后统一结算。 */
  private applyRoundTimeout(room: CCBRoomRecord) {
    const round = room.currentRound;
    if (!round || room.phase !== "guessing") return;

    for (const candidate of this.activePlayers(room)) {
      if (candidate.finished) continue;
      const marks = appendCCBEndMarkOnce(
        candidate.marks + CCB_ATTEMPT_MARKS.timeout,
        CCB_END_MARK.dead,
      );
      candidate.marks = marks;
      candidate.guessCount = countCCBAttemptMarks(marks);
      candidate.finished = true;
    }

    this.appendSystemMessage(room, `第 ${room.roundNumber} 局时间到`);
    this.settleIfRoundEnds(room);
  }

  private finishGame(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (room.phase === "waiting") throw new AppError("INVALID_PHASE", "当前没有进行中的对局");

    room.phase = "waiting";
    room.currentRound = undefined;
    room.answerSetterPlayerId = undefined;
    room.revealedAnswer = undefined;
    for (const candidate of Object.values(room.players)) {
      candidate.marks = "";
      candidate.guessCount = 0;
      candidate.finished = false;
      candidate.isReady = candidate.id === room.hostPlayerId;
    }

    this.touch(room);
    this.appendSystemMessage(room, `对局结束，共进行 ${room.roundNumber} 局`);
    this.publishRoom(room);
    this.publishLobby();
    this.log("game.finished", room.roomId, player.id);
    return { finished: true };
  }

  private searchCharacters(keyword: string) {
    const source = this.requireCharacters();
    return { results: source.searchCharacters(keyword, CCB_SEARCH_LIMIT) };
  }

  private hasGuessedCharacter(round: CCBRoundRecord, playerId: string, characterId: number): boolean {
    return (round.guesses[playerId] ?? []).some((record) => record.characterId === characterId);
  }

  private isPickedByOthers(round: CCBRoundRecord, playerId: string, characterId: number): boolean {
    return Object.entries(round.guesses).some(
      ([otherId, records]) =>
        otherId !== playerId && records.some((record) => record.characterId === characterId),
    );
  }

  /** 角色立绘回源。图片只是装饰，失败不该让一次合法操作整体失败。 */
  private async resolveImage(characterId: number): Promise<string | undefined> {
    if (!this.resolveCharacterImage) return undefined;
    try {
      return await this.resolveCharacterImage(characterId);
    } catch {
      return undefined;
    }
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
      guessDeadlineAt: room.currentRound?.deadlineAt,
      answer: room.revealedAnswer,
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
    const round = room.currentRound;
    const isActive = player.membership === "active";
    const maxAttempts = room.settings.maxAttempts;
    // 出题人自己不参与猜测；只有正式且本局未结束的玩家才能猜。
    const inPlay =
      isActive &&
      room.phase === "guessing" &&
      !player.finished &&
      player.id !== room.answerSetterPlayerId;
    return {
      playerId: player.id,
      sessionToken: player.sessionToken,
      // 手动出题属 P3，在此之前不宣称该能力。
      canSetAnswer: false,
      canGuess: inPlay,
      canSurrender: inPlay,
      canStartRound:
        player.id === room.hostPlayerId && (room.phase === "waiting" || room.phase === "settled"),
      remainingGuesses: isActive ? Math.max(0, maxAttempts - player.guessCount) : 0,
      // 只下发自己的猜测记录：反馈里含答案相关线索，不能给别人看。
      ownGuesses: round?.guesses[player.id] ?? [],
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
