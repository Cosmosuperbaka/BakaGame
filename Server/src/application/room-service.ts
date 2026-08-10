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
import { ABSTAIN_TARGET_ID, ROOM_ID_TEST_MODE } from "../domain/model";
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
  shuffle,
  shouldEnterFinalBlankGuess,
  validateRoleConfig,
  type RandomSource,
} from "../domain/rules";
import type { LogEntry } from "../infrastructure/event-logger";
import { EventLogger } from "../infrastructure/event-logger";
import { WordBankRepository } from "../infrastructure/word-bank-repository";
import { createEvent, type ClientMessage } from "../transport/protocol";

import {
  ROOM_IDLE_TIMEOUT_MS,
  QUESTIONER_RECONNECT_TIMEOUT_MS,
  HOST_RECONNECT_TIMEOUT_MS,
  CHAT_LIMIT,
  TEST_MODE_DEFAULT_WORD,
  TEST_MODE_MAX_PLAYERS,
  BOT_NAME_SUFFIXES,
  BOT_DESCRIPTION_TEMPLATES,
} from "../config/constants";
import { ConnectionRegistry } from "./connection-registry";
import type { CommandHandler } from "./handlers/command-handler";
import { createGameCommandHandler } from "./handlers/game-command-handler";
import { createPlayerCommandHandler } from "./handlers/player-command-handler";
import { createRoomCommandHandler } from "./handlers/room-command-handler";
import { createTestCommandHandler } from "./handlers/test-command-handler";

export interface RoomServiceOptions {
  now?: () => number;
  random?: RandomSource;
  wordBankRepository: WordBankRepository;
  eventLogger: EventLogger;
}

export class RoomService {
  // ==================== 房间与状态机总控 ====================

  private readonly rooms = new Map<string, RoomRecord>();
  private readonly connectionRegistry: ConnectionRegistry;
  private readonly now: () => number;
  private readonly random: RandomSource;
  private readonly commandHandlers: CommandHandler[];
  private idCounter = 0;

  constructor(private readonly options: RoomServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.random =
      options.random ??
      ({
        nextInt: (maxExclusive: number) =>
          Math.floor(Math.random() * Math.max(maxExclusive, 1)),
      } satisfies RandomSource);
    this.connectionRegistry = new ConnectionRegistry();
    this.commandHandlers = [
      createRoomCommandHandler({
        subscribeRooms: (connection) => {
          connection.lobbySubscribed = true;
          this.publishLobby();
          return { subscribed: true };
        },
        create: (connection, message) => this.handleRoomCreate(connection, message),
        join: (connection, message) => this.handleRoomJoin(connection, message),
        reconnect: (connection, message) => this.handleRoomReconnect(connection, message),
        leave: (connection) => this.handleRoomLeave(connection),
        updateSettings: (connection, payload) =>
          this.handleUpdateSettings(connection, payload),
        kick: (connection, playerId) => this.handleKick(connection, playerId),
        transferHost: (connection, playerId) =>
          this.handleTransferHost(connection, playerId),
        sendChat: (connection, text) => this.handleChat(connection, text),
      }),
      createPlayerCommandHandler({
        now: () => this.now(),
        requireRoomPlayer: (connection) => this.requireRoomPlayer(connection),
        ensureUniqueName: (room, name, exceptPlayerId) =>
          this.ensureUniqueName(room, name, exceptPlayerId),
        isRoundActive: (room) => this.isRoundActive(room),
        normalizeRoleConfig: (room) => this.normalizeRoomRoleConfig(room),
        touchRoom: (room) => this.touchRoom(room),
        log: (entry) => this.log(entry),
        broadcastRoomEvent: (room, event, payload) =>
          this.broadcastRoomEvent(room, event, payload),
        publishRoomState: (room) => this.publishRoomState(room),
        publishLobby: () => this.publishLobby(),
      }),
      createGameCommandHandler({
        assignQuestioner: (connection, playerId) =>
          this.handleAssignQuestioner(connection, playerId),
        submitWords: (connection, payload) =>
          this.handleSubmitWords(
            connection,
            payload.words,
            payload.blankHint,
            payload.manualRoles,
          ),
        advancePhase: (connection) => this.handleAdvancePhase(connection),
        submitDescription: (connection, text) =>
          this.handleSubmitDescription(connection, text),
        submitVote: (connection, targetId) =>
          this.handleSubmitVote(connection, targetId),
        submitNightAction: (connection, targetId) =>
          this.handleSubmitNightAction(connection, targetId),
        submitBlankGuess: (connection, words) =>
          this.handleSubmitBlankGuess(connection, words),
        enterBlankGuess: (connection) => this.handleEnterBlankGuess(connection),
        updateBlankGuessDraft: (connection, words) =>
          this.handleUpdateBlankGuessDraft(connection, words),
        reviewBlankGuess: (connection, approve) =>
          this.handleReviewBlankGuess(connection, approve),
        cancelVote: (connection) => this.handleCancelVote(connection),
        cancelNightAction: (connection) => this.handleCancelNightAction(connection),
        requestSupplement: (connection, playerIds) =>
          this.handleRequestSupplement(connection, playerIds),
        resolveDisconnect: (connection, payload) =>
          this.handleResolveDisconnect(
            connection,
            payload.playerId,
            payload.resolution,
          ),
      }),
      createTestCommandHandler({
        jumpToPhase: (connection, phase) =>
          this.handleTestJumpToPhase(connection, phase),
        setMyRole: (connection, role) => this.handleTestSetMyRole(connection, role),
        addBot: (connection, count) => this.handleTestAddBot(connection, count),
        removeBot: (connection, playerId, count) =>
          this.handleTestRemoveBot(connection, playerId, count),
      }),
    ];
  }

  registerConnection(connection: ConnectionRecord): void {
    this.connectionRegistry.registerConnection(connection);
  }

