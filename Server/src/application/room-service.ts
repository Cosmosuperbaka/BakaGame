import { AppError } from "../domain/errors";
import type {
  ChatMessage,
  ConnectionRecord,
  DescriptionRecord,
  GamePhase,
  GameRound,
  NightActionRecord,
  PlayerRecord,
  PlayerRole,
  PrivateState,
  PublicPlayerView,
  RoleConfig,
  RoomRecord,
  RoomSnapshot,
  RoomSummary,
  RoundWinner,
  VoteRecord,
} from "../domain/model";
import { ROOM_ID_TEST_MODE } from "../domain/model";
import {
  createDefaultRoleConfig,
  assignRoles,
  computeVoteOutcome,
  ensureRoomId,
  evaluateBlankGuess,
  getBlankPlayerId,
  getRoomRoleLimits,
  getWinnerAfterBlankFailure,
  listPlayablePlayerIds,
  normalizeName,
  normalizeWord,
  recordEliminations,
  resolveNightEliminations,
  shouldEnterFinalBlankGuess,
  validateRoleConfig,
  type RandomSource,
} from "../domain/rules";
import type { LogEntry } from "../infrastructure/event-logger";
import { EventLogger } from "../infrastructure/event-logger";
import { WordBankRepository } from "../infrastructure/word-bank-repository";
import { createEvent, type ClientMessage } from "../transport/protocol";

const ROOM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const QUESTIONER_RECONNECT_TIMEOUT_MS = 60 * 1000;
const CHAT_LIMIT = 200;
// 测试模式用于预填 UI 的默认词对（仅跳转阶段时兜底使用）。
const TEST_MODE_DEFAULT_WORD: [string, string] = ["苹果", "香蕉"];

export interface RoomServiceOptions {
  now?: () => number;
  random?: RandomSource;
  wordBankRepository: WordBankRepository;
  eventLogger: EventLogger;
}

export class RoomService {
  // ==================== 房间与状态机总控 ====================

  private readonly rooms = new Map<string, RoomRecord>();
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly now: () => number;
  private readonly random: RandomSource;
  private idCounter = 0;

  constructor(private readonly options: RoomServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.random =
      options.random ??
      ({
        nextInt: (maxExclusive: number) =>
          Math.floor(Math.random() * Math.max(maxExclusive, 1)),
      } satisfies RandomSource);
  }

  registerConnection(connection: ConnectionRecord): void {
    this.connections.set(connection.id, connection);
  }

  // 连接断开时只做连接解绑，真正的房间副作用统一交给 handlePlayerOffline。
  async unregisterConnection(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);

    if (!connection) {
      return;
    }

    this.connections.delete(connectionId);

    if (!connection.roomId || !connection.playerId) {
      return;
    }

    const room = this.rooms.get(connection.roomId);

    if (!room) {
      return;
    }

