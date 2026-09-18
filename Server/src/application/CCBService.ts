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
import { ensureRoomId, normalizeName, normalizeWord, safeEqualToken } from "../domain/Rules";
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
  maskCCBFeedbackTags,
  mergeCCBBannedTags,
  resolveCCBNonstopRankScore,
  resolveCCBSetterScore,
  resolveCCBSyncVerdict,
  resolveCCBTimeLimitMs,
  revealCCBBannedTagsToAll,
  stageCCBBannedTags,
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

    // 正在出题的人掉线 → 房间退回等待，否则会一直停在 `answering` 等一个不在的人。
    this.clearPendingSetter(room, player.id);

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
      case "ccb.game.chooseSetter":
        return this.chooseSetter(connection, message.payload.playerId);
      case "ccb.game.setAnswer":
        return this.setAnswer(connection, message.payload.characterId);
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
    // 同一条连接重连它本来就在的那个房间时不能走 leaveRoom：
    // 那会先把自己的 player 记录删掉，随后的按 token 查找必然落空。
    const targetRoomId = ensureRoomId(roomIdValue);
    if (!(connection.roomId === targetRoomId && connection.playerId)) {
      this.ensureConnectionFree(connection);
    }
    const room = this.getRoom(targetRoomId);
    const player = Object.values(room.players).find(
      (candidate) =>
        safeEqualToken(candidate.sessionToken, token) && candidate.membership !== "kicked",
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
    // 被踢的正好是正在出题的出题人：退回等待阶段，否则房间会永久停在 `answering`
    //（原版的 `waitForAnswerCanceled` 就是干这件事的）。
    this.clearPendingSetter(room, target.id);
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

  /**
   * 开局前的共通校验：至少一个正式玩家、且全部已准备（房主默认恒为已准备）。
   *
   * `startRound` / `chooseSetter` / `setAnswer` 三处入口共用 —— 手动出题会跨越
   * 「指定出题人 → 出题人提交答案」两次请求，所以这一步必须能重复执行。
   */
  private ensureCanStartRound(room: CCBRoomRecord) {
    if (this.activePlayers(room).length === 0) {
      throw new AppError("NO_ACTIVE_PLAYER", "房间里没有正式玩家");
    }
    if (this.activePlayers(room).some((candidate) => !candidate.isReady)) {
      throw new AppError("PLAYER_NOT_READY", "还有玩家未准备");
    }
  }

  /**
   * 撤销「等待出题」：出题人被踢或掉线时把房间退回 `waiting`。
   *
   * 不这么做房间会**永久停在 `answering`** —— 答案只有那一个人能交，而他已经不在了。
   * 返回是否真的撤销过（调用方据此决定要不要广播）。原版对应 `waitForAnswerCanceled`。
   */
  private clearPendingSetter(room: CCBRoomRecord, playerId: string): boolean {
    if (room.phase !== "answering" || room.answerSetterPlayerId !== playerId) return false;
    room.phase = "waiting";
    room.answerSetterPlayerId = undefined;
    room.currentRound = undefined;
    this.appendSystemMessage(room, "出题已取消，等待房主重新指定出题人");
    return true;
  }

  private startRound(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    // 停在 `answering` 时再次「开始游戏」= 放弃手动出题、改由服务端抽题 —— 这是房主
    // 在「指定的出题人迟迟不交答案（但还连着）」时的退出口，`beginRound` 会覆盖掉出题人。
    if (room.phase === "guessing") throw new AppError("INVALID_PHASE", "本局尚未结束");
    this.ensureCanStartRound(room);

    const answerCharacterId = this.sampleAnswerCharacter(room);
    this.beginRound(room, answerCharacterId);

    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    this.log("game.round_started", room.roomId, player.id, { roundNumber: room.roundNumber });
    return { roundNumber: room.roundNumber };
  }

  /**
   * 房主指定出题人 —— 手动出题的第一步（原版 `setAnswerSetter` → `waitForAnswer`）。
   *
   * 允许在 `waiting` / `settled` 指定，也允许在 `answering` **改指定**：原版只拒绝
   * 「游戏进行中」，反复调用是一次合法的换人，本项目沿用它作为「出题人卡住」的恢复手段。
   * 之后必须由被指定的人提交答案，房间才会离开 `answering`。
   */
  private chooseSetter(connection: ConnectionRecord, playerId: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);
    if (room.phase === "guessing") throw new AppError("INVALID_PHASE", "本局尚未结束");

    const target = room.players[playerId];
    if (!target || target.membership !== "active") {
      throw new AppError("PLAYER_NOT_FOUND", "找不到选中的玩家");
    }
    // 人机不参与猜测（P1b 限制），更不能出题 —— 否则这一局必然无人能猜。
    if (target.isBot) throw new AppError("SETTER_FORBIDDEN", "人机不能出题");
    this.ensureCanStartRound(room);

    room.phase = "answering";
    room.answerSetterPlayerId = target.id;
    room.currentRound = undefined;
    room.revealedAnswer = undefined;
    this.appendSystemMessage(room, `等待 ${target.name} 出题`);
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    this.log("game.setter_chosen", room.roomId, target.id);
    return { setterPlayerId: target.id };
  }

  /**
   * 出题人提交答案 —— 手动出题的第二步，提交后直接开局（原版 `setAnswer`）。
   *
   * 只收 `characterId`：反馈所需的其余字段一律由服务端从本地数据集补齐。原版是把客户端
   * 加密过的整个角色对象丢给服务端，这里换成「只报 id、服务端自己查」，防作弊面更小。
   */
  private setAnswer(connection: ConnectionRecord, characterId: number) {
    const { room, player } = this.requireRoomPlayer(connection);
    if (room.phase !== "answering") throw new AppError("INVALID_PHASE", "当前不在出题阶段");
    if (player.id !== room.answerSetterPlayerId) {
      throw new AppError("SETTER_FORBIDDEN", "你不是本局出题人");
    }
    if (!this.requireCharacters().buildCharacterView(characterId, room.settings)) {
      throw new AppError("CHARACTER_NOT_FOUND", "角色不存在");
    }
    // 出题人停在出题阶段期间，其他人可能取消了准备 —— 开局前必须重新校验一次。
    this.ensureCanStartRound(room);

    this.beginRound(room, characterId, { manualSetterId: player.id });
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    this.log("game.answer_set", room.roomId, player.id, { characterId });
    return { roundNumber: room.roundNumber };
  }

  private beginRound(
    room: CCBRoomRecord,
    answerCharacterId: number,
    { manualSetterId }: { manualSetterId?: string } = {},
  ) {
    const currentTime = this.now();
    const timeLimitMs = resolveCCBTimeLimitMs(room.settings);
    const isManual = manualSetterId !== undefined;
    // 服务端出题**只是把出题人记成房主**（原版那套出题人奖惩没有对象，靠 `answerIsManual` 拦住）；
    // 手动出题则沿用房主已经指定的那位。
    const setterId = manualSetterId ?? room.hostPlayerId;

    room.roundNumber += 1;
    room.phase = "guessing";
    room.answerSetterPlayerId = setterId;
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
      answerSetterPlayerId: setterId,
      answerIsManual: isManual,
      startedAt: currentTime,
      deadlineAt: timeLimitMs > 0 ? currentTime + timeLimitMs : undefined,
      guesses: {},
      solvedPlayerIds: [],
      // 标签 BP 每局重置（原版 `tagBanState` 挂在单局 `currentGame` 上）。
      bannedTags: [],
      bannedTagRevealers: {},
      pendingBannedTags: [],
      // 模式推进状态：原版挂在单局 `currentGame` 上，所以随每局重置。
      syncRound: 1,
      syncCompletedPlayerIds: [],
      nonstopWinnerIds: [],
      // 血战名次分的基数：开局时快照参战人数（原版 `socket.js` 的 `nonstopTotalPlayers`）。
      // 上面刚把「本局不猜的人」置为 `finished`，所以直接数未结束者即可。
      nonstopTotalPlayers: Object.values(room.players).filter((candidate) => !candidate.finished)
        .length,
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
    // 同步模式每人每轮只能猜一次：猜完要等本轮其他人完成。
    if (room.settings.mode === "sync" && this.isSyncRoundCompleted(round, player.id)) {
      throw new AppError("SYNC_ROUND_COMPLETED", "本轮你已经猜过了，等本轮结束");
    }
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

    // 标签全局 BP：猜中的共享标签先入「待提交」，**本局结算时才生效**（原版同理）。
    // 已提交的标签要排除 —— 「谁先揭示归谁」，后来者不算揭示者。
    if (room.settings.tagBan && feedback.metaTags.shared.length > 0) {
      round.pendingBannedTags = [
        ...round.pendingBannedTags,
        ...stageCCBBannedTags(feedback.metaTags.shared, player.id, round.bannedTags),
      ];
    }

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

    // 血战：猜对当场按名次加分（原版 `settleNonstopCorrectGuess`），
    // 所以结算阶段对血战不再重复计胜者分。
    if (isCorrect && room.settings.mode === "bloodbath") this.registerNonstopWinner(room, player);
    // 同步：无论猜对猜错都算「本轮完成」，猜对的人已 `finished`、会退出参战名单。
    this.markSyncCompleted(room, player);

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
    this.advanceOrSettle(room);
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
    // 同步模式：投降同样算「本轮完成」，否则残局会卡在等一个永远不会再猜的人。
    this.markSyncCompleted(room, player);
    this.appendSystemMessage(room, `${player.name} 投降了`);
    this.touch(room);
    this.advanceOrSettle(room);
    this.log("game.surrendered", room.roomId, player.id);
    return { surrendered: true };
  }

  /**
   * 收尾：该结算就结算、该推进就推进，否则只广播。
   *
   * 三种模式的收尾条件完全不同（真相源 `Agents/CCB.md §6.6`）：
   * - `normal`：**一旦出现胜者立即结算**（§6.4 结束条件），不等其他人猜完；无人猜中则等全员结束。
   * - `sync`：胜者也要**等本轮全员完成**才结算；本轮完成但还没胜者就推进轮次。
   * - `bloodbath`：与轮次无关，猜对不收尾，一直打到**全员结束**（原版 `remainingPlayers` 归零）。
   */
  private advanceOrSettle(room: CCBRoomRecord) {
    const round = room.currentRound;
    if (room.phase !== "guessing" || !round) {
      this.publishRoom(room);
      return;
    }

    const hasWinner = round.solvedPlayerIds.length > 0;
    if (room.settings.mode !== "sync") {
      // 普通与血战共用「全员结束」这一条，区别只在普通模式多一个「胜者立即收尾」。
      const normalWinnerEnds = room.settings.mode === "normal" && hasWinner;
      if (normalWinnerEnds || this.allSettled(room)) this.settleRound(room);
      else this.publishRoom(room);
      return;
    }

    const verdict = resolveCCBSyncVerdict({
      participantIds: this.syncParticipants(room).map((candidate) => candidate.id),
      completedIds: round.syncCompletedPlayerIds,
      hasWinner,
    });
    if (verdict === "settle") {
      this.settleRound(room);
      return;
    }
    if (verdict === "advance") this.beginSyncRound(room);
    this.publishRoom(room);
  }

  /** 推进到下一个同步轮次，并按设置重置本轮计时。 */
  private beginSyncRound(room: CCBRoomRecord) {
    const round = room.currentRound;
    if (!round) return;
    round.syncRound += 1;
    round.syncCompletedPlayerIds = [];
    // 同步模式的计时是「每轮一份」：猜错不重置（见 `shouldResetTimerAfterGuess`），换轮才重置。
    const timeLimitMs = resolveCCBTimeLimitMs(room.settings);
    round.deadlineAt = timeLimitMs > 0 ? this.now() + timeLimitMs : undefined;
    this.appendSystemMessage(room, `第 ${round.syncRound} 轮开始`);
    this.log("game.sync_round_started", room.roomId, undefined, { syncRound: round.syncRound });
  }

  /**
   * 同步模式的参战玩家：正式、非人机、**本局尚未结束**。
   *
   * 「已结束」= 已带 ✌/👑/💀/🏳️ 结束标记。`beginRound` 已把非正式成员、人机与出题人
   * 提前置为已结束，所以这里直接看 `finished` 就等价于原版的 `isEnded(p)`。
   */
  private syncParticipants(room: CCBRoomRecord): CCBPlayerRecord[] {
    return this.activePlayers(room).filter((candidate) => !candidate.finished);
  }

  /**
   * 标签 BP 的「本轮参战玩家」：正式、非人机、非出题人，**含已结束者**。
   *
   * ⚠️ 与 `syncParticipants` 的口径**不同、不能合并**：原版在同步收尾时给「本轮所有参战
   * 玩家」开透视（`gameplay.js` 的 `updateSyncProgress`），当时已猜对/出局的人也在名单里。
   */
  private roundParticipantIds(room: CCBRoomRecord): string[] {
    return this.activePlayers(room)
      .filter((candidate) => !candidate.isBot && candidate.id !== room.answerSetterPlayerId)
      .map((candidate) => candidate.id);
  }

  /**
   * 记一次「同步本轮完成」。
   *
   * ⚠️ **非同步模式必须保持列表为空**：这个列表同时是「本轮已猜过」的判据，
   * 无条件写入会把普通/血战模式的连续猜测误判成重复提交。
   */
  private markSyncCompleted(room: CCBRoomRecord, player: CCBPlayerRecord) {
    const round = room.currentRound;
    if (!round || room.settings.mode !== "sync") return;
    if (this.isSyncRoundCompleted(round, player.id)) return;
    round.syncCompletedPlayerIds = [...round.syncCompletedPlayerIds, player.id];
  }

  private isSyncRoundCompleted(round: CCBRoundRecord, playerId: string): boolean {
    return round.syncCompletedPlayerIds.includes(playerId);
  }

  /**
   * 血战：猜对当场按名次加分（原版 `settleNonstopCorrectGuess`）。
   *
   * 名次分 = `max(1, 参战人数 − 已胜人数)`，再叠加大赢家/快猜加成。与普通模式的 2 分底分
   * 不同，所以**结算阶段对血战不再计胜者分**。同一人重复猜中只记一次（对应原版的
   * `alreadySettled` 短路）。
   */
  private registerNonstopWinner(room: CCBRoomRecord, player: CCBPlayerRecord) {
    const round = room.currentRound;
    if (!round || round.nonstopWinnerIds.includes(player.id)) return;
    const result = calculateCCBWinnerScore({
      guesses: player.marks,
      baseScore: resolveCCBNonstopRankScore(round.nonstopTotalPlayers, round.nonstopWinnerIds.length),
      totalRounds: room.settings.maxAttempts,
    });
    player.score += result.totalScore;
    round.nonstopWinnerIds = [...round.nonstopWinnerIds, player.id];
  }

  /**
   * 结算真人出题人的分（原版 `finalizeStandardGame` / `finalizeNonstopGame`）。
   *
   * ⚠️ **只在 `round.answerIsManual` 时调用**：服务端出题的房间没有任何玩家承担出题人，
   * 照原版把这套奖惩记到房主头上属于凭空加减分（这条差异在 P1 起就登记着，P3 手动出题
   * 恢复后才真正启用）。
   *
   * 它是全局**唯一可能为负**的计分项：大赢家 → 扣大赢家得分的一半；太简单 → −1；
   * 没人猜中 → −1（血战按参战人数加倍）。规则本身在 `resolveCCBSetterScore`。
   */
  private applySetterScore(
    room: CCBRoomRecord,
    round: CCBRoundRecord,
    primaryWinner: CCBPlayerRecord | undefined,
    scorers: CCBPlayerRecord[],
    winnerIds: ReadonlySet<string>,
  ) {
    const setter = room.players[round.answerSetterPlayerId];
    if (!setter || setter.isBot) return;

    const winners = scorers.filter((candidate) => winnerIds.has(candidate.id));
    // 大赢家得分要拿**实际总得分**（含底分与加成），原版两条分支都按 base 2 重算取最大。
    const bigWinnerScore = winners
      .filter((candidate) => candidate.marks.includes(CCB_END_MARK.bigWin))
      .reduce(
        (highest, candidate) =>
          Math.max(
            highest,
            calculateCCBWinnerScore({
              guesses: candidate.marks,
              baseScore: CCB_WINNER_BASE_SCORE,
              totalRounds: room.settings.maxAttempts,
            }).totalScore,
          ),
        0,
      );

    const result = resolveCCBSetterScore({
      mode: room.settings.mode,
      winnerMarks: primaryWinner?.marks ?? "",
      // ⚠️ 这里要的是**计分口径**的已猜次数，不是 `countCCBAttemptMarks` —— 原版正是用
      // `baseScore: 0` 的那份结果取 `guessCount`。
      winnerGuessCount: primaryWinner
        ? calculateCCBWinnerScore({
            guesses: primaryWinner.marks,
            baseScore: 0,
            totalRounds: room.settings.maxAttempts,
          }).guessCount
        : 0,
      bigWinnerScore,
      winnersCount: winners.length,
      totalPlayers: round.nonstopTotalPlayers,
      totalRounds: room.settings.maxAttempts,
    });

    setter.score += result.score;
    const signed = result.score > 0 ? `+${result.score}` : `${result.score}`;
    this.appendSystemMessage(
      room,
      result.reason
        ? `出题人 ${setter.name} ${signed} · ${result.reason}`
        : `出题人 ${setter.name} ${signed}`,
    );
    this.log("game.setter_scored", room.roomId, setter.id, {
      score: result.score,
      reason: result.reason,
    });
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

    // 标签全局 BP 生效点：合并本局待提交条目（只收新标签，后来者不算揭示者）。
    // 同步模式额外把**本轮所有参战玩家**并入 revealer —— 同轮的猜测视为同时发生，
    // 于是本轮冒出来的标签对整轮参与者都是透过的（原版 `updateSyncProgress`）。
    if (round.pendingBannedTags.length > 0) {
      const pending =
        room.settings.mode === "sync"
          ? revealCCBBannedTagsToAll(round.pendingBannedTags, this.roundParticipantIds(room))
          : round.pendingBannedTags;
      const merged = mergeCCBBannedTags(
        round.bannedTags.map((tag) => ({ tag, revealer: round.bannedTagRevealers[tag] ?? [] })),
        pending,
      );
      round.bannedTags = merged.map((entry) => entry.tag);
      round.bannedTagRevealers = Object.fromEntries(
        merged.map((entry) => [entry.tag, entry.revealer]),
      );
      round.pendingBannedTags = [];
    }

    const active = this.activePlayers(room);
    const winnerIds = new Set(round.solvedPlayerIds);
    const scorers = active.filter((candidate) => !candidate.isBot);
    // 首个胜者（原版 `firstWinner`）：同步模式的所有胜者都按他的标记串算同一份分数。
    const primaryWinner = scorers.find((candidate) => candidate.id === round.solvedPlayerIds[0]);
    // ⚠️ 同步模式**共享胜者分**：原版用首个胜者的标记算一次，再 `forEach` 给每个胜者加同一个数；
    // 其余模式各算各的。普通模式只有一个胜者，两者等价，但同步模式差别很大，别合并。
    const sharedMarks = room.settings.mode === "sync" ? primaryWinner?.marks : undefined;

    for (const candidate of scorers) {
      if (!winnerIds.has(candidate.id)) continue;
      // 血战的名次分在猜对当场就发了（见 `registerNonstopWinner`），这里必须跳过，
      // 否则同一份胜者分会被计两次。
      if (room.settings.mode === "bloodbath") continue;
      const result = calculateCCBWinnerScore({
        guesses: sharedMarks ?? candidate.marks,
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

    // 出题人分：**只在真人出题时结算**（见 `CCBRoundRecord.answerIsManual`）。
    if (round.answerIsManual) {
      this.applySetterScore(room, round, primaryWinner, scorers, winnerIds);
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

  /**
   * 限时到点。两种口径（`Agents/CCB.md §6.6`）：
   * - 普通 / 血战：未结束的正式玩家记一次 ⏱️ 并**结束本局**，随后统一结算；
   * - 同步：⏱️ 只算「本轮完成」，**不结束本局** —— 记完就推进轮次继续猜
   *   （次数真的耗尽了照样 💀）。
   */
  private applyRoundTimeout(room: CCBRoomRecord) {
    const round = room.currentRound;
    if (!round || room.phase !== "guessing") return;

    if (room.settings.mode === "sync") {
      for (const candidate of this.syncParticipants(room)) {
        if (this.isSyncRoundCompleted(round, candidate.id)) continue;
        const timedOut = candidate.marks + CCB_ATTEMPT_MARKS.timeout;
        const verdict = evaluateCCBAttemptLimit({
          marks: timedOut,
          maxAttempts: room.settings.maxAttempts,
        });
        candidate.marks = verdict.shouldApplyDeath
          ? appendCCBEndMarkOnce(timedOut, CCB_END_MARK.dead)
          : timedOut;
        candidate.guessCount = countCCBAttemptMarks(candidate.marks);
        if (verdict.shouldApplyDeath) candidate.finished = true;
        this.markSyncCompleted(room, candidate);
      }
      this.appendSystemMessage(room, `第 ${round.syncRound} 轮时间到`);
      this.advanceOrSettle(room);
      return;
    }

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
    this.advanceOrSettle(room);
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

  /**
   * 标签全局 BP 的展示层遮掩。
   *
   * **只作用于下发副本，绝不改存档**：局内结算（作品分、计分）读的仍是未遮掩的
   * `record.feedback`，遮掩只在 `buildPrivateState` 这一层发生。
   */
  private maskOwnGuesses(room: CCBRoomRecord, playerId: string): CCBGuessRecord[] {
    const round = room.currentRound;
    const records = round?.guesses[playerId] ?? [];
    if (!round || !room.settings.tagBan || round.bannedTags.length === 0) return records;

    const entitled = new Set(
      Object.entries(round.bannedTagRevealers)
        .filter(([, revealers]) => revealers.includes(playerId))
        .map(([tag]) => tag),
    );
    return records.map((record) => ({
      ...record,
      feedback: maskCCBFeedbackTags(record.feedback, round.bannedTags, entitled),
    }));
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
      bannedTags: room.currentRound?.bannedTags ?? [],
      // 模式推进进度：只下发当前模式用得上的那份，避免给客户端塞永远为空的数组。
      syncProgress:
        room.settings.mode === "sync" && room.currentRound
          ? {
              round: room.currentRound.syncRound,
              completedPlayerIds: room.currentRound.syncCompletedPlayerIds,
            }
          : undefined,
      nonstopWinnerIds:
        room.settings.mode === "bloodbath"
          ? (room.currentRound?.nonstopWinnerIds ?? [])
          : undefined,
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
    // 同步模式每人每轮只能猜一次：本轮猜过（或超时）的人要等轮次推进，先置灰。
    const syncCompleted =
      room.settings.mode === "sync" && !!round && this.isSyncRoundCompleted(round, player.id);
    // 出题人自己不参与猜测；只有正式且本局未结束的玩家才能猜。
    const inPlay =
      isActive &&
      room.phase === "guessing" &&
      !player.finished &&
      !syncCompleted &&
      player.id !== room.answerSetterPlayerId;
    return {
      playerId: player.id,
      sessionToken: player.sessionToken,
      // 手动出题：只有被房主指定、且还停在出题阶段的那个人能提交答案。
      canSetAnswer: room.phase === "answering" && player.id === room.answerSetterPlayerId,
      canGuess: inPlay,
      canSurrender: inPlay,
      canStartRound: player.id === room.hostPlayerId && room.phase !== "guessing",
      remainingGuesses: isActive ? Math.max(0, maxAttempts - player.guessCount) : 0,
      // 只下发自己的猜测记录：反馈里含答案相关线索，不能给别人看。
      // 标签全局 BP 还要按观众再遮掩一层（见 `maskOwnGuesses`）。
      ownGuesses: this.maskOwnGuesses(room, player.id),
      hints: [],
      syncCompleted,
      setterAnswer: this.buildSetterAnswer(room, player),
    };
  }

  /**
   * 出题人在本局进行中看到的答案卡。
   *
   * 答案不能进 `snapshot`：那份快照是全房广播的同一份对象，放进去等于把答案发给所有人。
   * 手动出题时出题人自己就是「知道答案的人」，所以走私有状态单独下发，
   * 刷新页面也不会丢（原版是客户端本地留着，一刷新就没了）。
   */
  private buildSetterAnswer(
    room: CCBRoomRecord,
    player: CCBPlayerRecord,
  ): CCBAnswerView | undefined {
    const round = room.currentRound;
    if (!round?.answerIsManual || round.answerSetterPlayerId !== player.id) return undefined;
    if (room.phase !== "guessing" && room.phase !== "settled") return undefined;
    // `revealed: false` = 还没有对其他人公开（对局结束后 `snapshot.answer` 才是公开的那份）。
    const view = this.requireCharacters().buildCharacterView(round.answerCharacterId, room.settings);
    if (!view) return undefined;
    return {
      id: view.id,
      name: view.name,
      nameCn: view.nameCn || view.name,
      revealed: false,
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
    if (!connection.roomId && !connection.playerId) return;
    // 与 SonGuessr 同款：置空连接字段却不动房间里的 player 记录，会留下
    // 「在线但没有任何连接」的幽灵玩家，房间号被耗尽后只能重启恢复。
    if (connection.roomId && connection.playerId && this.rooms.has(connection.roomId)) {
      this.leaveRoom(connection);
      return;
    }
    connection.roomId = undefined;
    connection.playerId = undefined;
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