  // 连接断开时只做连接解绑，真正的房间副作用统一交给 handlePlayerOffline。
  async unregisterConnection(connectionId: string): Promise<void> {
    const connection = this.connectionRegistry.unregisterConnection(connectionId);

    if (!connection || !connection.roomId || !connection.playerId) {
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
    const handler = this.commandHandlers.find((candidate) =>
      candidate.canHandle(message.type),
    );

    if (!handler) {
      throw new AppError("UNSUPPORTED_COMMAND", "暂不支持的命令");
    }

    return handler.execute(connection, message);
  }

  async runHousekeeping(): Promise<void> {
    // 统一处理空房清理、闲置超时和出题人掉线超时。
    const currentTime = this.now();

    for (const room of [...this.rooms.values()]) {
      // 测试房间不参与闲置/空房自动清理，方便开发者随时回来继续调试。
      const isTestRoom = room.id === ROOM_ID_TEST_MODE;

      if (this.shouldAutoCloseWhenEmpty(room) && this.getOnlineCount(room) === 0) {
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
        room.hostReconnectDeadlineAt !== undefined &&
        currentTime >= room.hostReconnectDeadlineAt
      ) {
        await this.transferHostAfterDisconnect(room);
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
    this.connectionRegistry.broadcastToAll(
      createEvent("server.shutdown", {
        message: "服务器即将关闭，请稍后重新连接",
      }),
    );
  }

  getHealthSnapshot() {
    return {
      roomCount: this.rooms.size,
      connectionCount: this.connectionRegistry.stats.totalConnections,
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
    });
  }

  private async handleRoomLeave(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);

    await this.handlePlayerOffline(room, player.id, "leave");

    return { left: true };
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
      settings: {
        name: room.settings.name,
        visibility: room.settings.visibility,
        allowSpectators: room.settings.allowSpectators,
        roleConfig: room.settings.roleConfig,
      },
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

    if (targetPlayerId === player.id) {
      throw new AppError("INVALID_KICK", "房主不能踢出自己");
    }

    const target = room.players[targetPlayerId];

    if (!target) {
      throw new AppError("PLAYER_NOT_FOUND", "目标玩家不存在");
    }

    if (this.isRoundActive(room) && room.round?.questionerPlayerId === target.id) {
      await this.finishRound(room, "aborted", "出题人被房主移出，本局中止");
    }

    await this.forceRemovePlayer(room, target.id, "房主已将其移出房间");

    this.broadcastRoomEvent(room, "room.playerChanged", {
      roomId: room.id,
      action: "kicked",
      playerId: target.id,
    });
    this.publishRoomState(room);
    this.publishLobby();
    await this.runBots(room);

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

    // 正式玩家担任出题人时若人数不够，自动把卧底数夹到上限（而不是直接拒绝）。
    if (target.membership === "active") {
      room.settings.roleConfig = this.clampRoleConfig(
        room.settings.roleConfig,
        participantCount,
      );
    }

    validateRoleConfig(room.settings.roleConfig, participantCount);

    round.questionerPlayerId = target.id;
    round.phase = "wordSubmission";
    round.speechMode = undefined;
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
    manualRoles?: Record<string, PlayerRole>,
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

    validateRoleConfig(room.settings.roleConfig, participantIds.length);

    if (room.settings.roleConfig.hasBlank && !normalizeWord(blankHint ?? "")) {
      throw new AppError("BLANK_HINT_REQUIRED", "开启白板时必须填写提示");
    }

    const assigned = assignRoles(
      participantIds,
      room.settings.roleConfig,
      words,
      blankHint ? normalizeWord(blankHint) : undefined,
      this.random,
      manualRoles,
    );

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
    round.descriptionOrder = this.createDescriptionOrder(room);
    round.descriptionSubmittedBy = [];
    round.votes = [];
    round.voteHistory = [];
    round.tieBreak = undefined;
    round.nightActions = [];
    round.blankGuessContext = undefined;
    this.touchRoom(room);

    // 异步后台保存词库，避免阻塞 WebSocket 主流程
    void this.options.wordBankRepository.savePair(words).catch((error) => {
      console.error("词库异步保存失败", (error as Error).message);
    });

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
    // waiting 由房主开局；gameOver 先退回等待房间，避免跳过下一局准备环节。
    const { room, player } = this.requireRoomPlayer(connection);
    const phase = room.round?.phase ?? "waiting";

    if (phase === "gameOver") {
      this.ensureHost(room, player.id);
      this.returnRoomToWaiting(room);
      return { phase: "waiting" as GamePhase };
    }

    if (phase === "waiting") {
      this.ensureHost(room, player.id);
      this.ensureAllReady(room);
      this.ensureMinimumPlayers(room);
      await this.startRound(room);
      return { phase: room.round?.phase ?? "waiting" };
    }

    const round = this.requireRound(room);
    this.ensureQuestioner(round, player.id);
    this.ensurePhaseNotBlocked(round);

    if (round.supplement && round.speechMode === "supplement") {
      throw new AppError("PHASE_INCOMPLETE", "出题人发起的补充发言尚未完成");
    }

    switch (phase) {
      case "description":
        if (!this.isDescriptionComplete(round)) {
          throw new AppError("PHASE_INCOMPLETE", "仍有玩家尚未描述");
        }
        {
          const aliveStates = Object.values(round.assignments).filter((state) => state.alive);
          const isTwoPlayerUndercoverEndgame =
            aliveStates.length === 2 &&
            aliveStates.filter((state) => state.role === "undercover").length === 1 &&
            aliveStates.filter((state) => state.role === "civilian").length === 1;

          if (isTwoPlayerUndercoverEndgame) {
            await this.finishRound(room, "undercover", "2人残局卧底胜");
            break;
          }
        }
        round.phase = "voting";
        round.speechMode = undefined;
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
          round.speechMode = undefined;
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
      default:
        throw new AppError("INVALID_PHASE", "当前阶段不能手动推进");
    }

    this.touchRoom(room);
    // 新阶段可能开始等待某个此前被放过的掉线玩家，这里补上暂停。
    this.requeuePendingDisconnects(room);
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

    const state = round.assignments[player.id];
    const pendingSupplement =
      round.supplement?.requestedPlayerIds.includes(player.id) &&
      !round.supplement.donePlayers.includes(player.id);

    // 补充发言优先：统一切换到 description/supplement 子状态后提交。
    if (round.supplement && round.speechMode === "supplement" && pendingSupplement) {
      if (!state?.alive || round.phase !== "description") {
        throw new AppError("ACTION_FORBIDDEN", "当前玩家不能补充发言");
      }
      round.supplement.donePlayers.push(player.id);
      round.descriptions.push(
        this.createDescription(player, normalized, "supplement", round.descriptionCycle, {
          supplementIndex: round.supplement.index,
        }),
      );
      if (round.supplement.donePlayers.length >= round.supplement.requestedPlayerIds.length) {
        const resumePhase = round.supplement.resumePhase;
        round.supplement = undefined;
        round.speechMode = resumePhase === "description" ? "normal" : undefined;
        round.phase = resumePhase;
      }
    } else if (round.phase === "description" && round.speechMode !== "supplement") {
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
      round.speechMode = "tieBreak";
      if (!round.tieBreak.candidateIds.includes(player.id)) {
        throw new AppError("ACTION_FORBIDDEN", "只有平票玩家可以补充描述");
      }

      if (round.tieBreak.descriptionsDone.includes(player.id)) {
        throw new AppError("ALREADY_SUBMITTED", "你已经提交过补充描述");
      }

      round.tieBreak.descriptionsDone.push(player.id);
      round.descriptions.push(
        this.createDescription(player, normalized, "tieBreak", round.descriptionCycle, {
          tieBreakIndex: round.tieBreakCount,
        }),
      );
    } else {
      throw new AppError("INVALID_PHASE", "当前阶段不能提交描述");
    }

    this.touchRoom(room);
    // 补充发言完成会直接切回原阶段，同样要重新检查掉线玩家。
    this.requeuePendingDisconnects(room);
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

  private async handleCancelVote(connection: ConnectionRecord) {
    // 撤销设计为幂等操作：客户端重试或快速连点时仍会收到最新私有状态。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);
    let cancelled = false;

    if (round.phase === "voting") {
      cancelled = round.votes.some((v) => v.voterId === player.id);
      round.votes = round.votes.filter((v) => v.voterId !== player.id);
    } else if (round.phase === "tieBreak" && round.tieBreak?.stage === "vote") {
      cancelled = round.tieBreak.votes.some((v) => v.voterId === player.id);
      round.tieBreak.votes = round.tieBreak.votes.filter((v) => v.voterId !== player.id);
    } else {
      throw new AppError("INVALID_PHASE", "当前阶段不能撤销投票");
    }

    this.touchRoom(room);
    this.publishRoomState(room);
    return { cancelled };
  }

  private async handleCancelNightAction(connection: ConnectionRecord) {
    // 允许已提交夜晚操作的玩家在主持人推进前撤销。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);

    if (round.phase !== "night") {
      throw new AppError("INVALID_PHASE", "当前阶段不能撤销夜晚操作");
    }

    const cancelled = round.nightActions.some((a) => a.actorId === player.id);
    round.nightActions = round.nightActions.filter((a) => a.actorId !== player.id);
    this.touchRoom(room);
    this.publishRoomState(room);
    return { cancelled };
  }

  private async handleRequestSupplement(connection: ConnectionRecord, playerIds: string[]) {
    // 出题人在本轮描述完成后、投票结算前，可点名若干玩家补充发言一次。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);

    this.ensureQuestioner(round, player.id);

    if (
      (round.phase !== "description" || round.speechMode !== "normal") &&
      round.phase !== "voting"
    ) {
      throw new AppError("INVALID_PHASE", "只能在本轮描述完成后、正常投票结算前发起补充");
    }

    if (!this.isDescriptionComplete(round)) {
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
      (max, d) => (d.supplementIndex !== undefined && d.supplementIndex > max ? d.supplementIndex : max),
      0,
    );

    round.supplement = {
      index: maxSuppIdx + 1,
      requestedPlayerIds: [...new Set(playerIds)],
      donePlayers: [],
      resumePhase: round.phase,
    };
    round.phase = "description";
    round.speechMode = "supplement";

    this.touchRoom(room);
    this.publishRoomState(room);
    return { requested: true };
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

      // 不能刀自己，测试房间同样适用。
      if (!targetState?.alive || targetId === player.id) {
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

    // 猜词已改为阻塞阶段：必须先进入 blankGuess，且只有本人能提交。
    if (round.phase !== "blankGuess" || round.blankGuessContext?.playerId !== player.id) {
      throw new AppError("ACTION_FORBIDDEN", "当前不能进行白板猜词");
    }

    if (round.blankGuessContext.pendingReview) {
      throw new AppError("ACTION_FORBIDDEN", "本次猜词正在等待主持人裁定");
    }

    const guess = evaluateBlankGuess(
      round,
      words,
      this.now(),
      round.blankGuessContext.reason,
    );

    // 机会在提交这一刻就消耗掉，裁定只决定这一次算不算猜中。
    round.blankGuessUsed = true;
    round.blankGuessRecords.push(guess);
    round.blankGuessContext.draft = undefined;
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
    } else {
      // 自动比对只认完全一致。细微差异交由主持人裁定，阶段继续阻塞。
      round.blankGuessContext.pendingReview = { words: guess.guessedWords };
      this.appendSystemMessage(room, `${player.name} 的猜词未完全匹配，等待主持人裁定`);
    }

    this.publishRoomState(room);
    this.broadcastRoomEvent(room, "game.roundSummary", room.round?.summary ?? null);
    await this.runBots(room);

    return { success: guess.success, pendingReview: !guess.success };
  }

  private async handleEnterBlankGuess(connection: ConnectionRecord) {
    // 白板主动猜词：先把房间切进阻塞阶段，其他人一起等这一次猜词。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);
    const state = round.assignments[player.id];

    if (!state || state.role !== "blank") {
      throw new AppError("ACTION_FORBIDDEN", "只有白板可以猜词");
    }

    if (round.blankGuessUsed) {
      throw new AppError("BLANK_GUESS_USED", "白板已经使用过猜词机会");
    }

    if (round.phase === "blankGuess") {
      throw new AppError("INVALID_PHASE", "已经处于白板猜词阶段");
    }

    // 只有已经发过词、且还没结算的阶段才能中途插入猜词。
    const resumePhase = round.phase;

    if (
      resumePhase !== "description" &&
      resumePhase !== "voting" &&
      resumePhase !== "tieBreak" &&
      resumePhase !== "night"
    ) {
      throw new AppError("INVALID_PHASE", "当前阶段不能进入白板猜词");
    }

    this.ensurePhaseNotBlocked(round);

    round.blankGuessContext = {
      playerId: player.id,
      reason: "active",
      resumePhase,
    };
    round.phase = "blankGuess";
    round.speechMode = undefined;

    this.touchRoom(room);
    this.appendSystemMessage(room, `${player.name} 发起了白板猜词`);

    await this.log({
      type: "game.blank_guess_entered",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: { reason: "active" },
    });

    this.broadcastPhaseAndPublish(room);
    return { phase: round.phase };
  }

  private async handleUpdateBlankGuessDraft(
    connection: ConnectionRecord,
    words: [string, string],
  ) {
    // 猜词过程本身是这一阶段的看点，草稿实时广播给全房。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);

    if (round.phase !== "blankGuess" || round.blankGuessContext?.playerId !== player.id) {
      throw new AppError("ACTION_FORBIDDEN", "当前不能更新猜词内容");
    }

    if (round.blankGuessContext.pendingReview) {
      throw new AppError("ACTION_FORBIDDEN", "本次猜词正在等待主持人裁定");
    }

    round.blankGuessContext.draft = words;
    this.touchRoom(room);
    this.publishRoomState(room);
    return { updated: true };
  }

  private async handleReviewBlankGuess(connection: ConnectionRecord, approve: boolean) {
    // 自动比对只认完全一致，主持人在此纠正细微差异导致的误判。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);
    this.ensureQuestioner(round, player.id);

    const pending = round.blankGuessContext?.pendingReview;

    if (round.phase !== "blankGuess" || !pending) {
      throw new AppError("ACTION_FORBIDDEN", "当前没有待裁定的白板猜词");
    }

    round.blankGuessContext!.pendingReview = undefined;
    const record = round.blankGuessRecords.at(-1);

    await this.log({
      type: "game.blank_guess_reviewed",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: { approve },
    });

    if (approve) {
      if (record) {
        record.success = true;
        record.approvedByQuestioner = true;
      }
      await this.finishRound(room, "blank", "白板猜词经主持人判定有效，获得胜利");
    } else if (round.blankGuessContext?.deferredWinner) {
      await this.finishRound(
        room,
        round.blankGuessContext.deferredWinner,
        "白板猜测失败，系统按残局条件结算",
      );
    } else if (round.blankGuessContext?.resumePhase) {
      round.phase = round.blankGuessContext.resumePhase;
      round.blankGuessContext = undefined;
      this.appendSystemMessage(room, "白板猜词未通过，游戏继续");
    }

    this.touchRoom(room);
    this.broadcastPhaseAndPublish(room);
    this.broadcastRoomEvent(room, "game.roundSummary", room.round?.summary ?? null);
    await this.runBots(room);

    return { approved: approve };
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
    // 房主手动转移：任意阶段均可转移给房间内未被踢出的成员。
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);

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
      this.returnRoomToWaiting(room);
      return { phase: "waiting" as GamePhase };
    }

    const activeIds = Object.values(room.players)
      .filter((p) => p.membership === "active")
      .map((p) => p.id);
    const useCallerAsQuestioner = target === "wordSubmission";

    // 出题人：跳到出题阶段时由调用者担任，其余情况保持本局已确定的人，
    // 没有则维持未指定——跳转不负责替玩家选出题人。
    const plannedQuestionerId = useCallerAsQuestioner
      ? player.id
      : room.round?.questionerPlayerId;
    const plannedParticipants = plannedQuestionerId
      ? activeIds.filter((id) => id !== plannedQuestionerId)
      : activeIds;

    // 人数校验必须在建 round 之前：否则单人也能跳「指定主持人」，
    // startRound 已经把游戏开起来，只是后面的分支才拒绝。
    // 出题人不参战，所以除了 4 名参战，还要留出他的位置——除非出题人是旁观者。
    const questionerIsSpectator = plannedQuestionerId
      ? room.players[plannedQuestionerId]?.membership === "spectator"
      : false;
    const enoughActive = questionerIsSpectator
      ? activeIds.length >= 4
      : activeIds.length >= 5;

    if (!enoughActive || plannedParticipants.length < 4) {
      throw new AppError("INSUFFICIENT_PLAYERS", "对局需要 4 名参战玩家，请先添加机器人");
    }

    // 确保 round 存在。
    if (!room.round) {
      await this.startRound(room);
    }

    const round = this.requireRound(room);
    const participantIds = plannedParticipants;

    if (target === "assigningQuestioner") {
      round.questionerPlayerId = undefined;
      round.phase = "assigningQuestioner";
      round.assignments = {};
      round.words = undefined;
      round.descriptionCycle = 0;
      round.descriptionOrder = [];
      round.descriptions = [];
      round.descriptionSubmittedBy = [];
      round.votes = [];
      round.voteHistory = [];
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

    // 出题人一旦确定就保持到本局结束：跳转不是换人，不能把已有出题人清成
    // undefined，否则出完题跳下一阶段，出题人就退化成普通玩家。
    round.questionerPlayerId = plannedQuestionerId;
    round.pendingDisconnectPlayerIds = [];
    round.questionerReconnectDeadlineAt = undefined;

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
      // clampRoleConfig 已按真实人数上限夹过天使/白板，这里不再额外放宽。
      const effectiveConfig: RoleConfig = config;
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
        round.descriptionOrder = [];
        round.descriptions = [];
        round.descriptionSubmittedBy = [];
        round.votes = [];
        round.voteHistory = [];
        round.tieBreak = undefined;
        round.nightActions = [];
        round.blankGuessUsed = false;
        round.blankGuessRecords = [];
        round.blankGuessContext = undefined;
        round.summary = undefined;
        break;
      case "description":
        round.phase = "description";
        round.speechMode = "normal";
        round.descriptionCycle = Math.max(1, round.descriptionCycle);
        round.descriptionOrder = this.createDescriptionOrder(room);
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
        round.speechMode = undefined;
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
        round.speechMode = "tieBreak";
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
        round.speechMode = undefined;
        round.nightActions = [];
        round.blankGuessUsed = false;
        round.blankGuessContext = undefined;
        round.summary = undefined;
        break;
      case "blankGuess": {
        // 只认本局真实的白板。没有白板时直接拒绝，不把任何人临时改成白板。
        const blankId = getBlankPlayerId(round.assignments);

        if (!blankId) {
          throw new AppError(
            "INVALID_PHASE",
            "本局没有白板，请先在房间设置里开启白板并重新开局",
          );
        }

        if (round.words && !round.words.blankHint) {
          round.words.blankHint = "测试提示";
        }

        round.phase = "blankGuess";
        round.speechMode = undefined;
        round.blankGuessUsed = false;
        round.blankGuessContext = {
          playerId: blankId,
          reason: "active",
          resumePhase: "description",
        };
        round.summary = undefined;
        break;
      }
      case "gameOver":
        await this.finishRound(room, "good", "手动结束本局");
        this.broadcastRoomEvent(room, "game.roundSummary", room.round?.summary ?? null);
        this.publishRoomState(room);
        return { phase: "gameOver" as GamePhase };
    }

    this.touchRoom(room);
    this.broadcastPhaseAndPublish(room);
    // 跳转后让机器人补齐新阶段的提交，否则出题人永远推不动。
    await this.runBots(room);
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

  /**
   * 测试房间：批量补入机器人玩家。
   * 机器人是真实的 PlayerRecord，走与真人完全相同的规则校验，
   * 只是没有连接、由 runBots 代为提交发言/投票/夜晚行动。
   */
  private async handleTestAddBot(connection: ConnectionRecord, count: number) {
    const { room } = this.requireRoomPlayer(connection);
    this.ensureTestRoom(room);

    const added: string[] = [];

    for (let index = 0; index < count; index += 1) {
      if (this.getActivePlayerIds(room).length >= TEST_MODE_MAX_PLAYERS) {
        break;
      }

      const bot = this.createPlayer(this.pickBotName(room), true);
      bot.isReady = true;
      // 与真人加入同规则：局内加入只能旁观，下一局才参战。
      bot.membership = this.isRoundActive(room) ? "spectator" : "active";
      room.players[bot.id] = bot;
      added.push(bot.id);
      this.broadcastRoomEvent(room, "room.playerChanged", {
        roomId: room.id,
        action: "joined",
        playerId: bot.id,
        name: bot.name,
      });
    }

    if (added.length === 0) {
      throw new AppError("ROOM_FULL", `测试房间最多 ${TEST_MODE_MAX_PLAYERS} 名玩家`);
    }

    // 人数变了，阵营配置的上限也跟着变，必须重新夹一次。
    this.normalizeRoomRoleConfig(room);
    this.touchRoom(room);
    this.publishRoomState(room);
    await this.runBots(room);

    return { added };
  }

  /** 测试房间：移除机器人。未指定 playerId 时从最后加入的开始移除。 */
  private async handleTestRemoveBot(
    connection: ConnectionRecord,
    playerId: string | undefined,
    count: number,
  ) {
    const { room } = this.requireRoomPlayer(connection);
    this.ensureTestRoom(room);

    const bots = Object.values(room.players).filter((player) => player.isBot);
    const targets = playerId
      ? bots.filter((bot) => bot.id === playerId)
      : bots.slice(-count);

    if (targets.length === 0) {
      throw new AppError("PLAYER_NOT_FOUND", "没有可移除的机器人");
    }

    // 走与房主踢人完全相同的路径：局内淘汰、房主改选、阵营夹取、人数不足中止
    // 全都由 forceRemovePlayer 负责，机器人不再有独立的移除逻辑。
    for (const bot of targets) {
      await this.forceRemovePlayer(room, bot.id, "kicked");
    }

    // 机器人被踢后只是标记为 kicked，测试房间要真正腾出名额，因此彻底删除记录。
    for (const bot of targets) {
      delete room.players[bot.id];
    }

    this.reassignHost(room);
    this.normalizeRoomRoleConfig(room);
    this.touchRoom(room);
    this.publishRoomState(room);
    await this.runBots(room);

    return { removed: targets.map((bot) => bot.id) };
  }

  private ensureTestRoom(room: RoomRecord) {
    if (room.id !== ROOM_ID_TEST_MODE) {
      throw new AppError("FORBIDDEN", "仅测试房间允许管理机器人");
    }
  }

  /** 机器人取「机器人A」这类不重名的名字，便于在玩家列里区分。 */
  private pickBotName(room: RoomRecord) {
    const used = new Set(Object.values(room.players).map((player) => player.name));

    for (const suffix of BOT_NAME_SUFFIXES) {
      const candidate = `机器人${suffix}`;

      if (!used.has(candidate)) {
        return candidate;
      }
    }

    let index = BOT_NAME_SUFFIXES.length + 1;

    while (used.has(`机器人${index}`)) {
      index += 1;
    }

    return `机器人${index}`;
  }

  private broadcastPhaseAndPublish(room: RoomRecord) {
    // 阶段变了就要重新判断掉线玩家是否已成为当前阶段的阻塞点。
    this.requeuePendingDisconnects(room);
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
      descriptionOrder: [],
      tieBreakCount: 0,
      descriptions: [],
      descriptionSubmittedBy: [],
      votes: [],
      voteHistory: [],
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

  private returnRoomToWaiting(room: RoomRecord) {
    room.round = undefined;
    for (const player of Object.values(room.players)) {
      // 机器人无法自行点击准备；旁观者则始终不参与准备计数。
      player.isReady = player.membership === "active" && player.isBot;
    }

    this.touchRoom(room);
    this.broadcastRoomEvent(room, "game.phaseChanged", {
      roomId: room.id,
      phase: "waiting",
    });
    this.publishRoomState(room);
    this.publishLobby();
  }

  private async resolveVoting(room: RoomRecord, tieBreak: boolean) {
    // 这个方法只负责“投票结算”，真正的胜负判断交给后续统一淘汰流程。
    const round = this.requireRound(room);
    const votes = tieBreak ? round.tieBreak?.votes ?? [] : round.votes;
    round.voteHistory.push({
      day: round.day,
      tieBreak,
      votes: votes.map((vote) => ({ ...vote })),
    });
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

    if (!tieBreak && (leaders.length > 1 || outcome.abstainCount >= outcome.maxVotes)) {
      round.tieBreakCount += 1;
      round.phase = "tieBreak";
      round.speechMode = "tieBreak";
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

    if (this.maybeEnterBlankGuess(room)) {
      return;
    }

    const winner = getWinnerAfterBlankFailure(round.assignments);

    if (winner) {
      await this.finishRound(room, winner, "夜晚结算后已满足胜利条件");
      return;
    }

    round.phase = "description";
    round.speechMode = "normal";
    round.day += 1;
    round.descriptionCycle += 1;
    round.descriptionOrder = this.createDescriptionOrder(room);
    round.descriptionSubmittedBy = [];
    round.votes = [];
    round.tieBreak = undefined;
    round.nightActions = [];
    round.supplement = undefined;

    this.broadcastRoomEvent(room, "game.daybreak", {
      day: round.day,
      eliminatedPlayerIds: eliminatedIds,
    });
  }

  private maybeEnterBlankGuess(room: RoomRecord): boolean {
    // 被淘汰不自动触发猜词：白板自己决定何时用掉这一次机会（game.enterBlankGuess）。
    // 这里只保留「残局触发」：其他阵营已满足胜负条件但白板仍存活时，
    // 在结算前强制补一次猜词。
    const round = this.requireRound(room);
    const finalBlankGuess = shouldEnterFinalBlankGuess(round);

    if (finalBlankGuess.shouldGuess && finalBlankGuess.blankPlayerId) {
      round.phase = "blankGuess";
      round.speechMode = undefined;
      round.blankGuessContext = {
        playerId: finalBlankGuess.blankPlayerId,
        reason: "finale",
        resumePhase: "gameOver",
        deferredWinner: finalBlankGuess.deferredWinner,
      };
      return true;
    }

    // 白板被淘汰但残局条件未触发：继续正常流程，白板玩家的 canSubmitBlankGuess 仍为 true。
    return false;
  }

  private async applyEliminationAndMove(
    room: RoomRecord,
    eliminatedIds: string[],
    reason: string,
    nextPhase: Exclude<GamePhase, "assigningQuestioner" | "wordSubmission">,
  ) {
    // 所有“有人出局”的阶段都汇总到这里，统一做淘汰、白板插入和胜负判断。
    const round = this.requireRound(room);

    if (eliminatedIds.length > 0) {
      recordEliminations(round.assignments, eliminatedIds, reason, this.now());
    }

    if (this.maybeEnterBlankGuess(room)) {
      return;
    }

    const winner = getWinnerAfterBlankFailure(round.assignments);

    if (winner) {
      await this.finishRound(room, winner, "阶段结算后已满足胜利条件");
      return;
    }

    round.phase = nextPhase;
    round.speechMode = nextPhase === "description" ? "normal" : undefined;
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
    round.speechMode = undefined;
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
      words: round.words
        ? {
            pair: [...round.words.pair] as [string, string],
            civilianWord: round.words.civilianWord,
            undercoverWord: round.words.undercoverWord,
            blankHint: round.words.blankHint,
          }
        : undefined,
      voteHistory: round.voteHistory.map((entry) => ({
        day: entry.day,
        tieBreak: entry.tieBreak,
        votes: entry.votes.map((vote) => ({ ...vote })),
      })),
    };

    for (const player of Object.values(room.players)) {
      // 结算后统一重置为“未准备”，房主返回等待阶段后由全员重新确认。
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
    const connection = this.connectionRegistry.findConnectionByPlayerId(player.id);

    if (connection) {
      connection.playerId = undefined;
      connection.roomId = undefined;
    }

    const round = room.round;
    const wasHost = room.hostPlayerId === player.id;

    if (wasHost) {
      if (reason === "leave") {
        room.hostPlayerId = "";
        room.hostReconnectDeadlineAt = undefined;
      } else {
        room.hostReconnectDeadlineAt = this.now() + HOST_RECONNECT_TIMEOUT_MS;
      }
    }

    if (!round || round.phase === "gameOver") {
      // 房主显式离开时，无条件把身份交给下一位玩家；这样下一局不会卡在没人能操控的状态。
      if (reason === "leave" && player.score === 0 && !player.isBot) {
        delete room.players[player.id];
      }

      if (wasHost && reason === "leave") {
        // 先临时置空，让 reassignHost 按加入时间重新选出首位。
        room.hostPlayerId = "";
      }

      if (wasHost && reason === "leave") {
        this.reassignHost(room);
      }
      this.normalizeRoomRoleConfig(room);
      this.touchRoom(room);
      if (this.shouldAutoCloseWhenEmpty(room) && this.getOnlineCount(room) === 0) {
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

    if (wasHost && reason === "leave") {
      this.reassignHost(room);
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
    if (this.shouldAutoCloseWhenEmpty(room) && this.getOnlineCount(room) === 0) {
      await this.closeRoom(room, "empty");
    } else {
      this.publishRoomState(room);
      this.publishLobby();
    }
  }

  /**
   * 空房是否应当自动关闭。测试房间要能在最后一人刷新页面后仍然存在，
   * 否则每次刷新都会丢掉正在调试的房间状态。
   */
  private shouldAutoCloseWhenEmpty(room: RoomRecord) {
    return room.id !== ROOM_ID_TEST_MODE;
  }

  private async forceRemovePlayer(room: RoomRecord, playerId: string, reason: string) {
    // 强制移除既可能来自房主踢人，也可能来自掉线淘汰决策。
    const player = room.players[playerId];
    let preservedVotes: GameRound["votes"] | undefined;
    let preservedNightActions: GameRound["nightActions"] | undefined;
    let preservedTieBreak: GameRound["tieBreak"] | undefined;
    let supplementStillActive = false;

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
      const round = room.round;
      this.clearPendingDisconnect(round, player.id);
      round.votes = round.votes.filter(
        (vote) => vote.voterId !== player.id && vote.targetId !== player.id,
      );
      round.nightActions = round.nightActions.filter(
        (action) => action.actorId !== player.id && action.targetId !== player.id,
      );
      round.descriptionOrder = round.descriptionOrder.filter(
        (descriptionPlayerId) => descriptionPlayerId !== player.id,
      );
      round.descriptionSubmittedBy = round.descriptionSubmittedBy.filter(
        (submittedPlayerId) => submittedPlayerId !== player.id,
      );

      if (round.tieBreak) {
        round.tieBreak.candidateIds = round.tieBreak.candidateIds.filter(
          (candidateId) => candidateId !== player.id,
        );
        round.tieBreak.descriptionsDone = round.tieBreak.descriptionsDone.filter(
          (donePlayerId) => donePlayerId !== player.id,
        );
        round.tieBreak.votes = round.tieBreak.votes.filter(
          (vote) => vote.voterId !== player.id && vote.targetId !== player.id,
        );
      }

      if (round.supplement) {
        round.supplement.requestedPlayerIds = round.supplement.requestedPlayerIds.filter(
          (requestedPlayerId) => requestedPlayerId !== player.id,
        );
        round.supplement.donePlayers = round.supplement.donePlayers.filter(
          (donePlayerId) => donePlayerId !== player.id,
        );

        if (
          round.supplement.donePlayers.length >= round.supplement.requestedPlayerIds.length
        ) {
          const resumePhase = round.supplement.resumePhase;
          round.supplement = undefined;
          round.phase = resumePhase;
          round.speechMode = resumePhase === "description" ? "normal" : undefined;
        }
      }

      preservedVotes = [...round.votes];
      preservedNightActions = round.nightActions.map((action) => ({ ...action }));
      preservedTieBreak = round.tieBreak
        ? {
            ...round.tieBreak,
            candidateIds: [...round.tieBreak.candidateIds],
            descriptionsDone: [...round.tieBreak.descriptionsDone],
            votes: round.tieBreak.votes.map((vote) => ({ ...vote })),
          }
        : undefined;
      supplementStillActive = Boolean(round.supplement);
    }

    if (room.round?.assignments[player.id]?.alive && room.round.phase !== "gameOver") {
      const previousPhase = room.round.phase;
      const resumePhase =
        previousPhase === "tieBreak" && (preservedTieBreak?.candidateIds.length ?? 0) <= 1
          ? "night"
          : this.getResumePhaseAfterForcedRemoval(previousPhase);
      await this.applyEliminationAndMove(room, [player.id], reason, resumePhase);

      if (!room.round.summary) {
        if (resumePhase === "voting" || supplementStillActive) {
          room.round.votes = preservedVotes ?? [];
        }
        if (resumePhase === "night") {
          room.round.nightActions = preservedNightActions ?? [];
        }
        if (resumePhase === "tieBreak" && preservedTieBreak) {
          room.round.tieBreak = preservedTieBreak;
          room.round.speechMode =
            preservedTieBreak.stage === "description" ? "tieBreak" : undefined;
        }
        if (supplementStillActive) {
          room.round.phase = "description";
          room.round.speechMode = "supplement";
        }
      }
    }

    this.reassignHost(room);
    this.normalizeRoomRoleConfig(room);
    this.touchRoom(room);
    // 猜词的白板被移除后没人能推进阻塞阶段，必须就地收束。
    await this.resolveAbandonedBlankGuess(room);
    await this.maybeAbortRoundAfterRosterChange(room);
    // 移除玩家可能改变阶段或补充发言状态，其他掉线玩家的待决状态要跟着重算：
    // 否则推进会因「仍有玩家未提交」被拒，却没有人被要求处理那次掉线。
    this.requeuePendingDisconnects(room);

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
    for (const connection of this.connectionRegistry.getRoomConnections(room.id)) {
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

  /**
   * 统一描述、补充发言与平票 PK 的当前发言状态。
   * 提交状态可以公开，但内容只会按顺序公开连续完成的前缀。
   */
  private getCurrentSpeechState(round: GameRound) {
    if (
      round.phase === "description" &&
      round.speechMode === "supplement" &&
      round.supplement
    ) {
      return {
        order: round.supplement.requestedPlayerIds,
        submittedPlayerIds: round.supplement.donePlayers,
        matches: (description: DescriptionRecord) =>
          description.kind === "supplement" &&
          description.supplementIndex === round.supplement?.index,
      };
    }

    if (round.phase === "tieBreak" && round.tieBreak?.stage === "description") {
      return {
        order: round.tieBreak.candidateIds,
        submittedPlayerIds: round.tieBreak.descriptionsDone,
        matches: (description: DescriptionRecord) =>
          description.kind === "tieBreak" &&
          description.tieBreakIndex === round.tieBreakCount,
      };
    }

    if (round.phase === "description") {
      return {
        order: round.descriptionOrder,
        submittedPlayerIds: round.descriptionSubmittedBy,
        matches: (description: DescriptionRecord) =>
          description.kind === "description" &&
          description.cycle === round.descriptionCycle,
      };
    }

    return undefined;
  }

  private buildPublicDescriptions(round: GameRound | undefined): DescriptionRecord[] {
    if (!round) {
      return [];
    }

    const speechState = this.getCurrentSpeechState(round);

    if (!speechState) {
      return round.descriptions;
    }

    const submitted = new Set(speechState.submittedPlayerIds);
    const revealed = new Set<string>();

    for (const playerId of speechState.order) {
      if (!submitted.has(playerId)) {
        break;
      }
      revealed.add(playerId);
    }

    const historical = round.descriptions.filter((description) => !speechState.matches(description));
    const currentByPlayer = new Map(
      round.descriptions
        .filter((description) => speechState.matches(description))
        .map((description) => [description.playerId, description]),
    );

    return [
      ...historical,
      ...speechState.order.flatMap((playerId) => {
        if (!revealed.has(playerId)) {
          return [];
        }
        const description = currentByPlayer.get(playerId);
        return description ? [description] : [];
      }),
    ];
  }

  private buildRoomSnapshot(room: RoomRecord): RoomSnapshot {
    // 快照是前端渲染主数据源，尽量保证“一包就够渲染当前房间”。
    const speechState = room.round ? this.getCurrentSpeechState(room.round) : undefined;

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
        roundId: room.round?.id,
        speechMode: room.round?.speechMode,
        speechResumePhase: room.round?.supplement?.resumePhase,
        supplementIndex: room.round?.supplement?.index,
        started: Boolean(room.round),
        day: room.round?.day ?? 0,
        descriptionOrder: room.round?.descriptionOrder,
        speechOrder: speechState ? [...speechState.order] : undefined,
        submittedSpeechPlayerIds: speechState
          ? [...speechState.submittedPlayerIds]
          : undefined,
        questionerPlayerId: room.round?.questionerPlayerId,
        tieBreakStage: room.round?.tieBreak?.stage,
        tieBreakIndex: room.round?.tieBreak ? room.round.tieBreakCount : undefined,
        tieBreakCandidateIds: room.round?.tieBreak?.candidateIds,
        pendingDisconnectPlayerId: room.round?.pendingDisconnectPlayerIds[0],
        questionerReconnectDeadlineAt: room.round?.questionerReconnectDeadlineAt,
        blankGuessPlayerId: room.round?.blankGuessContext?.playerId,
        blankGuessReason: room.round?.blankGuessContext?.reason,
        blankGuessDraft: room.round?.blankGuessContext?.draft,
        blankGuessPendingReview: room.round?.blankGuessContext?.pendingReview
          ? true
          : undefined,
        pendingSupplementPlayerIds: room.round?.supplement
          ? room.round.supplement.requestedPlayerIds.filter(
              (id) => !room.round!.supplement!.donePlayers.includes(id),
            )
          : undefined,
      },
      players: this.buildPublicPlayers(room),
      descriptions: this.buildPublicDescriptions(room.round),
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
        nightActionSubmitted: false,
      };
    }

    if (hasPrivilegedIdentityView) {
      return {
        playerId: player.id,
        sessionToken: player.sessionToken,
        isQuestioner: round.questionerPlayerId === player.id,
        canSubmitBlankGuess: false,
        blankGuessUsed: round.blankGuessUsed,
        nightActionSubmitted: false,
        globalWords: round.words
          ? {
              civilianWord: round.words.civilianWord,
              undercoverWord: round.words.undercoverWord,
              blankHint: round.words.blankHint,
            }
          : undefined,
        questionerView: Object.entries(round.assignments).map(([playerId, item]) => ({
          playerId,
          role: item.role,
          side: item.side,
          alive: item.alive,
        })),
        privilegedActionPreview: {
          votes: round.phase === "tieBreak" ? (round.tieBreak?.votes ?? []) : round.votes,
          nightActions: round.nightActions.map(({ actorId, targetId }) => ({
            actorId,
            targetId,
          })),
        },
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
      // 只表示「还有猜词机会」。是否已在阻塞阶段由公共快照的
      // blankGuessPlayerId 表达，客户端据此决定显示入口还是输入界面。
      canSubmitBlankGuess: state?.role === "blank" && !round.blankGuessUsed,
      blankGuessUsed: round.blankGuessUsed,
      nightActionSubmitted: round.nightActions.some((action) => action.actorId === player.id),
      myCurrentVoteTargetId:
        round.phase === "tieBreak"
          ? round.tieBreak?.votes.find((v) => v.voterId === player.id)?.targetId
          : round.votes.find((v) => v.voterId === player.id)?.targetId,
      myCurrentNightTargetId: round.nightActions.find((action) => action.actorId === player.id)
        ?.targetId,
    };
  }

  private publishRoomState(room: RoomRecord) {
    // 每次状态变化都同时推送公共快照与当前连接的私有视图。
    const snapshot = this.buildRoomSnapshot(room);

    for (const connection of this.connectionRegistry.getRoomConnections(room.id)) {
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
    this.connectionRegistry.broadcastToLobby(
      createEvent("lobby.rooms", this.getRoomSummaries()),
    );
  }

  private broadcastRoomEvent(room: RoomRecord, event: string, payload: unknown) {
    this.connectionRegistry.broadcastToRoom(room.id, createEvent(event, payload));
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

      try {
        validateRoleConfig(room.settings.roleConfig, participantCount);
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

    // 对局需要 4 名参战玩家，出题人不参战：
    // 有在线旁观者时旁观出题，4 名正式玩家即可；否则需正式玩家中出一人，至少 5 名。
    const hasOnlineSpectator = Object.values(room.players).some(
      (player) => player.membership === "spectator" && player.online,
    );
    const requiredActive = hasOnlineSpectator ? 4 : 5;

    if (activeCount < requiredActive) {
      throw new AppError(
        "INSUFFICIENT_PLAYERS",
        hasOnlineSpectator ? "游戏至少需要 4 名玩家" : "游戏至少需要 4 名玩家和 1 名出题人",
      );
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
    const isAbstain = targetId === ABSTAIN_TARGET_ID;

    // 不能投自己，测试房间同样适用：测试房要复现真实规则。
    if (!voter?.alive || (!isAbstain && !target?.alive) || (!isAbstain && voterId === targetId)) {
      throw new AppError("INVALID_VOTE", "投票对象无效");
    }

    if (tieBreak) {
      const candidates = round.tieBreak?.candidateIds ?? [];

      if (candidates.includes(voterId)) {
        throw new AppError("INVALID_VOTE", "平票玩家不能参与第二轮投票");
      }

      if (!isAbstain && !candidates.includes(targetId)) {
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

  private createDescriptionOrder(room: RoomRecord) {
    const round = this.requireRound(room);
    const order = shuffle(this.getAliveAssignedPlayerIds(room), this.random);

    if (round.day === 1) {
      const blankPlayerId = getBlankPlayerId(round.assignments);
      const blankIndex = blankPlayerId ? order.indexOf(blankPlayerId) : -1;
      const secondHalfStart = Math.floor(order.length / 2);

      if (blankIndex >= 0 && blankIndex < secondHalfStart) {
        const swapIndex = secondHalfStart + this.random.nextInt(order.length - secondHalfStart);
        [order[blankIndex], order[swapIndex]] = [order[swapIndex], order[blankIndex]];
      }
    }

    return order;
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
    extra?: { tieBreakIndex?: number; supplementIndex?: number },
  ): DescriptionRecord {
    return {
      id: this.createId("description"),
      playerId: player.id,
      playerName: player.name,
      text,
      kind,
      cycle,
      tieBreakIndex: extra?.tieBreakIndex,
      supplementIndex: extra?.supplementIndex,
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

  private async restorePlayerConnection(
    room: RoomRecord,
    player: PlayerRecord,
    connection: ConnectionRecord,
    options: {
      appendMessage: string;
    },
  ) {
    this.attachConnection(room, player, connection);

    if (room.round) {
      this.clearPendingDisconnect(room.round, player.id);
    }

    if (room.round?.questionerPlayerId === player.id) {
      room.round.questionerReconnectDeadlineAt = undefined;
    }

    if (room.hostPlayerId === player.id) {
      room.hostReconnectDeadlineAt = undefined;
    }

    this.touchRoom(room);
    this.appendSystemMessage(room, options.appendMessage);

    await this.log({
      type: "room.reconnected",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
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

  /**
   * 掉线玩家是否需要立刻暂停游戏、等出题人抉择。
   *
   * 判定标准是「当前阶段还在等这个人操作吗」：已经交过描述、投过票的玩家
   * 掉线不影响本阶段推进，暂停只会白等。这类玩家在下一个需要其操作的阶段
   * 由 requeuePendingDisconnects 重新入队。
   */
  private shouldQueueDisconnectForDecision(round: GameRound, player: PlayerRecord) {
    if (player.membership !== "active") {
      return false;
    }

    // 这两个阶段还没有分配身份，也没有「已提交」的概念，只能一律暂停。
    if (round.phase === "assigningQuestioner" || round.phase === "wordSubmission") {
      return true;
    }

    if (!round.assignments[player.id]?.alive) {
      return false;
    }

    switch (round.phase) {
      case "description": {
        // 普通描述、补充发言与平票 PK 共用同一份发言状态，不另写判定。
        const speech = this.getCurrentSpeechState(round);
        if (!speech) return false;
        return (
          speech.order.includes(player.id) && !speech.submittedPlayerIds.includes(player.id)
        );
      }
      case "voting":
        return !round.votes.some((vote) => vote.voterId === player.id);
      case "tieBreak": {
        if (round.tieBreak?.stage === "description") {
          const speech = this.getCurrentSpeechState(round);
          if (!speech) return false;
          return (
            speech.order.includes(player.id) && !speech.submittedPlayerIds.includes(player.id)
          );
        }
        // PK 投票阶段候选人本人不投票，因此不必等他。
        if (round.tieBreak?.candidateIds.includes(player.id)) return false;
        return !(round.tieBreak?.votes ?? []).some((vote) => vote.voterId === player.id);
      }
      case "night": {
        const role = round.assignments[player.id]?.role;
        if (role !== "civilian" && role !== "undercover") return false;
        return !round.nightActions.some((action) => action.actorId === player.id);
      }
      case "blankGuess":
        // 只有正在猜词的白板本人会卡住这个阶段。
        return round.blankGuessContext?.playerId === player.id;
      default:
        return false;
    }
  }

  /**
   * 阶段推进后重新检查掉线玩家：上一阶段被放过的人，
   * 到了需要他操作的阶段就必须在这里补上暂停，否则会永远无人过问。
   */
  private requeuePendingDisconnects(room: RoomRecord) {
    const round = room.round;

    if (!round || round.phase === "gameOver") {
      return;
    }

    for (const player of Object.values(room.players)) {
      if (player.online || player.isBot) continue;
      if (round.pendingDisconnectPlayerIds.includes(player.id)) continue;
      // 出题人掉线走重连倒计时，不并入待抉择队列。
      if (round.questionerPlayerId === player.id) continue;
      if (!this.shouldQueueDisconnectForDecision(round, player)) continue;

      this.enqueuePendingDisconnect(round, player.id);
      this.broadcastRoomEvent(room, "game.disconnectDecisionRequested", {
        roomId: room.id,
        playerId: player.id,
      });
    }
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
  ): Exclude<GamePhase, "assigningQuestioner" | "wordSubmission"> {
    if (
      phase === "description" ||
      phase === "voting" ||
      phase === "tieBreak" ||
      phase === "night" ||
      phase === "blankGuess" ||
      phase === "gameOver"
    ) {
      return phase;
    }

    return "gameOver";
  }

  /**
   * 猜词的白板离场后收束阻塞阶段。
   *
   * blankGuess 只能由白板本人提交、或出题人裁定来推进，两者都没了就再没有
   * 出口，全房会永远停在这一阶段。所以离场时必须就地结束：残局条件已定的
   * 按该条件结算，否则退回发起猜词时的阶段继续游戏。
   */
  private async resolveAbandonedBlankGuess(room: RoomRecord) {
    const round = room.round;

    if (round?.phase !== "blankGuess" || !round.blankGuessContext) {
      return;
    }

    const guesser = room.players[round.blankGuessContext.playerId];
    const stillPlaying =
      guesser?.membership === "active" && round.assignments[guesser.id] !== undefined;

    if (stillPlaying) {
      return;
    }

    const { deferredWinner, resumePhase } = round.blankGuessContext;
    round.blankGuessContext = undefined;

    if (deferredWinner) {
      await this.finishRound(room, deferredWinner, "白板已离场，系统按残局条件结算");
      return;
    }

    round.phase = resumePhase ?? "gameOver";
    round.speechMode = round.phase === "description" ? "normal" : undefined;
    this.appendSystemMessage(room, "白板已离场，本次猜词作废，游戏继续");
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
    return this.connectionRegistry.getConnection(connectionId);
  }

  private getConnectionByPlayer(playerId: string) {
    return this.connectionRegistry.findConnectionByPlayerId(playerId);
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
    const candidates = Object.values(room.players).filter(
      (player) => player.membership !== "kicked",
    );
    const current = room.hostPlayerId ? room.players[room.hostPlayerId] : undefined;
    // 机器人不会操作房间：房主落在机器人身上，等于没人能开局、改设置或踢人。
    const botHoldsHostWhileHumanWaits =
      Boolean(current?.isBot) && candidates.some((player) => !player.isBot);

    // 现任房主仍在且未被踢出 → 保留。唯一例外是机器人占着房主而还有真人可接手。
    if (current && current.membership !== "kicked" && !botHoldsHostWhileHumanWaits) {
      return;
    }

    const nextHost = [...candidates].sort((left, right) => {
      // 真人优先，其次在线玩家：避免把房主塞给机器人或已掉线的人。
      if (left.isBot !== right.isBot) {
        return left.isBot ? 1 : -1;
      }
      if (left.online !== right.online) {
        return left.online ? -1 : 1;
      }
      return left.joinedAt - right.joinedAt;
    })[0];

    if (nextHost) {
      room.hostPlayerId = nextHost.id;
    }
  }

  private async transferHostAfterDisconnect(room: RoomRecord) {
    const previousHostId = room.hostPlayerId;
    const previousHost = room.players[previousHostId];

    if (!previousHost || previousHost.online || previousHost.membership === "kicked") {
      room.hostReconnectDeadlineAt = undefined;
      return;
    }

    const nextHost = Object.values(room.players)
      .filter(
        (player) =>
          player.membership === "active" && player.online && !player.isBot,
      )
      .sort((left, right) => left.joinedAt - right.joinedAt)[0];

    if (!nextHost) {
      return;
    }

    room.hostReconnectDeadlineAt = undefined;
    room.hostPlayerId = nextHost.id;
    this.touchRoom(room);
    this.appendSystemMessage(room, `${previousHost.name} 断线超时，房主已转移给 ${nextHost.name}`);

    await this.log({
      type: "room.host_transferred",
      createdAt: this.now(),
      roomId: room.id,
      payload: {
        previousHostId,
        nextHostId: nextHost.id,
        reason: "disconnect_timeout",
      },
    });

    this.broadcastRoomEvent(room, "room.playerChanged", {
      roomId: room.id,
      action: "host_changed",
      playerId: nextHost.id,
    });
    this.publishRoomState(room);
    this.publishLobby();
  }

  private isRoundActive(room: RoomRecord) {
    return Boolean(room.round && room.round.phase !== "gameOver");
  }

  /**
   * 机器人补齐当前阶段所有必需的提交。
   *
   * 机器人不走 execute 分支（它们没有连接），而是直接改 round 状态，
   * 但改的都是与真人命令完全相同的字段，因此
   * isDescriptionComplete / isVotingComplete / isNightActionComplete
   * 这些既有判定对机器人和真人是同一套逻辑。
   *
   * 只补「阻塞推进」的提交，不代替出题人推进阶段：
   * 测试房间要能停在每个阶段观察 UI。
   */
  private async runBots(room: RoomRecord) {
    const round = room.round;

    if (!round || round.phase === "gameOver") {
      return;
    }

    const bots = Object.values(room.players).filter(
      (player) => player.isBot && round.assignments[player.id]?.alive,
    );

    if (bots.length === 0) {
      return;
    }

    let changed = false;

    for (const bot of bots) {
      // 补充发言优先，与 handleSubmitDescription 的判定顺序保持一致。
      if (
        round.supplement &&
        round.speechMode === "supplement" &&
        round.supplement.requestedPlayerIds.includes(bot.id) &&
        !round.supplement.donePlayers.includes(bot.id)
      ) {
        round.supplement.donePlayers.push(bot.id);
        round.descriptions.push(
          this.createDescription(bot, this.pickBotDescription(round, bot.id), "supplement", round.descriptionCycle, {
            supplementIndex: round.supplement.index,
          }),
        );
        changed = true;
        continue;
      }

      if (
        round.phase === "description" &&
        round.speechMode !== "supplement" &&
        !round.descriptionSubmittedBy.includes(bot.id)
      ) {
        round.descriptionSubmittedBy.push(bot.id);
        round.descriptions.push(
          this.createDescription(bot, this.pickBotDescription(round, bot.id), "description", round.descriptionCycle),
        );
        changed = true;
        continue;
      }

      if (round.phase === "tieBreak" && round.tieBreak?.stage === "description") {
        if (
          round.tieBreak.candidateIds.includes(bot.id) &&
          !round.tieBreak.descriptionsDone.includes(bot.id)
        ) {
          round.tieBreak.descriptionsDone.push(bot.id);
          round.descriptions.push(
            this.createDescription(bot, this.pickBotDescription(round, bot.id), "tieBreak", round.descriptionCycle, {
              tieBreakIndex: round.tieBreakCount,
            }),
          );
          changed = true;
        }

        continue;
      }

      if (round.phase === "voting" || (round.phase === "tieBreak" && round.tieBreak?.stage === "vote")) {
        const tieBreak = round.phase === "tieBreak";
        const votes = tieBreak ? round.tieBreak!.votes : round.votes;

        // 平票 PK 中候选人本人不参与投票，与 ensureCanVote 一致。
        if (tieBreak && round.tieBreak!.candidateIds.includes(bot.id)) {
          continue;
        }

        if (votes.some((vote) => vote.voterId === bot.id)) {
          continue;
        }

        const targetId = this.pickBotVoteTarget(room, round, bot.id, tieBreak);

        if (tieBreak) {
          round.tieBreak!.votes = this.replaceVote(votes, bot.id, targetId);
        } else {
          round.votes = this.replaceVote(votes, bot.id, targetId);
        }

        changed = true;
        continue;
      }

      if (round.phase === "night") {
        const state = round.assignments[bot.id];

        // 只有平民和卧底有夜晚行动，天使/白板不参与也不被等待。
        if (state.role !== "civilian" && state.role !== "undercover") {
          continue;
        }

        if (round.nightActions.some((action) => action.actorId === bot.id)) {
          continue;
        }

        // 平民刀人会刀死自己，所以机器人平民一律不行动；
        // 卧底才去刀一个非自己的存活目标。
        const targetId =
          state.role === "undercover" ? this.pickBotNightTarget(room, bot.id) : undefined;

        round.nightActions = this.replaceNightAction(round.nightActions, bot.id, {
          actorId: bot.id,
          actorRole: state.role,
          targetId,
        });
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    // 补充发言可能因机器人的提交而完成，需要按真人路径收尾并回到原阶段。
    if (
      round.supplement &&
      round.speechMode === "supplement" &&
      round.supplement.donePlayers.length >= round.supplement.requestedPlayerIds.length
    ) {
      const resumePhase = round.supplement.resumePhase;
      round.supplement = undefined;
      round.speechMode = resumePhase === "description" ? "normal" : undefined;
      round.phase = resumePhase;
    }

    this.touchRoom(room);
    this.publishRoomState(room);
  }

  /** 机器人发言文案：按玩家在本局的位置轮换模板，读起来不至于全场雷同。 */
  private pickBotDescription(round: GameRound, botId: string) {
    const ids = Object.keys(round.assignments).sort();
    const index = Math.max(ids.indexOf(botId), 0) + round.descriptionCycle;
    return BOT_DESCRIPTION_TEMPLATES[index % BOT_DESCRIPTION_TEMPLATES.length];
  }

  /** 机器人投票：在合法目标里随机取一个，取不到就弃票。 */
  private pickBotVoteTarget(
    room: RoomRecord,
    round: GameRound,
    botId: string,
    tieBreak: boolean,
  ): string {
    const candidates = tieBreak
      ? (round.tieBreak?.candidateIds ?? []).filter((id) => round.assignments[id]?.alive)
      : this.getAliveAssignedPlayerIds(room).filter((id) => id !== botId);

    if (candidates.length === 0) {
      return ABSTAIN_TARGET_ID;
    }

    return candidates[this.random.nextInt(candidates.length)] ?? ABSTAIN_TARGET_ID;
  }

  /** 机器人卧底的夜晚目标：随机一个非自己的存活玩家。 */
  private pickBotNightTarget(room: RoomRecord, botId: string) {
    const candidates = this.getAliveAssignedPlayerIds(room).filter((id) => id !== botId);

    if (candidates.length === 0) {
      return undefined;
    }

    return candidates[this.random.nextInt(candidates.length)];
  }

  private async log(entry: LogEntry) {
    await this.options.eventLogger.write(entry);
  }
}