    await this.handlePlayerOffline(room, connection.playerId, "disconnect");
  }

  async execute(connectionId: string, message: ClientMessage): Promise<unknown> {
    // 所有命令都从这里进入，方便统一做连接上下文解析与后续审计。
    const connection = this.getConnection(connectionId);

    switch (message.type) {
      case "lobby.subscribeRooms":
        connection.lobbySubscribed = true;
        this.publishLobby();
        return { subscribed: true };
      case "room.create":
        return this.handleRoomCreate(connection, message);
      case "room.join":
        return this.handleRoomJoin(connection, message);
      case "room.reconnect":
        return this.handleRoomReconnect(connection, message);
      case "room.leave":
        return this.handleRoomLeave(connection);
      case "player.rename":
        return this.handleRename(connection, message.payload.name);
      case "player.setSpectator":
        return this.handleSetSpectator(connection, message.payload.spectator);
      case "player.setReady":
        return this.handleSetReady(connection, message.payload.ready);
      case "room.updateSettings":
        return this.handleUpdateSettings(connection, message.payload);
      case "room.kick":
        return this.handleKick(connection, message.payload.playerId);
      case "game.assignQuestioner":
        return this.handleAssignQuestioner(connection, message.payload.playerId);
      case "game.submitWords":
        return this.handleSubmitWords(connection, message.payload.words, message.payload.blankHint);
      case "game.advancePhase":
        return this.handleAdvancePhase(connection);
      case "game.submitDescription":
        return this.handleSubmitDescription(connection, message.payload.text);
      case "game.submitVote":
        return this.handleSubmitVote(connection, message.payload.targetId);
      case "game.submitNightAction":
        return this.handleSubmitNightAction(connection, message.payload.targetId);
      case "game.submitBlankGuess":
        return this.handleSubmitBlankGuess(connection, message.payload.words);
      case "game.resolveDisconnect":
        return this.handleResolveDisconnect(
          connection,
          message.payload.playerId,
          message.payload.resolution,
        );
      case "chat.send":
        return this.handleChat(connection, message.payload.text);
      case "room.transferHost":
        return this.handleTransferHost(connection, message.payload.playerId);
      case "test.jumpToPhase":
        return this.handleTestJumpToPhase(connection, message.payload.phase);
      case "test.setMyRole":
        return this.handleTestSetMyRole(connection, message.payload.role);
      default:
        throw new AppError("UNSUPPORTED_COMMAND", "暂不支持的命令");
    }
  }

  async runHousekeeping(): Promise<void> {
    // 统一处理空房清理、闲置超时和出题人掉线超时。
    const currentTime = this.now();

    for (const room of [...this.rooms.values()]) {
      // 测试房间不参与闲置/空房自动清理，方便开发者随时回来继续调试。
      const isTestRoom = room.id === ROOM_ID_TEST_MODE;

      if (!isTestRoom && this.getOnlineCount(room) === 0) {
        await this.closeRoom(room, "empty");
        continue;
      }

      if (!isTestRoom && currentTime - room.lastActivityAt >= ROOM_IDLE_TIMEOUT_MS) {
        this.broadcastRoomEvent(room, "room.expiring", {
          roomId: room.id,
          reason: "idle_timeout",
        });
        await this.closeRoom(room, "idle_timeout");
        continue;
      }

      if (
        room.round?.questionerReconnectDeadlineAt &&
        currentTime >= room.round.questionerReconnectDeadlineAt
      ) {
        await this.finishRound(room, "aborted", "出题人掉线超时，本局已结束");
        this.broadcastRoomEvent(room, "game.roundSummary", room.round?.summary ?? null);
        this.publishRoomState(room);
      }
    }
  }

  notifyShutdown(): void {
    for (const connection of this.connections.values()) {
      connection.send(
        createEvent("server.shutdown", {
          message: "服务器即将关闭，请稍后重新连接",
        }),
      );
    }
  }

  getHealthSnapshot() {
    return {
      roomCount: this.rooms.size,
      connectionCount: this.connections.size,
      onlinePlayerCount: [...this.rooms.values()].reduce(
        (sum, room) => sum + this.getOnlineCount(room),
        0,
      ),
    };
  }

  getRoomSummaries(): RoomSummary[] {
    return [...this.rooms.values()]
      // 测试房间不出现在大厅列表，避免污染正式用户视线。
      .filter((room) => room.id !== ROOM_ID_TEST_MODE)
      .map((room) => this.buildRoomSummary(room))
      .sort((left, right) => left.roomId.localeCompare(right.roomId));
  }

  private async handleRoomCreate(
    connection: ConnectionRecord,
    message: Extract<ClientMessage, { type: "room.create" }>,
  ) {
    // 创建房间时同时把当前连接绑定为房主与首个正式玩家。
    this.ensureConnectionIsFree(connection);

    const roomId = ensureRoomId(message.payload.roomId);

    if (this.rooms.has(roomId)) {
      throw new AppError("ROOM_ALREADY_EXISTS", "房间已存在");
    }

    const room: RoomRecord = {
      id: roomId,
      settings: {
        name: normalizeName(message.payload.name),
        visibility: message.payload.visibility,
        password:
          message.payload.visibility === "private"
            ? this.requirePassword(message.payload.password)
            : undefined,
        allowSpectators: message.payload.allowSpectators,
        roleConfig: createDefaultRoleConfig(),
      },
      hostPlayerId: "",
      createdAt: this.now(),
      updatedAt: this.now(),
      lastActivityAt: this.now(),
      players: {},
      chat: [],
    };

    const host = this.createPlayer(message.payload.userName, false);
    room.players[host.id] = host;
    room.hostPlayerId = host.id;

    // 房间名缺省时使用房主昵称，避免千篇一律的"新房间"。
    if (!room.settings.name) {
      room.settings.name = `${host.name}的房间`;
    }

    room.settings.roleConfig = this.clampRoleConfig(
      message.payload.roleConfig ?? createDefaultRoleConfig(),
      this.getConfigurableParticipantCount(room),
    );

    this.rooms.set(room.id, room);
    this.attachConnection(room, host, connection);
    this.appendSystemMessage(room, `${host.name} 创建了房间`);
    this.touchRoom(room);

    await this.log({
      type: "room.created",
      createdAt: this.now(),
      roomId: room.id,
      playerId: host.id,
      payload: {
        visibility: room.settings.visibility,
      },
    });

    this.broadcastRoomEvent(room, "room.playerChanged", {
      roomId: room.id,
      action: "joined",
      playerId: host.id,
    });
    this.publishRoomState(room);
    this.publishLobby();

    return {
      roomId: room.id,
      playerId: host.id,
      sessionToken: host.sessionToken,
    };
  }

  private async handleRoomJoin(
    connection: ConnectionRecord,
    message: Extract<ClientMessage, { type: "room.join" }>,
  ) {
    // 开局后新连接默认只能作为旁观者进入，避免临时插入正式席位打乱本局。
    this.ensureConnectionIsFree(connection);

    const roomId = ensureRoomId(message.roomId ?? "");
    const room = this.getRoom(roomId);

    this.ensurePasswordMatch(room, message.payload.password);
    const reclaimedPlayer = await this.tryReclaimOfflinePlayer(
      room,
      connection,
      message.payload.userName,
    );

    if (reclaimedPlayer) {
      return reclaimedPlayer;
    }

    this.ensureUniqueName(room, message.payload.userName);

    const joiningAsSpectator = this.isRoundActive(room);

    if (joiningAsSpectator && !room.settings.allowSpectators) {
      throw new AppError("SPECTATOR_DISABLED", "当前房间不允许旁观");
    }

    const player = this.createPlayer(message.payload.userName, false);
    player.membership = joiningAsSpectator ? "spectator" : "active";

    room.players[player.id] = player;
    this.attachConnection(room, player, connection);
    this.normalizeRoomRoleConfig(room);
    this.appendSystemMessage(room, `${player.name} 加入了房间`);
    this.touchRoom(room);

    await this.log({
      type: "room.joined",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        membership: player.membership,
      },
    });

    this.broadcastRoomEvent(room, "room.playerChanged", {
      roomId: room.id,
      action: "joined",
      playerId: player.id,
    });
    this.publishRoomState(room);
    this.publishLobby();

    return {
      roomId: room.id,
      playerId: player.id,
      sessionToken: player.sessionToken,
    };
  }

  private async handleRoomReconnect(
    connection: ConnectionRecord,
    message: Extract<ClientMessage, { type: "room.reconnect" }>,
  ) {
    // 重连不会创建新玩家，只会把会话重新挂回原连接。
    this.ensureConnectionIsFree(connection);

    const room = this.getRoom(ensureRoomId(message.payload.roomId));
    const player = Object.values(room.players).find(
      (item) => item.sessionToken === message.payload.sessionToken,
    );

    if (!player) {
      throw new AppError("SESSION_NOT_FOUND", "找不到对应的玩家会话");
    }

    if (player.membership === "kicked") {
      throw new AppError("PLAYER_KICKED", "该玩家已被移出房间");
    }

    return this.restorePlayerConnection(room, player, connection, {
      appendMessage: `${player.name} 已重新连接`,
      rotateSessionToken: false,
    });
  }

  private async handleRoomLeave(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);

    await this.handlePlayerOffline(room, player.id, "leave");

    return { left: true };
  }

  private async handleRename(connection: ConnectionRecord, nextName: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    const normalized = normalizeName(nextName);

    if (!normalized) {
      throw new AppError("INVALID_NAME", "用户名不能为空");
    }

    if (player.name === normalized) {
      return { name: player.name };
    }

    this.ensureUniqueName(room, normalized, player.id);
    player.name = normalized;
    player.lastSeenAt = this.now();
    this.touchRoom(room);

    await this.log({
      type: "player.renamed",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        name: player.name,
      },
    });

    this.broadcastRoomEvent(room, "room.playerChanged", {
      roomId: room.id,
      action: "renamed",
      playerId: player.id,
      name: player.name,
    });
    this.publishRoomState(room);
    return { name: player.name };
  }

  private async handleSetSpectator(connection: ConnectionRecord, spectator: boolean) {
    // 阵营切换只允许发生在局外，避免游戏中角色池被动态篡改。
    const { room, player } = this.requireRoomPlayer(connection);

    if (player.membership === "kicked") {
      throw new AppError("PLAYER_KICKED", "该玩家已被移出房间");
    }

    if (this.isRoundActive(room)) {
      throw new AppError("ROUND_ACTIVE", "游戏进行中无法切换阵营");
    }

    if (spectator && !room.settings.allowSpectators) {
      throw new AppError("SPECTATOR_DISABLED", "当前房间不允许旁观");
    }

    player.membership = spectator ? "spectator" : "active";
    player.isReady = false;
    this.normalizeRoomRoleConfig(room);
    this.touchRoom(room);

    await this.log({
      type: "player.membership_changed",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        membership: player.membership,
      },
    });

    this.broadcastRoomEvent(room, "room.playerChanged", {
      roomId: room.id,
      action: "membership_changed",
      playerId: player.id,
      membership: player.membership,
    });
    this.publishRoomState(room);
    this.publishLobby();

    return { membership: player.membership };
  }

  private async handleSetReady(connection: ConnectionRecord, ready: boolean) {
    const { room, player } = this.requireRoomPlayer(connection);

    if (this.isRoundActive(room)) {
      throw new AppError("ROUND_ACTIVE", "游戏进行中无法切换准备状态");
    }

    player.isReady = ready;
    this.touchRoom(room);

    await this.log({
      type: "player.ready_changed",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        ready,
      },
    });

    this.broadcastRoomEvent(room, "room.playerChanged", {
      roomId: room.id,
      action: "ready_changed",
      playerId: player.id,
      ready,
    });
    this.publishRoomState(room);
    return { ready };
  }

  private async handleUpdateSettings(
    connection: ConnectionRecord,
    payload: Extract<ClientMessage, { type: "room.updateSettings" }>["payload"],
  ) {
    const { room, player } = this.requireRoomPlayer(connection);

    this.ensureHost(room, player.id);

    if (this.isRoundActive(room)) {
      throw new AppError("ROUND_ACTIVE", "游戏进行中无法修改房间设置");
    }

    if (payload.name != null) {
      const normalized = normalizeName(payload.name);

      if (!normalized) {
        throw new AppError("INVALID_ROOM_NAME", "房间名不能为空");
      }

      room.settings.name = normalized;
    }

    if (payload.visibility != null) {
      room.settings.visibility = payload.visibility;
    }

    if (payload.password != null) {
      room.settings.password =
        room.settings.visibility === "private"
          ? this.requirePassword(payload.password)
          : undefined;
    }

    if (payload.allowSpectators != null) {
      if (
        !payload.allowSpectators &&
        Object.values(room.players).some((item) => item.membership === "spectator")
      ) {
        throw new AppError("SPECTATOR_EXISTS", "房间内仍有旁观者，无法关闭旁观");
      }

      room.settings.allowSpectators = payload.allowSpectators;
    }

    if (room.settings.visibility === "private" && !room.settings.password) {
      throw new AppError("PASSWORD_REQUIRED", "私密房间必须设置密码");
    }

    if (payload.roleConfig) {
      // 人数不够时不再直接拒绝保存，而是静默夹到当前允许的范围；这样房主依然能把
      // 其它设置（房间名、私密、旁观等）改掉。前端通过 roleLimits 给出禁用提示。
      room.settings.roleConfig = this.clampRoleConfig(
        payload.roleConfig,
        this.getConfigurableParticipantCount(room),
      );
    } else {
      this.normalizeRoomRoleConfig(room);
    }

    this.touchRoom(room);

    await this.log({
      type: "room.settings_changed",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: room.settings,
    });

    this.broadcastRoomEvent(room, "room.settingsChanged", {
      roomId: room.id,
      settings: room.settings,
    });
    this.publishRoomState(room);
    this.publishLobby();

    return {
      settings: room.settings,
    };
  }

  private async handleKick(connection: ConnectionRecord, targetPlayerId: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);

    if (this.isRoundActive(room)) {
      throw new AppError("ROUND_ACTIVE", "游戏进行中无法踢人");
    }

    if (targetPlayerId === player.id) {
      throw new AppError("INVALID_KICK", "房主不能踢出自己");
    }

    const target = room.players[targetPlayerId];

    if (!target) {
      throw new AppError("PLAYER_NOT_FOUND", "目标玩家不存在");
    }

    await this.forceRemovePlayer(room, target.id, "房主已将其移出房间");

    this.broadcastRoomEvent(room, "room.playerChanged", {
      roomId: room.id,
      action: "kicked",
      playerId: target.id,
    });
    this.publishRoomState(room);
    this.publishLobby();

    return { playerId: target.id };
  }

  private async handleAssignQuestioner(connection: ConnectionRecord, targetPlayerId: string) {
    // 出题人可以是正式玩家，也可以是旁观者；旁观者出题时所有正式玩家直接参赛。
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);

    const round = this.requireRound(room);

    if (round.phase !== "assigningQuestioner") {
      throw new AppError("INVALID_PHASE", "当前阶段不能指定出题人");
    }

    const target = room.players[targetPlayerId];

    if (
      !target ||
      (target.membership !== "active" && target.membership !== "spectator") ||
      !target.online
    ) {
      throw new AppError("PLAYER_NOT_FOUND", "目标玩家不存在、离线或已离开");
    }

    // 旁观者出题 → 正式玩家全员参战；正式玩家出题 → 扣掉自身名额。
    const participantCount = this.getParticipantCount(room, target.id);
    const allowSoloTestQuestioner =
      room.id === ROOM_ID_TEST_MODE &&
      target.membership === "active" &&
      participantCount === 0 &&
      target.id === player.id;

    // 正式玩家担任出题人时若人数不够，自动把卧底数夹到上限（而不是直接拒绝）。
    if (target.membership === "active" && !allowSoloTestQuestioner) {
      room.settings.roleConfig = this.clampRoleConfig(
        room.settings.roleConfig,
        participantCount,
      );
    }

    if (!allowSoloTestQuestioner) {
      validateRoleConfig(
        room.settings.roleConfig,
        participantCount,
        room.id === ROOM_ID_TEST_MODE,
      );
    }

    round.questionerPlayerId = target.id;
    round.phase = "wordSubmission";
    this.touchRoom(room);
    this.appendSystemMessage(
      room,
      target.membership === "spectator"
        ? `${target.name}（旁观）被指定为出题人`
        : `${target.name} 被指定为出题人`,
    );

    await this.log({
      type: "game.questioner_assigned",
      createdAt: this.now(),
      roomId: room.id,
      playerId: target.id,
    });

    this.broadcastRoomEvent(room, "game.phaseChanged", {
      roomId: room.id,
      phase: round.phase,
      questionerPlayerId: target.id,
    });
    this.publishRoomState(room);
    await this.runBots(room);

    return { questionerPlayerId: target.id };
  }

  private async handleSubmitWords(
    connection: ConnectionRecord,
    words: [string, string],
    blankHint?: string,
  ) {
    // 提交词语后，真正的身份分配与词语映射都在服务端一次性完成。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);
    this.ensureQuestioner(round, player.id);

    if (round.phase !== "wordSubmission") {
      throw new AppError("INVALID_PHASE", "当前阶段不能提交词语");
    }

    let participantIds = listPlayablePlayerIds(room).filter(
      (item) => item !== round.questionerPlayerId,
    );

    if (participantIds.length === 0 && room.id === ROOM_ID_TEST_MODE) {
      // 单人测试房间允许房主先以出题人视角输入词语，再切回参赛者视角验收后续 UI。
      participantIds = [player.id];
      round.questionerPlayerId = undefined;
    }

    if (participantIds.length === 0) {
      throw new AppError("INSUFFICIENT_PLAYERS", "缺少可参与游戏的玩家");
    }

    const allowSoloTestSubmission = room.id === ROOM_ID_TEST_MODE && participantIds.length === 1;

    if (!allowSoloTestSubmission) {
      validateRoleConfig(
        room.settings.roleConfig,
        participantIds.length,
        room.id === ROOM_ID_TEST_MODE,
      );
    }

    if (room.settings.roleConfig.hasBlank && !normalizeWord(blankHint ?? "")) {
      throw new AppError("BLANK_HINT_REQUIRED", "开启白板时必须填写提示");
    }

    const assigned = assignRoles(
      participantIds,
      room.settings.roleConfig,
      words,
      blankHint ? normalizeWord(blankHint) : undefined,
      this.random,
    );

    round.words = {
      pair: assigned.pair,
      civilianWord: assigned.civilianWord,
      undercoverWord: assigned.undercoverWord,
      blankHint: blankHint ? normalizeWord(blankHint) : undefined,
    };
    round.assignments = assigned.assignments;
    round.phase = "description";
    round.descriptionCycle = 1;
    round.descriptionSubmittedBy = [];
    round.votes = [];
    round.tieBreak = undefined;
    round.nightActions = [];
    round.blankGuessContext = undefined;
    this.touchRoom(room);

    await this.options.wordBankRepository.savePair(words);
    await this.log({
      type: "game.words_submitted",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
    });

    this.broadcastRoomEvent(room, "game.phaseChanged", {
      roomId: room.id,
      phase: round.phase,
    });
    this.publishRoomState(room);
    await this.runBots(room);

    return { phase: round.phase };
  }

  private async handleAdvancePhase(connection: ConnectionRecord) {
    // waiting/gameOver 由房主开局，进行中阶段由出题人推进。
    const { room, player } = this.requireRoomPlayer(connection);
    const phase = room.round?.phase ?? "waiting";

    if (phase === "waiting" || phase === "gameOver") {
      this.ensureHost(room, player.id);
      this.ensureAllReady(room);
      this.ensureMinimumPlayers(room);
      await this.startRound(room);
      return { phase: room.round?.phase ?? "waiting" };
    }

    const round = this.requireRound(room);
    this.ensureQuestioner(round, player.id);
    this.ensurePhaseNotBlocked(round);

    switch (phase) {
      case "description":
        if (!this.isDescriptionComplete(round)) {
          throw new AppError("PHASE_INCOMPLETE", "仍有玩家尚未描述");
        }
        round.phase = "voting";
        round.votes = [];
        break;
      case "voting":
        if (!this.isVotingComplete(room, false)) {
          throw new AppError("PHASE_INCOMPLETE", "仍有玩家尚未投票");
        }
        await this.resolveVoting(room, false);
        break;
      case "tieBreak":
        if (!round.tieBreak) {
          throw new AppError("TIE_BREAK_MISSING", "平票状态异常");
        }

        if (round.tieBreak.stage === "description") {
          if (!this.isTieBreakDescriptionComplete(room)) {
            throw new AppError("PHASE_INCOMPLETE", "平票玩家尚未完成补充描述");
          }

          round.tieBreak.stage = "vote";
          round.tieBreak.votes = [];
        } else {
          if (!this.isVotingComplete(room, true)) {
            throw new AppError("PHASE_INCOMPLETE", "平票投票尚未完成");
          }

          await this.resolveVoting(room, true);
        }
        break;
      case "night":
        if (!this.isNightActionComplete(room)) {
          throw new AppError("PHASE_INCOMPLETE", "仍有玩家尚未提交夜晚操作");
        }
        await this.resolveNight(room);
        break;
      case "daybreak":
        round.phase = "description";
        round.day += 1;
        round.descriptionCycle += 1;
        round.descriptionSubmittedBy = [];
        round.votes = [];
        round.tieBreak = undefined;
        round.nightActions = [];
        break;
      default:
        throw new AppError("INVALID_PHASE", "当前阶段不能手动推进");
    }

    this.touchRoom(room);
    await this.log({
      type: "game.phase_changed",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        phase: room.round?.phase ?? "waiting",
      },
    });

    this.broadcastRoomEvent(room, "game.phaseChanged", {
      roomId: room.id,
      phase: room.round?.phase ?? "waiting",
      tieBreakStage: room.round?.tieBreak?.stage,
    });
    this.publishRoomState(room);
    await this.runBots(room);

    return { phase: room.round?.phase ?? "waiting" };
  }

  private async handleSubmitDescription(connection: ConnectionRecord, text: string) {
    // 描述和 PK 补充描述都复用同一份存储结构，只靠 kind 区分。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);
    const normalized = normalizeWord(text);

    if (!normalized) {
      throw new AppError("INVALID_DESCRIPTION", "描述不能为空");
    }

    if (round.phase === "description") {
      const state = round.assignments[player.id];

      if (!state?.alive) {
        throw new AppError("ACTION_FORBIDDEN", "当前玩家不能描述");
      }

      if (round.descriptionSubmittedBy.includes(player.id)) {
        throw new AppError("ALREADY_SUBMITTED", "你已经提交过描述");
      }

      round.descriptionSubmittedBy.push(player.id);
      round.descriptions.push(
        this.createDescription(player, normalized, "description", round.descriptionCycle),
      );
    } else if (round.phase === "tieBreak" && round.tieBreak?.stage === "description") {
      if (!round.tieBreak.candidateIds.includes(player.id)) {
        throw new AppError("ACTION_FORBIDDEN", "只有平票玩家可以补充描述");
      }

      if (round.tieBreak.descriptionsDone.includes(player.id)) {
        throw new AppError("ALREADY_SUBMITTED", "你已经提交过补充描述");
      }

      round.tieBreak.descriptionsDone.push(player.id);
      round.descriptions.push(
        this.createDescription(player, normalized, "tieBreak", round.descriptionCycle),
      );
    } else {
      throw new AppError("INVALID_PHASE", "当前阶段不能提交描述");
    }

    this.touchRoom(room);
    await this.log({
      type: "game.description_submitted",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
    });
    this.publishRoomState(room);
    await this.runBots(room);

    return { submitted: true };
  }

  private async handleSubmitVote(connection: ConnectionRecord, targetId: string) {
    // 第一轮投票与平票第二轮投票复用同一个入口，但资格校验不同。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);

    if (round.phase === "voting") {
      this.ensureCanVote(room, player.id, targetId, false);
      round.votes = this.replaceVote(round.votes, player.id, targetId);
    } else if (round.phase === "tieBreak" && round.tieBreak?.stage === "vote") {
      this.ensureCanVote(room, player.id, targetId, true);
      round.tieBreak.votes = this.replaceVote(round.tieBreak.votes, player.id, targetId);
    } else {
      throw new AppError("INVALID_PHASE", "当前阶段不能提交投票");
    }

    this.touchRoom(room);
    await this.log({
      type: "game.vote_submitted",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        targetId,
        tieBreak: round.phase === "tieBreak",
      },
    });
    this.publishRoomState(room);
    await this.runBots(room);

    return { submitted: true };
  }

  private async handleSubmitNightAction(
    connection: ConnectionRecord,
    targetId?: string | null,
  ) {
    // 空 targetId 表示“本夜不行动”，不是错误输入。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);

    if (round.phase !== "night") {
      throw new AppError("INVALID_PHASE", "当前阶段不能提交夜晚操作");
    }

    const state = round.assignments[player.id];

    if (!state?.alive || (state.role !== "civilian" && state.role !== "undercover")) {
      throw new AppError("ACTION_FORBIDDEN", "当前玩家没有夜晚操作资格");
    }

    if (targetId) {
      const targetState = round.assignments[targetId];

      if (
        !targetState?.alive ||
        (targetId === player.id && room.id !== ROOM_ID_TEST_MODE)
      ) {
        throw new AppError("INVALID_TARGET", "夜晚目标无效");
      }
    }

    round.nightActions = this.replaceNightAction(round.nightActions, player.id, {
      actorId: player.id,
      actorRole: state.role,
      targetId: targetId ?? undefined,
    });
    this.touchRoom(room);

    await this.log({
      type: "game.night_action_submitted",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        hasTarget: Boolean(targetId),
      },
    });

    this.publishRoomState(room);
    await this.runBots(room);

    return { submitted: true };
  }

  private async handleSubmitBlankGuess(connection: ConnectionRecord, words: [string, string]) {
    // 白板可以主动猜，也可以在被动 blankGuess 阶段猜，但总次数只有一次。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);
    const state = round.assignments[player.id];

    if (!state || state.role !== "blank") {
      throw new AppError("ACTION_FORBIDDEN", "只有白板可以猜词");
    }

    if (round.blankGuessUsed) {
      throw new AppError("BLANK_GUESS_USED", "白板已经使用过猜词机会");
    }

    const canGuessActively = state.alive && round.phase !== "gameOver";
    const canGuessPassively =
      round.phase === "blankGuess" && round.blankGuessContext?.playerId === player.id;

    if (!canGuessActively && !canGuessPassively) {
      throw new AppError("ACTION_FORBIDDEN", "当前不能进行白板猜词");
    }

    const guess = evaluateBlankGuess(
      round,
      words,
      this.now(),
      canGuessPassively ? round.blankGuessContext?.reason ?? "eliminated" : "active",
    );

    round.blankGuessUsed = true;
    round.blankGuessRecords.push(guess);
    this.touchRoom(room);

    await this.log({
      type: "game.blank_guess_submitted",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        success: guess.success,
      },
    });

    if (guess.success) {
      await this.finishRound(room, "blank", "白板猜中全部词语，获得胜利");
    } else if (round.phase === "blankGuess") {
      if (round.blankGuessContext?.deferredWinner) {
        await this.finishRound(
          room,
          round.blankGuessContext.deferredWinner,
          "白板猜测失败，系统按残局条件结算",
        );
      } else if (round.blankGuessContext?.resumePhase) {
        round.phase = round.blankGuessContext.resumePhase;
        round.blankGuessContext = undefined;
      }
    }

    this.publishRoomState(room);
    this.broadcastRoomEvent(room, "game.roundSummary", room.round?.summary ?? null);
    await this.runBots(room);

    return { success: guess.success };
  }

  private async handleResolveDisconnect(
    connection: ConnectionRecord,
    targetPlayerId: string,
    resolution: "wait" | "eliminate",
  ) {
    // 只有出题人能决定掉线正式玩家是继续等待还是直接淘汰。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);
    this.ensureQuestioner(round, player.id);

    if (!round.pendingDisconnectPlayerIds.includes(targetPlayerId)) {
      throw new AppError("PLAYER_NOT_PENDING", "当前没有等待处理的掉线玩家");
    }

    this.clearPendingDisconnect(round, targetPlayerId);

    if (resolution === "eliminate") {
      await this.forceRemovePlayer(room, targetPlayerId, "掉线后被出题人移出");
    } else {
      this.appendSystemMessage(room, `${room.players[targetPlayerId]?.name ?? "玩家"} 的掉线状态已保留`);
    }

    this.touchRoom(room);
    await this.log({
      type: "game.disconnect_resolved",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        targetPlayerId,
        resolution,
      },
    });

    this.publishRoomState(room);
    await this.runBots(room);

    return { resolved: true };
  }

  private async handleChat(connection: ConnectionRecord, text: string) {
    // 聊天区在任意阶段都开放，所以不受 round.phase 限制。
    const { room, player } = this.requireRoomPlayer(connection);
    const normalized = normalizeWord(text);

    if (!normalized) {
      throw new AppError("INVALID_CHAT", "聊天内容不能为空");
    }

    const message = this.createChatMessage(player.id, player.name, normalized, false);
    room.chat.push(message);
    room.chat = room.chat.slice(-CHAT_LIMIT);
    this.touchRoom(room);

    await this.log({
      type: "chat.sent",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        text: normalized,
      },
    });

    this.broadcastRoomEvent(room, "chat.message", message);
    this.publishRoomState(room);
    return { sent: true };
  }

  private async handleTransferHost(connection: ConnectionRecord, targetPlayerId: string) {
    // 房主手动转移：仅允许在未开局时进行，转移对象必须是房间内有效玩家。
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);

    if (this.isRoundActive(room)) {
      throw new AppError("ROUND_ACTIVE", "游戏进行中无法转移房主");
    }

    if (targetPlayerId === player.id) {
      throw new AppError("INVALID_TARGET", "不能将房主转移给自己");
    }

    const target = room.players[targetPlayerId];

    if (!target || target.membership === "kicked") {
      throw new AppError("PLAYER_NOT_FOUND", "目标玩家不存在");
    }

    room.hostPlayerId = target.id;
    this.touchRoom(room);
    this.appendSystemMessage(room, `${player.name} 将房主转移给了 ${target.name}`);

    await this.log({
      type: "room.host_transferred",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: { nextHostId: target.id },
    });

    this.broadcastRoomEvent(room, "room.playerChanged", {
      roomId: room.id,
      action: "host_changed",
      playerId: target.id,
    });
    this.publishRoomState(room);
    this.publishLobby();
    return { hostPlayerId: target.id };
  }

  private async handleTestJumpToPhase(connection: ConnectionRecord, target: GamePhase) {
    // 仅测试房间可用：预填必要的 round 状态后直接切到目标阶段，方便逐个阶段验收 UI。
    const { room, player } = this.requireRoomPlayer(connection);

    if (room.id !== ROOM_ID_TEST_MODE) {
      throw new AppError("FORBIDDEN", "仅测试房间允许使用跳转控制器");
    }

    if (target === "waiting") {
      room.round = undefined;
      for (const p of Object.values(room.players)) {
        p.isReady = false;
      }
      this.touchRoom(room);
      this.broadcastRoomEvent(room, "game.phaseChanged", {
        roomId: room.id,
        phase: "waiting",
      });
      this.publishRoomState(room);
      return { phase: "waiting" as GamePhase };
    }

    // 确保 round 存在。
    if (!room.round) {
      await this.startRound(room);
    }

    const round = this.requireRound(room);
    const activeIds = Object.values(room.players)
      .filter((p) => p.membership === "active")
      .map((p) => p.id);
    const useCallerAsQuestioner = target === "wordSubmission";
    const participantIds = useCallerAsQuestioner
      ? activeIds.filter((id) => id !== player.id)
      : activeIds;

    if (target === "assigningQuestioner") {
      round.questionerPlayerId = undefined;
      round.phase = "assigningQuestioner";
      round.assignments = {};
      round.words = undefined;
      round.descriptionCycle = 0;
      round.descriptions = [];
      round.descriptionSubmittedBy = [];
      round.votes = [];
      round.tieBreak = undefined;
      round.nightActions = [];
      round.blankGuessUsed = false;
      round.blankGuessRecords = [];
      round.blankGuessContext = undefined;
      round.pendingDisconnectPlayerIds = [];
      round.questionerReconnectDeadlineAt = undefined;
      round.summary = undefined;
      this.broadcastPhaseAndPublish(room);
      return { phase: round.phase };
    }

    round.questionerPlayerId = useCallerAsQuestioner ? player.id : undefined;
    round.pendingDisconnectPlayerIds = [];
    round.questionerReconnectDeadlineAt = undefined;

    if (target !== "wordSubmission" && participantIds.length === 0) {
      throw new AppError("INSUFFICIENT_PLAYERS", "测试房间至少需要 1 名正式玩家");
    }

    if (
      target !== "wordSubmission" &&
      (!round.words ||
        Object.keys(round.assignments).length === 0 ||
        participantIds.some((id) => !round.assignments[id]))
    ) {
      const config = this.clampRoleConfig(
        room.settings.roleConfig,
        participantIds.length,
      );
      const effectiveConfig: RoleConfig = {
        ...config,
        undercoverCount: Math.max(1, Math.min(config.undercoverCount || 1, participantIds.length)),
        hasAngel: participantIds.length >= 2 && config.hasAngel,
        hasBlank: participantIds.length >= 2 && config.hasBlank,
      };
      const assigned = assignRoles(
        participantIds,
        effectiveConfig,
        TEST_MODE_DEFAULT_WORD,
        effectiveConfig.hasBlank ? "测试提示" : undefined,
        this.random,
      );
      round.words = {
        pair: assigned.pair,
        civilianWord: assigned.civilianWord,
        undercoverWord: assigned.undercoverWord,
        blankHint: effectiveConfig.hasBlank ? "测试提示" : undefined,
      };
      round.assignments = assigned.assignments;
    }

    switch (target) {
      case "wordSubmission":
        round.phase = "wordSubmission";
        round.words = undefined;
        round.assignments = {};
        round.descriptionCycle = 0;
        round.descriptions = [];
        round.descriptionSubmittedBy = [];
        round.votes = [];
        round.tieBreak = undefined;
        round.nightActions = [];
        round.blankGuessUsed = false;
        round.blankGuessRecords = [];
        round.blankGuessContext = undefined;
        round.summary = undefined;
        break;
      case "description":
        round.phase = "description";
        round.descriptionCycle = Math.max(1, round.descriptionCycle);
        round.descriptionSubmittedBy = [];
        round.votes = [];
        round.tieBreak = undefined;
        round.nightActions = [];
        round.blankGuessUsed = false;
        round.blankGuessContext = undefined;
        round.summary = undefined;
        break;
      case "voting":
        round.phase = "voting";
        round.votes = [];
        round.tieBreak = undefined;
        round.nightActions = [];
        round.blankGuessUsed = false;
        round.blankGuessContext = undefined;
        round.summary = undefined;
        break;
      case "tieBreak": {
        const alive = Object.entries(round.assignments)
          .filter(([, s]) => s.alive)
          .map(([pid]) => pid)
          .slice(0, 2);
        round.phase = "tieBreak";
        round.tieBreak = {
          candidateIds: alive,
          stage: "description",
          descriptionsDone: [],
          votes: [],
        };
        round.blankGuessUsed = false;
        round.blankGuessContext = undefined;
        round.summary = undefined;
        break;
      }
      case "night":
        round.phase = "night";
        round.nightActions = [];
        round.blankGuessUsed = false;
        round.blankGuessContext = undefined;
        round.summary = undefined;
        break;
      case "daybreak":
        round.phase = "daybreak";
        round.blankGuessUsed = false;
        round.blankGuessContext = undefined;
        round.summary = undefined;
        break;
      case "blankGuess": {
        const blankId = getBlankPlayerId(round.assignments) ?? participantIds[0];

        if (blankId && round.assignments[blankId]) {
          round.assignments[blankId] = {
            ...round.assignments[blankId],
            role: "blank",
            side: "blank",
            word: undefined,
            alive: true,
          };
        }

        if (round.words && !round.words.blankHint) {
          round.words.blankHint = "测试提示";
        }

        round.phase = "blankGuess";
        round.blankGuessUsed = false;
        round.blankGuessContext = {
          playerId: blankId,
          reason: "eliminated",
          resumePhase: "description",
        };
        round.summary = undefined;
        break;
      }
      case "gameOver":
        await this.finishRound(room, "good", "（测试）手动结束本局");
        this.broadcastRoomEvent(room, "game.roundSummary", room.round?.summary ?? null);
        this.publishRoomState(room);
        return { phase: "gameOver" as GamePhase };
    }

    this.touchRoom(room);
    this.broadcastPhaseAndPublish(room);
    return { phase: round.phase };
  }

  private async handleTestSetMyRole(connection: ConnectionRecord, role: PlayerRole) {
    // 仅测试房间：强制替换当前玩家在本局中的角色分配。
    const { room, player } = this.requireRoomPlayer(connection);

    if (room.id !== ROOM_ID_TEST_MODE) {
      throw new AppError("FORBIDDEN", "仅测试房间允许切换身份");
    }

    const round = this.requireRound(room);

    if (round.questionerPlayerId === player.id) {
      throw new AppError("INVALID_TARGET", "出题人不能切换身份");
    }

    if (!round.assignments[player.id]) {
      // 若当前玩家还没有分配（例如是旁观），不支持切换。
      throw new AppError("ACTION_FORBIDDEN", "仅已参与本局的玩家可切换身份");
    }

    const civilianWord = round.words?.civilianWord ?? TEST_MODE_DEFAULT_WORD[0];
    const undercoverWord = round.words?.undercoverWord ?? TEST_MODE_DEFAULT_WORD[1];

    const side =
      role === "undercover" ? "undercover" : role === "blank" ? "blank" : "good";
    const word =
      role === "undercover"
        ? undercoverWord
        : role === "blank"
          ? undefined
          : civilianWord;

    round.assignments[player.id] = {
      ...round.assignments[player.id],
      role,
      side,
      word,
      alive: true,
    };

    if (role === "blank" && round.words && !round.words.blankHint) {
      round.words.blankHint = "测试提示";
    }

    this.touchRoom(room);
    this.publishRoomState(room);
    return { role };
  }

  private broadcastPhaseAndPublish(room: RoomRecord) {
    this.broadcastRoomEvent(room, "game.phaseChanged", {
      roomId: room.id,
      phase: room.round?.phase ?? "waiting",
      tieBreakStage: room.round?.tieBreak?.stage,
    });
    this.publishRoomState(room);
  }

  private async startRound(room: RoomRecord) {
    // 每次开局都创建全新的 round 对象，避免上一局残留状态污染新局。
    room.round = {
      id: this.createId("round"),
      phase: "assigningQuestioner",
      day: 1,
      assignments: {},
      descriptionCycle: 0,
      descriptions: [],
      descriptionSubmittedBy: [],
      votes: [],
      nightActions: [],
      blankGuessUsed: false,
      blankGuessRecords: [],
      pendingDisconnectPlayerIds: [],
    };

    this.touchRoom(room);
    this.appendSystemMessage(room, "新一局游戏已开始，请房主指定出题人");

    await this.log({
      type: "game.started",
      createdAt: this.now(),
      roomId: room.id,
      payload: {
        playerCount: Object.values(room.players).filter((item) => item.membership === "active")
          .length,
      },
    });

    this.broadcastRoomEvent(room, "game.phaseChanged", {
      roomId: room.id,
      phase: room.round.phase,
    });
    this.publishRoomState(room);
  }

  private async resolveVoting(room: RoomRecord, tieBreak: boolean) {
    // 这个方法只负责“投票结算”，真正的胜负判断交给后续统一淘汰流程。
    const round = this.requireRound(room);
    const votes = tieBreak ? round.tieBreak?.votes ?? [] : round.votes;
    const fallbackCandidates = tieBreak
      ? round.tieBreak?.candidateIds ?? []
      : this.getAliveAssignedPlayerIds(room);
    const outcome = computeVoteOutcome(votes);
    const leaders =
      outcome.leaders.length > 0 ? outcome.leaders : [...fallbackCandidates].sort();

    this.broadcastRoomEvent(room, "game.voteResult", {
      roomId: room.id,
      tieBreak,
      counts: outcome.counts,
      leaders,
    });

    await this.log({
      type: "game.vote_resolved",
      createdAt: this.now(),
      roomId: room.id,
      payload: {
        tieBreak,
        leaders,
        counts: outcome.counts,
      },
    });

    if (!tieBreak && leaders.length > 1) {
      round.phase = "tieBreak";
      round.tieBreak = {
        candidateIds: leaders,
        stage: "description",
        descriptionsDone: [],
        votes: [],
      };
      return;
    }

    const eliminatedIds = tieBreak && leaders.length > 1 ? leaders : [leaders[0]];
    await this.applyEliminationAndMove(
      room,
      eliminatedIds.filter((value): value is string => Boolean(value)),
      tieBreak ? "平票再次出局" : "投票出局",
      "night",
    );
  }

  private async resolveNight(room: RoomRecord) {
    // 夜晚结算会先产生淘汰结果，再决定是否插入白板猜词或直接结算胜负。
    const round = this.requireRound(room);
    round.phase = "daybreak";

    const eliminatedIds = resolveNightEliminations(round, round.nightActions);

    if (eliminatedIds.length > 0) {
      recordEliminations(round.assignments, eliminatedIds, "夜晚结算", this.now());
    }

    await this.log({
      type: "game.night_resolved",
      createdAt: this.now(),
      roomId: room.id,
      payload: {
        eliminatedIds,
      },
    });

    if (await this.maybeEnterBlankGuess(room, eliminatedIds, "description")) {
      return;
    }

    const winner = getWinnerAfterBlankFailure(round.assignments);

    if (winner) {
      await this.finishRound(room, winner, "夜晚结算后已满足胜利条件");
    }
  }

  private async maybeEnterBlankGuess(
    room: RoomRecord,
    eliminatedIds: string[],
    resumePhase: Exclude<GamePhase, "assigningQuestioner" | "wordSubmission" | "blankGuess">,
  ): Promise<boolean> {
    // 这里统一处理两种白板猜词入口：
    // 1. 白板被淘汰后的被动猜词
    // 2. 残局触发的最终猜词
    const round = this.requireRound(room);
    const blankPlayerId = getBlankPlayerId(round.assignments);

    if (
      blankPlayerId &&
      eliminatedIds.includes(blankPlayerId) &&
      !round.blankGuessUsed
    ) {
      round.phase = "blankGuess";
      round.blankGuessContext = {
        playerId: blankPlayerId,
        reason: "eliminated",
        resumePhase,
      };
      return true;
    }

    const finalBlankGuess = shouldEnterFinalBlankGuess(round);

    if (finalBlankGuess.shouldGuess && finalBlankGuess.blankPlayerId) {
      round.phase = "blankGuess";
      round.blankGuessContext = {
        playerId: finalBlankGuess.blankPlayerId,
        reason: "finale",
        resumePhase: "gameOver",
        deferredWinner: finalBlankGuess.deferredWinner,
      };
      return true;
    }

    return false;
  }

  private async applyEliminationAndMove(
    room: RoomRecord,
    eliminatedIds: string[],
    reason: string,
    nextPhase: Exclude<GamePhase, "assigningQuestioner" | "wordSubmission" | "blankGuess">,
  ) {
    // 所有“有人出局”的阶段都汇总到这里，统一做淘汰、白板插入和胜负判断。
    const round = this.requireRound(room);

    if (eliminatedIds.length > 0) {
      recordEliminations(round.assignments, eliminatedIds, reason, this.now());
    }

    if (await this.maybeEnterBlankGuess(room, eliminatedIds, nextPhase)) {
      return;
    }

    const winner = getWinnerAfterBlankFailure(round.assignments);

    if (winner) {
      await this.finishRound(room, winner, "阶段结算后已满足胜利条件");
      return;
    }

    round.phase = nextPhase;
    round.tieBreak = undefined;
    round.votes = [];
    round.nightActions = [];
  }

  private async finishRound(room: RoomRecord, winner: RoundWinner, reason: string) {
    // 结算时既要给分，也要冻结当局摘要，供房间页在局后复盘。
    const round = this.requireRound(room);
    const awardedScores: Array<{ playerId: string; delta: number }> = [];

    if (winner !== "aborted") {
      for (const [playerId, state] of Object.entries(round.assignments)) {
        const player = room.players[playerId];

        if (!player) {
          continue;
        }

        const delta =
          winner === "blank"
            ? state.side === "blank"
              ? 2
              : 0
            : winner === "good"
              ? state.side === "good"
                ? 1
                : 0
              : state.side === "undercover"
                ? 1
                : 0;

        if (delta > 0) {
          player.score += delta;
          awardedScores.push({ playerId, delta });
        }
      }
    }

    round.phase = "gameOver";
    round.pendingDisconnectPlayerIds = [];
    round.questionerReconnectDeadlineAt = undefined;
    round.blankGuessContext = undefined;
    round.summary = {
      winner,
      reason,
      awardedScores,
      revealedRoles: Object.entries(round.assignments).map(([playerId, state]) => ({
        playerId,
        role: state.role,
      })),
      descriptions: [...round.descriptions],
      blankGuesses: [...round.blankGuessRecords],
    };

    for (const player of Object.values(room.players)) {
      // 结算后所有玩家统一重置为"未准备"，由房主（以及其他玩家）显式勾选下一局。
      player.isReady = false;
    }

    this.touchRoom(room);

    await this.log({
      type: "game.finished",
      createdAt: this.now(),
      roomId: room.id,
      payload: {
        winner,
        reason,
      },
    });

    this.broadcastRoomEvent(room, "game.roundSummary", round.summary);
  }

  private async handlePlayerOffline(
    room: RoomRecord,
    playerId: string,
    reason: "disconnect" | "leave",
  ) {
    // 这里集中处理“玩家不在线”带来的所有副作用：局外移除、局内待决、空房清理。
    const player = room.players[playerId];

    if (!player) {
      return;
    }

    player.online = false;
    player.connectionId = undefined;
    player.lastSeenAt = this.now();
    const connection = [...this.connections.values()].find((item) => item.playerId === player.id);

    if (connection) {
      connection.playerId = undefined;
      connection.roomId = undefined;
    }

    const round = room.round;

    if (!round || round.phase === "gameOver") {
      // 房主显式离开时，无条件把身份交给下一位玩家；这样下一局不会卡在没人能操控的状态。
      const wasHost = room.hostPlayerId === player.id;

      if (player.score === 0 && !player.isBot) {
        delete room.players[player.id];
      }

      if (wasHost && reason === "leave") {
        // 先临时置空，让 reassignHost 按加入时间重新选出首位。
        room.hostPlayerId = "";
      }

      this.reassignHost(room);
      this.normalizeRoomRoleConfig(room);
      this.touchRoom(room);
      if (this.getOnlineCount(room) === 0) {
        await this.closeRoom(room, "empty");
      } else {
        this.publishRoomState(room);
        this.publishLobby();
      }
      return;
    }

    if (round.questionerPlayerId === player.id) {
      round.questionerReconnectDeadlineAt = this.now() + QUESTIONER_RECONNECT_TIMEOUT_MS;
      this.appendSystemMessage(room, "出题人已掉线，系统开始等待其重新连接");
    } else if (this.shouldQueueDisconnectForDecision(round, player)) {
      this.enqueuePendingDisconnect(round, player.id);
      this.broadcastRoomEvent(room, "game.disconnectDecisionRequested", {
        roomId: room.id,
        playerId,
      });
    }

    this.touchRoom(room);
    await this.log({
      type: `player.${reason}`,
      createdAt: this.now(),
      roomId: room.id,
      playerId,
    });

    this.broadcastRoomEvent(room, "room.playerChanged", {
      roomId: room.id,
      action: reason,
      playerId,
    });
    if (this.getOnlineCount(room) === 0) {
      await this.closeRoom(room, "empty");
    } else {
      this.publishRoomState(room);
      this.publishLobby();
    }
  }

  private async forceRemovePlayer(room: RoomRecord, playerId: string, reason: string) {
    // 强制移除既可能来自房主踢人，也可能来自掉线淘汰决策。
    const player = room.players[playerId];

    if (!player) {
      return;
    }

    const connection = this.getConnectionByPlayer(player.id);

    if (connection) {
      connection.send(
        createEvent("room.closed", {
          roomId: room.id,
          reason: "kicked",
        }),
      );
      connection.playerId = undefined;
      connection.roomId = undefined;
    }

    player.online = false;
    player.connectionId = undefined;
    player.membership = "kicked";
    player.isReady = false;
    if (room.round) {
      this.clearPendingDisconnect(room.round, player.id);
    }

    if (room.round?.assignments[player.id]?.alive && room.round.phase !== "gameOver") {
      const resumePhase = this.getResumePhaseAfterForcedRemoval(room.round.phase);
      await this.applyEliminationAndMove(room, [player.id], reason, resumePhase);
    }

    this.reassignHost(room);
    this.normalizeRoomRoleConfig(room);
    this.touchRoom(room);
    await this.maybeAbortRoundAfterRosterChange(room);

    await this.log({
      type: "player.kicked",
      createdAt: this.now(),
      roomId: room.id,
      playerId,
      payload: {
        reason,
      },
    });
  }

  private async closeRoom(room: RoomRecord, reason: string) {
    // closeRoom 负责房间生命周期的最后一步：通知、解绑、删除、记日志。
    for (const connection of this.connections.values()) {
      if (connection.roomId !== room.id) {
        continue;
      }

      connection.send(
        createEvent("room.closed", {
          roomId: room.id,
          reason,
        }),
      );
      connection.roomId = undefined;
      connection.playerId = undefined;
    }

    this.rooms.delete(room.id);
    await this.log({
      type: "room.closed",
      createdAt: this.now(),
      roomId: room.id,
      payload: {
        reason,
      },
    });
    this.publishLobby();
  }

  private buildRoomSummary(room: RoomRecord): RoomSummary {
    return {
      roomId: room.id,
      name: room.settings.name,
      visibility: room.settings.visibility,
      allowSpectators: room.settings.allowSpectators,
      hasPassword: Boolean(room.settings.password),
      playerCount: Object.keys(room.players).length,
      onlineCount: this.getOnlineCount(room),
      phase: room.round?.phase ?? "waiting",
      testMode: room.id === ROOM_ID_TEST_MODE,
    };
  }

  private buildRoomSnapshot(room: RoomRecord): RoomSnapshot {
    // 快照是前端渲染主数据源，尽量保证“一包就够渲染当前房间”。
    return {
      roomId: room.id,
      name: room.settings.name,
      visibility: room.settings.visibility,
      allowSpectators: room.settings.allowSpectators,
      hasPassword: Boolean(room.settings.password),
      hostPlayerId: room.hostPlayerId,
      testMode: room.id === ROOM_ID_TEST_MODE,
      roleLimits: getRoomRoleLimits(this.getConfigurableParticipantCount(room)),
      settings: {
        roleConfig: room.settings.roleConfig,
      },
      status: {
        phase: room.round?.phase ?? "waiting",
        started: Boolean(room.round),
        day: room.round?.day ?? 0,
        questionerPlayerId: room.round?.questionerPlayerId,
        tieBreakStage: room.round?.tieBreak?.stage,
        pendingDisconnectPlayerId: room.round?.pendingDisconnectPlayerIds[0],
        questionerReconnectDeadlineAt: room.round?.questionerReconnectDeadlineAt,
        blankGuessPlayerId: room.round?.blankGuessContext?.playerId,
      },
      players: this.buildPublicPlayers(room),
      descriptions: room.round?.descriptions ?? [],
      chat: room.chat,
      summary: room.round?.summary,
    };
  }

  private buildPublicPlayers(room: RoomRecord): PublicPlayerView[] {
    return Object.values(room.players)
      .sort((left, right) => left.joinedAt - right.joinedAt)
      .map((player) => {
        const roundState = room.round?.assignments[player.id];
        const isQuestioner = room.round?.questionerPlayerId === player.id;

        let roundStatus: PublicPlayerView["roundStatus"] = "waiting";

        if (player.membership === "kicked") {
          roundStatus = "kicked";
        } else if (isQuestioner) {
          // 出题人身份凌驾于 active / spectator：旁观者也可以被指定出题。
          roundStatus = "questioner";
        } else if (player.membership === "spectator") {
          roundStatus = "spectator";
        } else if (roundState) {
          roundStatus = roundState.alive ? "alive" : "dead";
        }

        return {
          id: player.id,
          name: player.name,
          score: player.score,
          membership: player.membership,
          online: player.online,
          isReady: player.isReady,
          isBot: player.isBot,
          isHost: room.hostPlayerId === player.id,
          roundStatus,
          revealedRole:
            roundState && (!roundState.alive || room.round?.phase === "gameOver")
              ? roundState.role
              : undefined,
        };
      });
  }

  private buildPrivateState(room: RoomRecord, player: PlayerRecord): PrivateState {
    // 房间公共快照永远不包含秘密信息，私有视图单独按连接发放。
    const round = room.round;
    const state = round?.assignments[player.id];
    const hasPrivilegedIdentityView =
      Boolean(round && (round.questionerPlayerId === player.id || player.membership === "spectator"));

    if (!round) {
      return {
        playerId: player.id,
        sessionToken: player.sessionToken,
        isQuestioner: false,
        canSubmitBlankGuess: false,
        blankGuessUsed: false,
      };
    }

    if (hasPrivilegedIdentityView) {
      return {
        playerId: player.id,
        sessionToken: player.sessionToken,
        isQuestioner: round.questionerPlayerId === player.id,
        canSubmitBlankGuess: false,
        blankGuessUsed: round.blankGuessUsed,
        questionerView: Object.entries(round.assignments).map(([playerId, item]) => ({
          playerId,
          role: item.role,
          side: item.side,
          alive: item.alive,
        })),
      };
    }

    return {
      playerId: player.id,
      sessionToken: player.sessionToken,
      role: state?.role,
      side: state?.side,
      word: state?.role === "angel" ? undefined : state?.word,
      angelWordOptions:
        state?.role === "angel" && round.words
          ? round.words.pair
          : undefined,
      blankHint:
        state?.role === "blank"
          ? round.words?.blankHint
          : undefined,
      isQuestioner: false,
      canSubmitBlankGuess: state?.role === "blank" && !round.blankGuessUsed,
      blankGuessUsed: round.blankGuessUsed,
    };
  }

  private publishRoomState(room: RoomRecord) {
    // 每次状态变化都同时推送公共快照与当前连接的私有视图。
    const snapshot = this.buildRoomSnapshot(room);

    for (const connection of this.connections.values()) {
      if (connection.roomId !== room.id) {
        continue;
      }

      connection.send(createEvent("room.snapshot", snapshot));

      if (connection.playerId) {
        const player = room.players[connection.playerId];

        if (player) {
          connection.send(
            createEvent("game.privateState", this.buildPrivateState(room, player)),
          );
        }
      }
    }
  }

  private publishLobby() {
    const summaries = this.getRoomSummaries();

    for (const connection of this.connections.values()) {
      if (connection.lobbySubscribed) {
        connection.send(createEvent("lobby.rooms", summaries));
      }
    }
  }

  private broadcastRoomEvent(room: RoomRecord, event: string, payload: unknown) {
    for (const connection of this.connections.values()) {
      if (connection.roomId === room.id) {
        connection.send(createEvent(event, payload));
      }
    }
  }

  private attachConnection(
    room: RoomRecord,
    player: PlayerRecord,
    connection: ConnectionRecord,
  ) {
    // 同一 sessionToken 只允许挂一个在线连接，新连接会顶掉旧连接。
    const previousConnection = this.getConnectionByPlayer(player.id);

    if (previousConnection && previousConnection.id !== connection.id) {
      previousConnection.send(
        createEvent("session.replaced", {
          roomId: room.id,
        }),
      );
      previousConnection.playerId = undefined;
      previousConnection.roomId = undefined;
      previousConnection.close(4001, "session_replaced");
    }

    player.online = true;
    player.connectionId = connection.id;
    player.lastSeenAt = this.now();
    connection.roomId = room.id;
    connection.playerId = player.id;
  }

  private getOnlineCount(room: RoomRecord) {
    return Object.values(room.players).filter((player) => player.online).length;
  }

  private getActivePlayerIds(room: RoomRecord) {
    return Object.values(room.players)
      .filter((player) => player.membership === "active")
      .map((player) => player.id);
  }

  private getConfigurableParticipantCount(room: RoomRecord) {
    const activeIds = this.getActivePlayerIds(room);
    const hasOnlineSpectator = Object.values(room.players).some(
      (player) => player.membership === "spectator" && player.online,
    );

    if (hasOnlineSpectator) {
      return activeIds.length;
    }

    return Math.max(activeIds.length - (activeIds.length > 0 ? 1 : 0), 0);
  }

  private getParticipantCount(room: RoomRecord, questionerId?: string) {
    const activeIds = this.getActivePlayerIds(room);

    if (!questionerId) {
      return this.getConfigurableParticipantCount(room);
    }

    const questioner = room.players[questionerId];

    if (questioner?.membership === "spectator") {
      return activeIds.length;
    }

    return Math.max(activeIds.filter((playerId) => playerId !== questionerId).length, 0);
  }

  private getAssignableQuestionerCandidates(room: RoomRecord) {
    return Object.values(room.players).filter(
      (player) =>
        player.online &&
        (player.membership === "active" || player.membership === "spectator"),
    );
  }

  private hasValidQuestionerCandidate(room: RoomRecord) {
    return this.getAssignableQuestionerCandidates(room).some((candidate) => {
      const participantCount = this.getParticipantCount(room, candidate.id);

      if (
        room.id === ROOM_ID_TEST_MODE &&
        candidate.membership === "active" &&
        participantCount === 0
      ) {
        return true;
      }

      try {
        validateRoleConfig(
          room.settings.roleConfig,
          participantCount,
          room.id === ROOM_ID_TEST_MODE,
        );
        return true;
      } catch {
        return false;
      }
    });
  }

  private clampRoleConfig(config: RoleConfig, participantCount: number): RoleConfig {
    const limits = getRoomRoleLimits(Math.max(participantCount, 0));

    return {
      undercoverCount: Math.max(
        1,
        Math.min(config.undercoverCount || 1, limits.maxUndercoverCount),
      ),
      hasAngel: limits.canEnableAngel && config.hasAngel,
      hasBlank: limits.canEnableBlank && config.hasBlank,
    };
  }

  private normalizeRoomRoleConfig(room: RoomRecord) {
    room.settings.roleConfig = this.clampRoleConfig(
      room.settings.roleConfig,
      this.getConfigurableParticipantCount(room),
    );
  }

  private ensureAllReady(room: RoomRecord) {
    const everyoneReady = Object.values(room.players)
      .filter((player) => player.membership === "active")
      .every((player) => player.isReady);

    if (!everyoneReady) {
      throw new AppError("NOT_ALL_READY", "还有玩家未准备");
    }
  }

  private ensureMinimumPlayers(room: RoomRecord) {
    const activeCount = Object.values(room.players).filter(
      (player) => player.membership === "active",
    ).length;

    if (room.id === ROOM_ID_TEST_MODE) {
      if (activeCount < 1) {
        throw new AppError("INSUFFICIENT_PLAYERS", "测试模式至少需要一名玩家");
      }

      return;
    }

    // 旁观者可以出题，因此只要正式玩家达到 4 人即可开局。
    if (activeCount < 4) {
      throw new AppError("INSUFFICIENT_PLAYERS", "游戏至少需要 4 名正式玩家");
    }

    if (!this.hasValidQuestionerCandidate(room)) {
      throw new AppError("INSUFFICIENT_PLAYERS", "当前人数与阵营配置下无法指定合法出题人");
    }
  }

  private ensurePhaseNotBlocked(round: GameRound) {
    if (round.pendingDisconnectPlayerIds.length > 0) {
      throw new AppError("PLAYER_PENDING", "仍有掉线玩家等待出题人处理");
    }

    if (round.questionerReconnectDeadlineAt) {
      throw new AppError("QUESTIONER_PENDING", "出题人重连倒计时尚未结束");
    }
  }

  private ensureCanVote(room: RoomRecord, voterId: string, targetId: string, tieBreak: boolean) {
    const round = this.requireRound(room);
    const voter = round.assignments[voterId];
    const target = round.assignments[targetId];

    if (
      !voter?.alive ||
      !target?.alive ||
      (voterId === targetId && room.id !== ROOM_ID_TEST_MODE)
    ) {
      throw new AppError("INVALID_VOTE", "投票对象无效");
    }

    if (tieBreak) {
      const candidates = round.tieBreak?.candidateIds ?? [];

      if (candidates.includes(voterId)) {
        throw new AppError("INVALID_VOTE", "平票玩家不能参与第二轮投票");
      }

      if (!candidates.includes(targetId)) {
        throw new AppError("INVALID_VOTE", "第二轮只能投给平票玩家");
      }
    }
  }

  private isDescriptionComplete(round: GameRound) {
    const aliveIds = Object.entries(round.assignments)
      .filter(([, state]) => state.alive)
      .map(([playerId]) => playerId);

    return aliveIds.every((playerId) => round.descriptionSubmittedBy.includes(playerId));
  }

  private isTieBreakDescriptionComplete(room: RoomRecord) {
    const round = this.requireRound(room);
    const candidates = round.tieBreak?.candidateIds ?? [];

    return candidates.every(
      (playerId) =>
        !round.assignments[playerId]?.alive ||
        round.tieBreak?.descriptionsDone.includes(playerId),
    );
  }

  private isVotingComplete(room: RoomRecord, tieBreak: boolean) {
    const round = this.requireRound(room);
    const aliveIds = this.getAliveAssignedPlayerIds(room);

    if (tieBreak) {
      const candidates = round.tieBreak?.candidateIds ?? [];
      const voterIds = aliveIds.filter((playerId) => !candidates.includes(playerId));
      const votes = round.tieBreak?.votes ?? [];
      return voterIds.every((playerId) => votes.some((vote) => vote.voterId === playerId));
    }

    return aliveIds.every((playerId) => round.votes.some((vote) => vote.voterId === playerId));
  }

  private isNightActionComplete(room: RoomRecord) {
    const round = this.requireRound(room);
    const actorIds = Object.entries(round.assignments)
      .filter(
        ([, state]) =>
          state.alive && (state.role === "civilian" || state.role === "undercover"),
      )
      .map(([playerId]) => playerId);

    return actorIds.every((playerId) =>
      round.nightActions.some((action) => action.actorId === playerId),
    );
  }

  private getAliveAssignedPlayerIds(room: RoomRecord) {
    return Object.entries(this.requireRound(room).assignments)
      .filter(([, state]) => state.alive)
      .map(([playerId]) => playerId);
  }

  private replaceVote(votes: VoteRecord[], voterId: string, targetId: string): VoteRecord[] {
    const nextVotes = votes.filter((vote) => vote.voterId !== voterId);
    nextVotes.push({ voterId, targetId });
    return nextVotes;
  }

  private replaceNightAction(
    actions: NightActionRecord[],
    actorId: string,
    nextAction: NightActionRecord,
  ): NightActionRecord[] {
    const nextActions = actions.filter((action) => action.actorId !== actorId);
    nextActions.push(nextAction);
    return nextActions;
  }

  private createDescription(
    player: PlayerRecord,
    text: string,
    kind: DescriptionRecord["kind"],
    cycle: number,
  ): DescriptionRecord {
    return {
      id: this.createId("description"),
      playerId: player.id,
      playerName: player.name,
      text,
      kind,
      cycle,
      createdAt: this.now(),
    };
  }

  private createChatMessage(
    playerId: string,
    playerName: string,
    text: string,
    system: boolean,
  ): ChatMessage {
    return {
      id: this.createId("chat"),
      playerId,
      playerName,
      text,
      createdAt: this.now(),
      system,
    };
  }

  private appendSystemMessage(room: RoomRecord, text: string) {
    room.chat.push(this.createChatMessage("system", "系统", text, true));
    room.chat = room.chat.slice(-CHAT_LIMIT);
  }

  private async tryReclaimOfflinePlayer(
    room: RoomRecord,
    connection: ConnectionRecord,
    requestedName: string,
  ) {
    const normalizedName = normalizeName(requestedName);

    if (!normalizedName) {
      throw new AppError("INVALID_NAME", "用户名不能为空");
    }

    const existingPlayer = Object.values(room.players).find(
      (player) =>
        player.name === normalizedName &&
        !player.online &&
        player.membership !== "kicked",
    );

    if (!existingPlayer) {
      return undefined;
    }

    return this.restorePlayerConnection(room, existingPlayer, connection, {
      appendMessage: `${existingPlayer.name} 已恢复连接`,
      rotateSessionToken: true,
    });
  }

  private async restorePlayerConnection(
    room: RoomRecord,
    player: PlayerRecord,
    connection: ConnectionRecord,
    options: {
      appendMessage: string;
      rotateSessionToken: boolean;
    },
  ) {
    if (options.rotateSessionToken) {
      player.sessionToken = this.createSessionToken();
    }

    this.attachConnection(room, player, connection);

    if (room.round) {
      this.clearPendingDisconnect(room.round, player.id);
    }

    if (room.round?.questionerPlayerId === player.id) {
      room.round.questionerReconnectDeadlineAt = undefined;
    }

    this.touchRoom(room);
    this.appendSystemMessage(room, options.appendMessage);

    await this.log({
      type: "room.reconnected",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: options.rotateSessionToken ? { joinedAs: "reclaim" } : undefined,
    });

    this.broadcastRoomEvent(room, "room.playerChanged", {
      roomId: room.id,
      action: "reconnected",
      playerId: player.id,
    });
    this.publishRoomState(room);
    this.publishLobby();

    return {
      roomId: room.id,
      playerId: player.id,
      sessionToken: player.sessionToken,
    };
  }

  private shouldQueueDisconnectForDecision(round: GameRound, player: PlayerRecord) {
    if (player.membership !== "active") {
      return false;
    }

    if (round.phase === "assigningQuestioner" || round.phase === "wordSubmission") {
      return true;
    }

    return Boolean(round.assignments[player.id]?.alive);
  }

  private enqueuePendingDisconnect(round: GameRound, playerId: string) {
    if (!round.pendingDisconnectPlayerIds.includes(playerId)) {
      round.pendingDisconnectPlayerIds.push(playerId);
    }
  }

  private clearPendingDisconnect(round: GameRound, playerId: string) {
    round.pendingDisconnectPlayerIds = round.pendingDisconnectPlayerIds.filter(
      (pendingPlayerId) => pendingPlayerId !== playerId,
    );
  }

  private getResumePhaseAfterForcedRemoval(
    phase: GamePhase,
  ): Exclude<GamePhase, "assigningQuestioner" | "wordSubmission" | "blankGuess"> {
    if (phase === "tieBreak") {
      return "voting";
    }

    if (
      phase === "description" ||
      phase === "voting" ||
      phase === "night" ||
      phase === "daybreak" ||
      phase === "gameOver"
    ) {
      return phase;
    }

    return "gameOver";
  }

  private async maybeAbortRoundAfterRosterChange(room: RoomRecord) {
    const round = room.round;

    if (!round || round.phase === "gameOver") {
      return;
    }

    if (round.phase === "assigningQuestioner") {
      if (!this.hasValidQuestionerCandidate(room)) {
        await this.finishRound(room, "aborted", "当前人数不足，系统已取消本局");
      }
      return;
    }

    if (round.phase === "wordSubmission" && round.questionerPlayerId) {
      try {
        validateRoleConfig(
          room.settings.roleConfig,
          this.getParticipantCount(room, round.questionerPlayerId),
          room.id === ROOM_ID_TEST_MODE,
        );
      } catch {
        await this.finishRound(room, "aborted", "当前人数不足，系统已取消本局");
      }
    }
  }

  private createPlayer(name: string, isBot: boolean): PlayerRecord {
    const normalized = normalizeName(name);

    if (!normalized) {
      throw new AppError("INVALID_NAME", "用户名不能为空");
    }

    return {
      id: this.createId("player"),
      sessionToken: this.createSessionToken(),
      name: normalized,
      score: 0,
      membership: "active",
      isReady: false,
      isBot,
      online: !isBot,
      joinedAt: this.now(),
      lastSeenAt: this.now(),
    };
  }

  private createSessionToken() {
    return `${this.createId("session")}_${crypto.randomUUID()}`;
  }

  private createId(prefix: string) {
    this.idCounter += 1;
    return `${prefix}_${this.idCounter.toString(36)}`;
  }

  private touchRoom(room: RoomRecord) {
    room.updatedAt = this.now();
    room.lastActivityAt = this.now();
  }

  private getConnection(connectionId: string) {
    const connection = this.connections.get(connectionId);

    if (!connection) {
      throw new AppError("CONNECTION_NOT_FOUND", "找不到连接上下文");
    }

    return connection;
  }

  private getConnectionByPlayer(playerId: string) {
    return [...this.connections.values()].find((connection) => connection.playerId === playerId);
  }

  private getRoom(roomId: string) {
    const room = this.rooms.get(roomId);

    if (!room) {
      throw new AppError("ROOM_NOT_FOUND", "房间不存在");
    }

    return room;
  }

  private requireRound(room: RoomRecord) {
    if (!room.round) {
      throw new AppError("ROUND_NOT_STARTED", "当前房间尚未开始游戏");
    }

    return room.round;
  }

  private requireRoomPlayer(connection: ConnectionRecord) {
    if (!connection.roomId || !connection.playerId) {
      throw new AppError("PLAYER_NOT_IN_ROOM", "当前连接尚未加入房间");
    }

    const room = this.getRoom(connection.roomId);
    const player = room.players[connection.playerId];

    if (!player) {
      throw new AppError("PLAYER_NOT_FOUND", "房间内不存在当前玩家");
    }

    return { room, player };
  }

  private ensureConnectionIsFree(connection: ConnectionRecord) {
    if (connection.roomId || connection.playerId) {
      throw new AppError("ALREADY_IN_ROOM", "当前连接已在房间中");
    }
  }

  private ensureHost(room: RoomRecord, playerId: string) {
    if (room.hostPlayerId !== playerId) {
      throw new AppError("FORBIDDEN", "只有房主可以执行该操作");
    }
  }

  private ensureQuestioner(round: GameRound, playerId: string) {
    if (round.questionerPlayerId !== playerId) {
      throw new AppError("FORBIDDEN", "只有出题人可以执行该操作");
    }
  }

  private ensureUniqueName(room: RoomRecord, name: string, exceptPlayerId?: string) {
    const normalized = normalizeName(name);

    if (
      Object.values(room.players).some(
        (player) => player.id !== exceptPlayerId && player.name === normalized,
      )
    ) {
      throw new AppError("NAME_CONFLICT", "该用户名已在房间内被占用");
    }
  }

  private ensurePasswordMatch(room: RoomRecord, password?: string | null) {
    if (room.settings.visibility === "private") {
      if (room.settings.password !== this.requirePassword(password)) {
        throw new AppError("PASSWORD_INCORRECT", "房间密码错误");
      }
    }
  }

  private requirePassword(password?: string | null) {
    const normalized = normalizeWord(password ?? "");

    if (!normalized) {
      throw new AppError("PASSWORD_REQUIRED", "该操作需要有效密码");
    }

    return normalized;
  }

  private reassignHost(room: RoomRecord) {
    // 现任房主仍在且未被踢出 → 保留；否则按加入顺序挑一位活跃玩家作为新房主。
    if (
      room.hostPlayerId &&
      room.players[room.hostPlayerId] &&
      room.players[room.hostPlayerId].membership !== "kicked"
    ) {
      return;
    }

    const nextHost = Object.values(room.players)
      .filter((player) => player.membership !== "kicked")
      // 优先在线玩家：避免把房主塞给一个已掉线的人。
      .sort((left, right) => {
        if (left.online !== right.online) {
          return left.online ? -1 : 1;
        }
        return left.joinedAt - right.joinedAt;
      })[0];

    if (nextHost) {
      room.hostPlayerId = nextHost.id;
    }
  }

  private isRoundActive(room: RoomRecord) {
    return Boolean(room.round && room.round.phase !== "gameOver");
  }

  // 测试模式已改为"手动跳转阶段 + 手动切换身份"，不再自动运行机器人；保留空实现避免大面积改调用点。
  private async runBots(_room: RoomRecord) {
    return;
  }

  private async log(entry: LogEntry) {
    await this.options.eventLogger.write(entry);
  }
}
