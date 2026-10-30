import { ADMIN_CLOSE_REASON, type AdminRoomControl, type AdminRoomView } from "../domain/AdminRoom";
import { AppError } from "../domain/Errors";
import { NOOP_GAME_RECORDER, type GameRecorder } from "../domain/GameRecord";
import {
  type ChatChannel,
  type ChatMessage,
  type ConnectionRecord,
  type WhoIsFakerPhase,
  type GameRound,
  type PhaseTimerState,
  type WhoIsFakerPlayerRecord,
  type WhoIsFakerRole,
  type WhoIsFakerPrivateState,
  type WhoIsFakerRoomRecord,
  type WhoIsFakerRoomSnapshot,
  type WhoIsFakerRoomSummary,
  type RoundWinner,
  type SpeechMode,
  type TieBreakStage,
  ROOM_ID_TEST_MODE,
  SERVER_SHUTDOWN_MESSAGE,
  WHOISFAKER_LOBBY_ROOMS_EVENT,
} from "../shared/Index";
import {
  isAgentFocusKind,
  isAgentFocusPart,
  type AgentFocusEvent,
  type AgentFocusInput,
} from "../shared/AgentActivity";
import type { SnapshottedRoom } from "../shared/RoomSnapshot";
import {
  createDefaultRoleConfig,
  assignRoles,
  ensureRoomId,
  listPlayablePlayerIds,
  normalizeName,
  normalizeWord,
  safeEqualToken,
  isRoleConfigSatisfied,
  validateRoleConfig,
  type RandomSource,
} from "../domain/Rules";
import type { LogEntry } from "../infrastructure/EventLogger";

import { describeError, EventLogger } from "../infrastructure/EventLogger";
import { SlidingWindowRateLimiter } from "../infrastructure/RateLimiter";
import type { WordBankRepository } from "../infrastructure/WordBankRepository";
import { createEvent } from "../transport/Packets";
import type { WhoIsFakerClientMessage } from "../transport/WhoIsFakerProtocol";

import {
  ROOM_IDLE_TIMEOUT_MS,
  QUESTIONER_RECONNECT_TIMEOUT_MS,
  HOST_RECONNECT_TIMEOUT_MS,
  PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS,
  ROOM_EMPTY_GRACE_PERIOD_MS,
  CHAT_LIMIT,
  CHAT_RATE_LIMIT_PER_CONNECTION,
  CHAT_RATE_LIMIT_WINDOW_MS,
  JOIN_PASSWORD_MAX_ATTEMPTS,
  JOIN_PASSWORD_ROOM_MAX_ATTEMPTS,
  JOIN_PASSWORD_WINDOW_MS,
} from "../config/Constants";
import { ConnectionRegistry } from "./ConnectionRegistry";
import { McpSeatRegistry } from "./McpSeatRegistry";
import { LobbyFanout, type LobbyFanoutSchedule } from "./LobbyFanout";
import type { CommandHandler } from "./whoisfaker/CommandHandler";
import { createGameCommandHandler } from "./whoisfaker/GameCommandHandler";
import { createPlayerCommandHandler } from "./whoisfaker/PlayerCommandHandler";
import { createRoomCommandHandler } from "./whoisfaker/RoomCommandHandler";
import { createTestCommandHandler } from "./whoisfaker/TestCommandHandler";
import {
  enterBlankGuess,
  reviewBlankGuess,
  submitBlankGuess,
  updateBlankGuessDraft,
} from "./whoisfaker/BlankGuess";
import type { WhoIsFakerServiceInternals } from "./whoisfaker/ServiceInternals";
import {
  clearPendingDisconnect,
  forceRemovePlayer,
  handlePlayerOffline,
  resolveDisconnect,
  requeuePendingDisconnects,
  shouldAutoCloseWhenEmpty,
  type PlayerOfflineReason,
} from "./whoisfaker/OfflineSettlement";
import {
  clearPhaseTimer,
  finishRound,
  advancePhase,
  handlePhaseTimeout,
  startPhaseTimer,
  stopPhaseTimer,
  restoreInterruptedTimer,
} from "./whoisfaker/PhaseFlow";
import { runBots } from "./whoisfaker/BotActors";
import {
  clampRoleConfig,
  createDescription,
  createDescriptionOrder,
  ensureCanVote,
  getConfigurableParticipantCount,
  getOnlineCount,
  getParticipantCount,
  hasValidQuestionerCandidate,
  isDescriptionComplete,
  normalizeRoomRoleConfig,
  replaceNightAction,
  replaceVote,
} from "./whoisfaker/RoundRules";
import {
  testAddBot,
  testJumpToPhase,
  testRemoveBot,
  testSetMyRole,
} from "./whoisfaker/TestControls";
import {
  attachConnection,
  broadcastRoomEvent,
  buildPrivateState,
  buildRoomSnapshot,
  buildRoomSummary,
  privateStateForConnection,
  publishLobby,
  publishRoom,
  publishRoomCalibration,
} from "./whoisfaker/RoomViews";

export interface WhoIsFakerServiceOptions {
  now?: () => number;
  random?: RandomSource;
  /** 未配置数据库（本地开发、隔离测试）时为空：词对不落库。 */
  wordBankRepository?: WordBankRepository;
  eventLogger: EventLogger;
  /** 未配置数据库时为空：对局记录不落库。 */
  gameRecorder?: GameRecorder;
  /** 大厅合并窗的尾沿调度；缺省挂真实定时器，测试按注入时钟驱动。 */
  lobbyFanoutSchedule?: LobbyFanoutSchedule;
}

/** 反馈标题按结算来源分四类，其余情况按普通投票结果。 */
const feedbackResultLabel = (feedback: WhoIsFakerRoomSnapshot["status"]["feedback"]): string => {
  if (feedback?.kind === "night") return "夜晚结果";
  if (feedback?.kind === "blankGuess") return "白板猜词结果";
  return feedback?.tieBreak ? "平票投票结果" : "投票结果";
};

const questionerDisplayName = (
  snapshot: WhoIsFakerRoomSnapshot,
  room: WhoIsFakerRoomRecord
): string => {
  const questionerId = snapshot.status.questionerPlayerId;
  return (questionerId ? room.players[questionerId]?.name : undefined) ?? "出题人";
};

/** 阶段切换提示文案；未登记的阶段回落到「已进入\<phase\>」。 */
const PHASE_CHANGE_DESCRIPTIONS: Partial<
  Record<WhoIsFakerPhase, (snapshot: WhoIsFakerRoomSnapshot, room: WhoIsFakerRoomRecord) => string>
> = {
  waiting: () => "已返回房间中",
  assigningQuestioner: (_snapshot, room) => `第 ${room.roundCount ?? 1} 轮游戏已开始`,
  wordSubmission: (snapshot, room) => `${questionerDisplayName(snapshot, room)}正在出题`,
  description: (snapshot) =>
    `第 ${snapshot.status.day} 天${snapshot.status.speechMode === "supplement" ? "补充描述" : "描述"}阶段`,
  voting: (snapshot) => `第 ${snapshot.status.day} 天投票阶段`,
  tieBreak: (snapshot) =>
    `第 ${snapshot.status.day} 天${snapshot.status.tieBreakStage === "vote" ? "平票投票" : "平票描述"}阶段`,
  night: (snapshot) => `第 ${snapshot.status.day} 天夜晚阶段`,
  blankGuess: (snapshot) => `第 ${snapshot.status.day} 天白板猜词阶段`,
  feedback: (snapshot) =>
    `第 ${snapshot.status.day} 天${feedbackResultLabel(snapshot.status.feedback)}`,
  gameOver: (snapshot) => `第 ${snapshot.status.day} 天游戏结算阶段`,
};

export class WhoIsFakerService implements AdminRoomControl, WhoIsFakerServiceInternals {
  // ==================== 房间与状态机总控 ====================

  readonly rooms = new Map<string, WhoIsFakerRoomRecord>();
  readonly connectionRegistry: ConnectionRegistry;
  /** MCP 座位配对与控制器：进程内状态，重启即失效。 */
  readonly mcpSeats = new McpSeatRegistry();
  readonly now: () => number;
  readonly random: RandomSource;
  private readonly commandHandlers: CommandHandler[];
  readonly publishedPhaseKeyByRoomId = new Map<string, string>();
  readonly gameOverAdvanceAllowedAtByRoomId = new Map<string, number>();
  /** 对局记录用的开局时间，按回合 ID 索引；结算或删房时移除。 */
  readonly roundStartedAtById = new Map<string, number>();
  readonly phaseTimerTimeoutByRoomId = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * 加入私密房间的密码尝试配额（按「连接 + 房间」计数）。
   * 房间号只有 9000 个且私密房带锁出现在大厅，不设限流就能一直试。
   */
  private readonly joinPasswordLimiter = new SlidingWindowRateLimiter({
    windowMs: JOIN_PASSWORD_WINDOW_MS,
    maxRequests: JOIN_PASSWORD_MAX_ATTEMPTS,
  });
  /**
   * 同一房间的聚合密码尝试配额（只按房间计数）。
   * 每连接各算一份时，开 N 条连接就有 N 份额度，词表爆破在聚合上不受限。
   */
  private readonly joinRoomPasswordLimiter = new SlidingWindowRateLimiter({
    windowMs: JOIN_PASSWORD_WINDOW_MS,
    maxRequests: JOIN_PASSWORD_ROOM_MAX_ATTEMPTS,
  });
  /** 每条聊天都会广播全房快照，限流口径与 SonGuessr 一致。 */
  private readonly chatLimiter = new SlidingWindowRateLimiter({
    windowMs: CHAT_RATE_LIMIT_WINDOW_MS,
    maxRequests: CHAT_RATE_LIMIT_PER_CONNECTION,
  });
  /** 大厅列表的唯一出口：合并窗内的多次变更并为一次全量下发，订阅者单独取当前列表。 */
  readonly lobbyFanout: LobbyFanout;
  private idCounter = 0;

  constructor(readonly options: WhoIsFakerServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.random =
      options.random ??
      ({
        nextInt: (maxExclusive: number) => Math.floor(Math.random() * Math.max(maxExclusive, 1)),
      } satisfies RandomSource);
    this.connectionRegistry = new ConnectionRegistry();
    this.lobbyFanout = new LobbyFanout({
      event: WHOISFAKER_LOBBY_ROOMS_EVENT,
      now: () => this.now(),
      broadcast: (payload) => this.connectionRegistry.broadcastToLobby(payload),
      summaries: () => this.getRoomSummaries(),
      schedule: options.lobbyFanoutSchedule,
    });
    this.commandHandlers = [
      createRoomCommandHandler({
        subscribeRooms: (connection) => {
          connection.lobbySubscribed = true;
          // 只回给这条连接：向全服重发一遍等价于「N 人同时打开大厅 = N×N 帧」，
          // 而新来的玩家要的只是自己那份列表。
          this.lobbyFanout.sendTo(connection);
          return { subscribed: true };
        },
        create: (connection, message) => this.createRoom(connection, message),
        join: (connection, message) => this.joinRoom(connection, message),
        reconnect: (connection, message) => this.reconnectRoom(connection, message),
        leave: (connection) => this.leaveRoom(connection),
        requestSync: (connection) => this.requestSync(connection),
        updateSettings: (connection, payload) => this.updateSettings(connection, payload),
        kick: (connection, playerId) => this.kick(connection, playerId),
        transferHost: (connection, playerId) => this.transferHost(connection, playerId),
        sendChat: (connection, text) => this.sendChat(connection, text),
      }),
      createPlayerCommandHandler({
        now: () => this.now(),
        requireRoomPlayer: (connection) => this.requireRoomPlayer(connection),
        ensureUniqueName: (room, name, exceptPlayerId) =>
          this.ensureUniqueName(room, name, exceptPlayerId),
        isRoundActive: (room) => this.isRoundActive(room),
        normalizeRoleConfig: (room) => normalizeRoomRoleConfig(room),
        touch: (room) => this.touch(room),
        log: (entry) => this.log(entry),
        publishRoom: (room) => this.publishRoom(room),
        publishLobby: () => this.publishLobby(),
      }),
      createGameCommandHandler({
        assignQuestioner: (connection, playerId) => this.assignQuestioner(connection, playerId),
        submitWords: (connection, payload) =>
          this.submitWords(connection, payload.words, payload.blankHint, payload.manualRoles),
        advancePhase: (connection) => this.advancePhase(connection),
        submitDescription: (connection, text) => this.submitDescription(connection, text),
        submitVote: (connection, targetId) => this.submitVote(connection, targetId),
        submitNightAction: (connection, targetId) => this.submitNightAction(connection, targetId),
        submitBlankGuess: (connection, words) => this.submitBlankGuess(connection, words),
        enterBlankGuess: (connection) => this.enterBlankGuess(connection),
        updateBlankGuessDraft: (connection, words) => this.updateBlankGuessDraft(connection, words),
        reviewBlankGuess: (connection, approve) => this.reviewBlankGuess(connection, approve),
        cancelVote: (connection) => this.cancelVote(connection),
        cancelNightAction: (connection) => this.cancelNightAction(connection),
        requestSupplement: (connection, playerIds) => this.requestSupplement(connection, playerIds),
        resolveDisconnect: (connection, payload) =>
          this.resolveDisconnect(connection, payload.playerId, payload.resolution),
        startPhaseTimer: (connection, durationSeconds) =>
          this.startPhaseTimer(connection, durationSeconds),
        stopPhaseTimer: (connection) => this.stopPhaseTimer(connection),
      }),
      createTestCommandHandler({
        jumpToPhase: (connection, phase) => this.testJumpToPhase(connection, phase),
        setMyRole: (connection, role) => this.testSetMyRole(connection, role),
        addBot: (connection, count) => this.testAddBot(connection, count),
        removeBot: (connection, playerId, count) => this.testRemoveBot(connection, playerId, count),
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

    const player = room.players[connection.playerId];
    const controller = this.mcpSeats.controllerFor(room.id, connection.playerId);
    if (controller) {
      if (controller.connectionId !== connection.id) {
        // 人类旁观连接断开：座位仍由 MCP 控制，不触发离线清理。
        this.publishRoom(room);
        return;
      }
      this.mcpSeats.unbind(room.id, connection.playerId);
      const viewer = this.connectionRegistry
        .getRoomConnections(room.id)
        .find((candidate) => candidate.playerId === connection.playerId && !candidate.isAgent);
      if (viewer && player) {
        player.online = true;
        player.connectionId = viewer.id;
        player.lastSeenAt = this.now();
        this.touch(room);
        this.publishRoom(room);
        return;
      }
    } else if (player?.connectionId !== connection.id) {
      // 非座席主连接（例如 MCP 接管期间的人类页面）断开，不影响座位在线态。
      return;
    }

    await this.handlePlayerOffline(room, connection.playerId, "disconnect");
  }

  async execute(connectionId: string, message: WhoIsFakerClientMessage): Promise<unknown> {
    // 所有命令都从这里进入，方便统一做连接上下文解析与后续审计。
    const connection = this.getConnection(connectionId);
    this.assertMcpManualControl(connection, message.type);
    if (message.type === "mcp.focus") return this.handleAgentFocus(connection, message.payload);
    if (message.type === "mcp.claim" || message.type === "mcp.release") {
      return this.handleMcpCommand(connection, message);
    }
    const handler = this.commandHandlers.find((candidate) => candidate.canHandle(message.type));

    if (!handler) {
      throw new AppError("UNSUPPORTED_COMMAND", "暂不支持的命令");
    }

    return handler.execute(connection, message);
  }

  private handleAgentFocus(connection: ConnectionRecord, payload: AgentFocusInput) {
    if (connection.isAgent !== true)
      throw new AppError("AGENT_REQUIRED", "只有 Agent 连接可以上报活动焦点");
    if (!isAgentFocusKind(payload.kind)) throw new AppError("INVALID_FOCUS", "未知的活动焦点");
    if (payload.part !== undefined && !isAgentFocusPart(payload.part))
      throw new AppError("INVALID_FOCUS", "未知的界面区域");
    const event = {
      ...payload,
      kind: payload.kind,
      game: "faker",
      roomId: connection.roomId,
      playerId: connection.playerId,
      at: this.now(),
    } as AgentFocusEvent;
    // 控件焦点与输入进度只给接管座位的人类查看器：同房其他玩家不该看到别人的搜索词与作答。
    if (connection.roomId) {
      for (const viewer of this.connectionRegistry.getRoomConnections(connection.roomId)) {
        if (viewer.playerId === connection.playerId && viewer.isAgent !== true) {
          try {
            viewer.send(createEvent("mcp.focus", event));
          } catch {
            /* 查看器已断开 */
          }
        }
      }
    }
    return { published: true };
  }

  /** 座位被 MCP 接管后，人类连接只能同步与退房，任何手动操作都在服务端拒绝。 */
  private assertMcpManualControl(
    connection: ConnectionRecord,
    type: WhoIsFakerClientMessage["type"]
  ): void {
    if (!connection.roomId || !connection.playerId) return;
    const controller = this.mcpSeats.controllerFor(connection.roomId, connection.playerId);
    if (!controller || controller.connectionId === connection.id) return;
    if (type === "room.leave" || type === "room.requestSync" || type === "mcp.release") return;
    throw new AppError("MCP_CONTROL_ONLY", "本会话已由 MCP 接管，手动操作已锁定");
  }

  private async handleMcpCommand(
    connection: ConnectionRecord,
    message: Extract<WhoIsFakerClientMessage, { type: "mcp.claim" | "mcp.release" }>
  ): Promise<unknown> {
    if (message.type === "mcp.claim")
      return this.claimSeat(connection, message.payload.roomId, message.payload.sessionToken);
    return this.releaseSeat(connection);
  }

  private claimSeat(connection: ConnectionRecord, roomIdValue: string, sessionToken: string) {
    if (connection.isAgent !== true)
      throw new AppError("AGENT_REQUIRED", "只有声明为 Agent 的连接可以认领 MCP 座位");
    if (connection.roomId) throw new AppError("ALREADY_IN_ROOM", "请先离开当前房间再认领座位");
    const room = this.getRoom(ensureRoomId(roomIdValue));
    const player = Object.values(room.players).find((candidate) =>
      safeEqualToken(candidate.sessionToken, sessionToken)
    );
    if (!player) throw new AppError("SESSION_NOT_FOUND", "会话凭证无效或座位已不存在");
    if (room.settings.allowAgents !== true)
      throw new AppError("AGENTS_NOT_ALLOWED", "本房间未开启 MCP 接入");
    if (player.isBot || player.membership === "kicked")
      throw new AppError("MCP_PAIR_FORBIDDEN", "该座位不能交给 MCP");
    if (this.mcpSeats.isControlled(room.id, player.id))
      throw new AppError("MCP_SEAT_TAKEN", "该座位已被另一个 MCP 连接控制");

    const bound = this.mcpSeats.bind(room.id, player.id, connection.id);
    player.online = true;
    player.connectionId = connection.id;
    player.lastSeenAt = this.now();
    room.emptySinceAt = undefined;
    connection.resetStateSync?.();
    connection.lobbySubscribed = false;
    this.connectionRegistry.attach(connection, room.id, player.id);
    this.touch(room);
    this.publishRoom(room);
    this.publishLobby();
    return {
      roomId: room.id,
      playerId: player.id,
      sessionToken: bound.token,
      snapshot: this.buildRoomSnapshot(room),
      privateState: {
        ...this.buildPrivateState(room, player),
        sessionToken: bound.token,
      },
    };
  }

  private async releaseSeat(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    const controller = this.mcpSeats.controllerFor(room.id, player.id);
    if (!controller) return { released: false };
    const controllerConnection = this.connectionRegistry.findConnection(controller.connectionId);
    const viewer = this.connectionRegistry
      .getRoomConnections(room.id)
      .find((candidate) => candidate.playerId === player.id && !candidate.isAgent);
    this.mcpSeats.unbind(room.id, player.id);
    if (controllerConnection) {
      try {
        controllerConnection.send(createEvent("mcp.released", { roomId: room.id }));
      } catch {
        /* 控制器已断线 */
      }
      this.connectionRegistry.detach(controllerConnection);
      setTimeout(() => {
        try {
          controllerConnection.close(4002, "mcp_released");
        } catch {
          /* 已关闭 */
        }
      }, 50);
    }
    if (viewer) {
      player.online = true;
      player.connectionId = viewer.id;
      player.lastSeenAt = this.now();
      this.touch(room);
      this.publishRoom(room);
      this.publishLobby();
      return { released: true };
    }
    await this.handlePlayerOffline(room, player.id, "disconnect");
    this.publishLobby();
    return { released: true };
  }

  async runHousekeeping(): Promise<void> {
    // 统一处理空房清理、闲置超时和出题人掉线超时。
    const currentTime = this.now();

    for (const room of [...this.rooms.values()]) {
      if (await this.closeEmptyRoomIfNeeded(room, currentTime)) continue;
      if (await this.closeIdleRoomIfNeeded(room, currentTime)) continue;
      await this.removeOfflinePlayers(room, currentTime);
      await this.handOverStalledRoles(room, currentTime);
      await this.finishExpiredPhaseTimer(room, currentTime);
      this.publishRoomCalibration(room);
    }
  }

  /** 空房宽限期：整房离线满一个宽限期才真正关闭，否则只记录空房起点。 */
  private async closeEmptyRoomIfNeeded(
    room: WhoIsFakerRoomRecord,
    currentTime: number
  ): Promise<boolean> {
    if (!shouldAutoCloseWhenEmpty(room) || getOnlineCount(room) !== 0) {
      room.emptySinceAt = undefined;
      return false;
    }

    if (room.emptySinceAt === undefined) room.emptySinceAt = currentTime;
    if (currentTime - room.emptySinceAt < ROOM_EMPTY_GRACE_PERIOD_MS) return false;

    await this.closeRoom(room, "empty");
    return true;
  }

  /** 闲置超时：先广播即将关闭，再按 idle_timeout 关闭。测试房间不参与自动清理，方便开发者随时回来继续调试。 */
  private async closeIdleRoomIfNeeded(
    room: WhoIsFakerRoomRecord,
    currentTime: number
  ): Promise<boolean> {
    if (room.id === ROOM_ID_TEST_MODE) return false;
    if (currentTime - room.lastActivityAt < ROOM_IDLE_TIMEOUT_MS) return false;

    this.broadcastRoomEvent(room, "room.expiring", {
      roomId: room.id,
      reason: "idle_timeout",
    });
    await this.closeRoom(room, "idle_timeout");
    return true;
  }

  /** 清理掉线超过3分钟的玩家（3分钟清理超时） */
  private async removeOfflinePlayers(room: WhoIsFakerRoomRecord, currentTime: number) {
    for (const player of Object.values(room.players)) {
      if (
        player.online ||
        player.isBot ||
        currentTime - player.lastSeenAt < PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS
      ) {
        continue;
      }
      if (room.round && room.round.phase !== "gameOver") {
        if (room.round.questionerPlayerId === player.id) {
          await this.finishRound(room, "aborted", "出题人掉线超时，本局已结束");
        } else {
          await this.forceRemovePlayer(room, player.id, "timeout");
        }
      }
      delete room.players[player.id];
      if (room.hostPlayerId === player.id) {
        this.reassignHost(room);
      }
      normalizeRoomRoleConfig(room);
      this.touch(room);
    }
  }

  /** 房主与出题人各自的重连截止时刻到了就交接或结束本局。 */
  private async handOverStalledRoles(room: WhoIsFakerRoomRecord, currentTime: number) {
    if (room.hostReconnectDeadlineAt !== undefined && currentTime >= room.hostReconnectDeadlineAt) {
      await this.transferHostAfterDisconnect(room);
    }

    if (
      room.round?.questionerReconnectDeadlineAt &&
      currentTime >= room.round.questionerReconnectDeadlineAt
    ) {
      await this.finishRound(room, "aborted", "出题人掉线超时，本局已结束");
    }
  }

  private async finishExpiredPhaseTimer(room: WhoIsFakerRoomRecord, currentTime: number) {
    const activeTimer = room.round?.phaseTimer;
    if (!activeTimer || currentTime < activeTimer.endsAt) return;

    await this.handlePhaseTimeout(
      room.id,
      activeTimer.phase,
      activeTimer.speechMode,
      activeTimer.tieBreakStage
    );
  }

  notifyShutdown(): void {
    this.connectionRegistry.broadcastToAll(
      createEvent("server.shutdown", {
        message: SERVER_SHUTDOWN_MESSAGE,
      })
    );
  }

  /**
   * 导出全部房间以供停机保存。
   *
   * 走一次 JSON 往返而不是浅拷贝：房间记录将来若混进函数或句柄，浅拷贝会让序列化在
   * 停机路径上抛错，而那段恰恰最不能失败；往返顺带剔除 undefined，落盘内容与线上视图一致。
   */
  exportSnapshots(): SnapshottedRoom[] {
    const snapshots: SnapshottedRoom[] = [];
    for (const room of this.rooms.values()) {
      try {
        snapshots.push(JSON.parse(JSON.stringify(room)) as SnapshottedRoom);
      } catch (error) {
        this.options.eventLogger?.warn("房间快照导出失败，已跳过该房间", {
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
    const now = this.now();
    // 时钟回拨时按 0 处理：等价于不补偿，好过把截止时间推到更远的未来。
    const pausedMs = Math.max(0, now - savedAt);
    let restored = 0;
    for (const raw of rooms) {
      const room = this.adoptSnapshot(raw, now, pausedMs);
      if (!room || this.rooms.has(room.id)) continue;
      this.rooms.set(room.id, room);
      // 对局记录的开局时间没有进快照：用快照写入时刻当下界，比按恢复时刻起算更接近真实。
      if (room.round) this.roundStartedAtById.set(room.round.id, savedAt);
      this.absorbSnapshotIds(room);
      restored += 1;
    }
    return restored;
  }

  /** 单间恢复：形状校验 + 时间字段重算 + 重建倒计时。任何一步不合预期就整间丢弃。 */
  private adoptSnapshot(
    raw: SnapshottedRoom,
    now: number,
    pausedMs: number
  ): WhoIsFakerRoomRecord | undefined {
    if (!raw || typeof raw.id !== "string" || !raw.id) return undefined;
    if (!raw.players || typeof raw.players !== "object") return undefined;
    const room = raw as unknown as WhoIsFakerRoomRecord;

    for (const player of Object.values(room.players)) {
      // 重启后没有任何连接存活：座位保留，在线态与连接句柄必须归零。
      player.online = false;
      player.connectionId = undefined;
      // lastSeenAt 决定掉线清理的起点。留着停机前的值，重启超过 3 分钟就会
      // 在第一次巡检时把全员踢掉 —— 玩家还没机会重连。
      player.lastSeenAt = now;
    }

    room.emptySinceAt = undefined;
    room.updatedAt = now;
    room.lastActivityAt = now;
    if (room.hostReconnectDeadlineAt !== undefined) {
      room.hostReconnectDeadlineAt = now + HOST_RECONNECT_TIMEOUT_MS;
    }

    const round = room.round;
    if (round) {
      // 倒计时暂停：停机期间没人能发言或投票，直接按原截止时刻结算等于用故障惩罚玩家。
      if (round.phaseTimer) round.phaseTimer.endsAt += pausedMs;
      if (round.questionerReconnectDeadlineAt !== undefined) {
        round.questionerReconnectDeadlineAt = now + QUESTIONER_RECONNECT_TIMEOUT_MS;
      }
    }

    if (round?.phaseTimer) this.rearmSnapshotTimer(room, round.phaseTimer);
    return room;
  }

  private rearmSnapshotTimer(room: WhoIsFakerRoomRecord, timer: PhaseTimerState): void {
    const existing = this.phaseTimerTimeoutByRoomId.get(room.id);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, timer.endsAt - this.now());
    const handle = setTimeout(() => {
      void this.handlePhaseTimeout(room.id, timer.phase, timer.speechMode, timer.tieBreakStage);
    }, delay);
    this.phaseTimerTimeoutByRoomId.set(room.id, handle);
  }

  /**
   * 把 id 计数器抬到快照里已用过的最大序号之上。
   * 计数器每次启动从 0 重来，而恢复回来的房间带着 `player_7`、`round_2` 这类 id，
   * 不抬高就会在同一个房间里生成重复 id：座位串号、对局记录错挂。
   */
  private absorbSnapshotIds(room: WhoIsFakerRoomRecord): void {
    const seen = new Set<object>();
    const visit = (value: unknown): void => {
      if (typeof value === "string") {
        const matched = /^(?:round|description|chat|player|session)_([0-9a-z]+)$/.exec(value);
        if (!matched) return;
        const index = Number.parseInt(matched[1], 36);
        if (Number.isFinite(index) && index > this.idCounter) this.idCounter = index;
        return;
      }
      if (!value || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    };
    visit(room);
  }

  getHealthSnapshot() {
    return {
      roomCount: this.rooms.size,
      connectionCount: this.connectionRegistry.stats.totalConnections,
      onlinePlayerCount: [...this.rooms.values()].reduce(
        (sum, room) => sum + getOnlineCount(room),
        0
      ),
    };
  }

  getRoomSummaries(): WhoIsFakerRoomSummary[] {
    return (
      [...this.rooms.values()]
        // 测试房间不出现在大厅列表，避免污染正式用户视线。
        .filter((room) => room.id !== ROOM_ID_TEST_MODE)
        .map((room) => this.buildRoomSummary(room))
        .sort((left, right) => left.roomId.localeCompare(right.roomId))
    );
  }

  adminListRooms(): AdminRoomView[] {
    return [...this.rooms.values()].map((room) => ({
      game: "faker",
      roomId: room.id,
      name: room.settings.name,
      phase: room.round?.phase ?? "waiting",
      visibility: room.settings.visibility,
      hasPassword: Boolean(room.passwordHash),
      hidden: room.id === ROOM_ID_TEST_MODE,
      roundNumber: room.roundCount ?? 0,
      createdAt: room.createdAt,
      lastActiveAt: room.lastActivityAt,
      players: Object.values(room.players)
        .filter((player) => player.membership !== "kicked")
        .map((player) => ({
          id: player.id,
          name: player.name,
          online: player.online,
          membership: player.membership,
          host: player.id === room.hostPlayerId,
          bot: player.isBot,
          userId: player.account?.userId ?? null,
        })),
    }));
  }

  async adminCloseRoom(roomId: string): Promise<void> {
    await this.closeRoom(this.requireAdminRoom(roomId), ADMIN_CLOSE_REASON);
  }

  async adminKickPlayer(roomId: string, playerId: string): Promise<void> {
    const room = this.requireAdminRoom(roomId);
    const target = room.players[playerId];
    if (!target || target.membership === "kicked")
      throw new AppError("PLAYER_NOT_FOUND", "目标玩家不存在");
    await this.kickPlayer(room, target, "管理员");
  }

  private requireAdminRoom(roomId: string): WhoIsFakerRoomRecord {
    const room = this.rooms.get(roomId);
    if (!room) throw new AppError("ROOM_NOT_FOUND", "房间不存在或已关闭");
    return room;
  }

  private async createRoom(
    connection: ConnectionRecord,
    message: Extract<WhoIsFakerClientMessage, { type: "room.create" }>
  ) {
    // 创建房间时同时把当前连接绑定为房主与首个正式玩家。
    const roomId = ensureRoomId(message.payload.roomId);

    if (this.rooms.has(roomId)) {
      throw new AppError("ROOM_ALREADY_EXISTS", "房间已存在");
    }

    // 私密房口令只存 argon2 摘要：房间记录、快照与日志里都不该出现可读的口令。
    const password =
      message.payload.visibility === "private"
        ? this.requirePassword(message.payload.password)
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
        allowAgents: message.payload.allowAgents === true,
      },
      hostPlayerId: "",
      createdAt: this.now(),
      updatedAt: this.now(),
      lastActivityAt: this.now(),
      players: {},
      chat: [],
    };

    const host = this.createPlayer(message.payload.userName, false, connection.isAgent === true);
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

    // 算摘要要跨一次 await，先占住房号再算，避免并发建房互相覆盖（与 CEE 同一口径）。
    this.rooms.set(room.id, room);
    if (password) {
      try {
        room.passwordHash = await Bun.password.hash(password);
      } catch (error) {
        this.rooms.delete(room.id);
        throw error;
      }
    }

    const previousRoomUpdate = this.attachConnection(room, host, connection);
    this.appendSystemMessage(room, `${host.name} 创建了房间`);
    this.touch(room);

    await previousRoomUpdate;
    await this.log({
      type: "room.created",
      createdAt: this.now(),
      roomId: room.id,
      playerId: host.id,
      payload: {
        visibility: room.settings.visibility,
      },
    });

    this.publishRoom(room);
    this.publishLobby();

    return {
      roomId: room.id,
      playerId: host.id,
      sessionToken: host.sessionToken,
    };
  }

  private async joinRoom(
    connection: ConnectionRecord,
    message: Extract<WhoIsFakerClientMessage, { type: "room.join" }>
  ) {
    // 开局后新连接默认只能作为旁观者进入，避免临时插入正式席位打乱本局。
    const roomId = ensureRoomId(message.roomId ?? "");
    const room = this.getRoom(roomId);

    this.ensureAgentsAllowed(room, connection);
    await this.ensurePasswordMatch(room, message.payload.password, connection);
    // 比对摘要要跨一次 await，期间房间可能已关闭：写入前先确认拿到的还是登记中的那一份。
    if (this.rooms.get(room.id) !== room)
      throw new AppError("ROOM_NOT_FOUND", "房间不存在或已关闭");
    // 同名重入不按「自己让给自己」放行：掉线席位默认保留在名册里等凭票重连，
    // 例外放行会让名册里同时留下两个同名玩家。要走接管就用 room.reconnect 的会话票据。
    this.ensureUniqueName(room, message.payload.userName);

    const joiningAsSpectator = this.isRoundActive(room);

    if (joiningAsSpectator && !room.settings.allowSpectators) {
      throw new AppError("SPECTATOR_DISABLED", "当前房间不允许旁观");
    }

    const player = this.createPlayer(message.payload.userName, false, connection.isAgent === true);
    player.membership = joiningAsSpectator ? "spectator" : "active";

    room.players[player.id] = player;
    const previousRoomUpdate = this.attachConnection(room, player, connection);
    normalizeRoomRoleConfig(room);
    this.appendSystemMessage(room, `${player.name} 加入了房间`);
    this.touch(room);

    await previousRoomUpdate;
    await this.log({
      type: "room.joined",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        membership: player.membership,
      },
    });

    this.publishRoom(room);
    this.publishLobby();

    return {
      roomId: room.id,
      playerId: player.id,
      sessionToken: player.sessionToken,
    };
  }

  private async reconnectRoom(
    connection: ConnectionRecord,
    message: Extract<WhoIsFakerClientMessage, { type: "room.reconnect" }>
  ) {
    // 重连不会创建新玩家，只会把会话重新挂回原连接。
    const room = this.getRoom(ensureRoomId(message.payload.roomId));
    this.ensureAgentsAllowed(room, connection);

    const controller = this.mcpSeats.findByControllerToken(message.payload.sessionToken);
    if (controller && controller.roomId === room.id) {
      if (connection.isAgent !== true)
        throw new AppError("AGENT_REQUIRED", "控制器令牌只能用于 Agent 连接");
      const player = room.players[controller.playerId];
      if (!player) throw new AppError("SESSION_NOT_FOUND", "会话凭证无效或座位已不存在");
      const previous = this.connectionRegistry.findConnection(controller.connectionId);
      if (previous && previous.id !== connection.id) {
        this.connectionRegistry.detach(previous);
        try {
          previous.close(4001, "session_replaced");
        } catch {
          /* 已关闭 */
        }
      }
      const rebound = this.mcpSeats.rebind(controller, connection.id);
      player.online = true;
      player.connectionId = connection.id;
      player.lastSeenAt = this.now();
      room.emptySinceAt = undefined;
      connection.resetStateSync?.();
      this.connectionRegistry.attach(connection, room.id, player.id);
      this.touch(room);
      this.publishRoom(room);
      return {
        roomId: room.id,
        playerId: player.id,
        sessionToken: rebound.token,
        snapshot: this.buildRoomSnapshot(room),
        privateState: {
          ...this.buildPrivateState(room, player),
          sessionToken: rebound.token,
        },
      };
    }

    const player = Object.values(room.players).find((item) =>
      safeEqualToken(item.sessionToken, message.payload.sessionToken)
    );

    if (!player) {
      throw new AppError("SESSION_NOT_FOUND", "会话凭证无效或座位已不存在");
    }

    if (player.membership === "kicked") {
      throw new AppError("PLAYER_KICKED", "该玩家已被移出房间");
    }

    if (connection.isAgent === true && player.isAgent !== true) {
      // 人类会话凭证只能走 mcp.claim，不能直接重连顶掉人类页面。
      throw new AppError("AGENT_CLAIM_REQUIRED", "Agent 接手人类座位必须先通过 MCP 认领");
    }

    if (this.mcpSeats.isControlled(room.id, player.id)) {
      if (connection.isAgent === true)
        throw new AppError("MCP_SEAT_TAKEN", "该座位已被另一个 MCP 连接控制");
      // 人类刷新页面：只恢复只读观看，不抢回座位所有权，也不顶掉 MCP 控制器。
      connection.resetStateSync?.();
      this.connectionRegistry.attach(connection, room.id, player.id);
      this.publishRoom(room, connection);
      return {
        roomId: room.id,
        playerId: player.id,
        sessionToken: player.sessionToken,
        snapshot: this.buildRoomSnapshot(room),
        privateState: this.privateStateForConnection(room, player, connection),
      };
    }

    return this.restorePlayerConnection(room, player, connection, {
      appendMessage: `${player.name} 已重新连接`,
    });
  }

  private async leaveRoom(connection: ConnectionRecord) {
    const { room, player } = this.requireRoomPlayer(connection);
    const controller = this.mcpSeats.controllerFor(room.id, player.id);
    if (controller?.connectionId === connection.id) {
      // MCP 控制器离房：座位交还人类——页面还开着就直接接回，否则按断线保留离线席位，
      // 与 mcp.release 同口径，不把人的记录一起删掉。
      this.mcpSeats.unbind(room.id, player.id);
      this.connectionRegistry.detach(connection);
      const viewer = this.connectionRegistry
        .getRoomConnections(room.id)
        .find((candidate) => candidate.playerId === player.id && !candidate.isAgent);
      if (viewer) {
        player.online = true;
        player.connectionId = viewer.id;
        player.lastSeenAt = this.now();
        this.touch(room);
        this.publishRoom(room);
        this.publishLobby();
        return { left: true };
      }
      await this.handlePlayerOffline(room, player.id, "disconnect");
      return { left: true };
    }

    await this.handlePlayerOffline(room, player.id, "leave");

    return { left: true };
  }

  private requestSync(connection: ConnectionRecord) {
    const { room } = this.requireRoomPlayer(connection);
    connection.resetStateSync?.();
    this.publishRoom(room, connection);
    return { synced: true };
  }

  private async updateSettings(
    connection: ConnectionRecord,
    payload: Extract<WhoIsFakerClientMessage, { type: "room.updateSettings" }>["payload"]
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
      room.passwordHash =
        room.settings.visibility === "private"
          ? await Bun.password.hash(this.requirePassword(payload.password))
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

    if (room.settings.visibility === "public") room.passwordHash = undefined;

    if (room.settings.visibility === "private" && !room.passwordHash) {
      throw new AppError("PASSWORD_REQUIRED", "私密房间必须设置密码");
    }

    if (payload.revealRoleOnDeath != null) {
      room.settings.revealRoleOnDeath = payload.revealRoleOnDeath;
    }

    if (payload.spectatorsSeeAnswers != null) {
      room.settings.spectatorsSeeAnswers = payload.spectatorsSeeAnswers;
    }

    if (payload.allowAgents != null) {
      room.settings.allowAgents = payload.allowAgents;
    }

    if (payload.roleConfig) {
      // 人数不够时不再直接拒绝保存，而是静默夹到当前允许的范围；这样房主依然能把
      // 其它设置（房间名、私密、旁观等）改掉。前端通过 roleLimits 给出禁用提示。
      room.settings.roleConfig = clampRoleConfig(
        payload.roleConfig,
        getConfigurableParticipantCount(room)
      );
    } else {
      normalizeRoomRoleConfig(room);
    }

    this.touch(room);

    await this.log({
      type: "room.settings_changed",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: room.settings,
    });

    this.publishRoom(room);
    this.publishLobby();

    return {
      settings: room.settings,
    };
  }

  private async kick(connection: ConnectionRecord, targetPlayerId: string) {
    const { room, player } = this.requireRoomPlayer(connection);
    this.ensureHost(room, player.id);

    if (targetPlayerId === player.id) {
      throw new AppError("INVALID_KICK", "房主不能踢出自己");
    }

    const target = room.players[targetPlayerId];

    if (!target) {
      throw new AppError("PLAYER_NOT_FOUND", "目标玩家不存在");
    }

    await this.kickPlayer(room, target, "房主");
    return { playerId: target.id };
  }

  /** 房主踢人与后台移人共用：出题人被移出时本局中止，其余按强制移除结算。 */
  private async kickPlayer(
    room: WhoIsFakerRoomRecord,
    target: WhoIsFakerPlayerRecord,
    by: "房主" | "管理员"
  ) {
    if (this.isRoundActive(room) && room.round?.questionerPlayerId === target.id) {
      await this.finishRound(room, "aborted", `出题人被${by}移出，本局中止`);
    }

    await this.forceRemovePlayer(room, target.id, `${by}已将其移出房间`);

    this.publishRoom(room);
    this.publishLobby();
    await this.runBots(room);
  }

  private async assignQuestioner(connection: ConnectionRecord, targetPlayerId: string) {
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
    const participantCount = getParticipantCount(room, target.id);

    // 正式玩家担任出题人时若人数不够，自动把卧底数夹到上限（而不是直接拒绝）。
    if (target.membership === "active") {
      room.settings.roleConfig = clampRoleConfig(room.settings.roleConfig, participantCount);
    }

    validateRoleConfig(room.settings.roleConfig, participantCount);

    this.clearPhaseTimer(room);
    round.questionerPlayerId = target.id;
    round.phase = "wordSubmission";
    round.speechMode = undefined;
    this.touch(room);

    await this.log({
      type: "game.questioner_assigned",
      createdAt: this.now(),
      roomId: room.id,
      playerId: target.id,
    });

    this.publishRoom(room);
    await this.runBots(room);

    return { questionerPlayerId: target.id };
  }

  private async submitWords(
    connection: ConnectionRecord,
    words: [string, string],
    blankHint?: string,
    manualRoles?: Record<string, WhoIsFakerRole>
  ) {
    // 提交词语后，真正的身份分配与词语映射都在服务端一次性完成。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);
    this.ensureQuestioner(round, player.id);

    if (round.phase !== "wordSubmission") {
      throw new AppError("INVALID_PHASE", "当前阶段不能提交词语");
    }

    let participantIds = listPlayablePlayerIds(room).filter(
      (item) => item !== round.questionerPlayerId
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
      manualRoles
    );

    this.clearPhaseTimer(room);
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
    round.descriptionOrder = createDescriptionOrder(this, room);
    round.descriptionSubmittedBy = [];
    round.votes = [];
    round.voteHistory = [];
    round.history = [];
    round.tieBreak = undefined;
    round.nightActions = [];
    round.blankGuessContext = undefined;
    this.touch(room);

    // 异步后台保存词库，避免阻塞 WebSocket 主流程
    void this.options.wordBankRepository?.savePair(words).catch((error: unknown) => {
      this.options.eventLogger.error("词库异步保存失败", {
        ...describeError(error),
        roomId: room.id,
        playerId: player.id,
      });
    });

    await this.log({
      type: "game.words_submitted",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
    });

    this.publishRoom(room);
    await this.runBots(room);

    return { phase: round.phase };
  }

  private advancePhase(connection: ConnectionRecord) {
    return advancePhase(this, connection);
  }

  /** PhaseTimer.test.ts 通过内部面直接驱动恢复倒计时，类上保留委托。 */
  private restoreInterruptedTimer(room: WhoIsFakerRoomRecord, remainingMs: number): void {
    restoreInterruptedTimer(this, room, remainingMs);
  }

  private async submitDescription(connection: ConnectionRecord, text: string) {
    // 描述和 PK 补充描述都复用同一份存储结构，只靠 kind 区分。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);
    const normalized = normalizeWord(text);

    if (!normalized) {
      throw new AppError("INVALID_DESCRIPTION", "描述不能为空");
    }

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

    this.touch(room);
    // 补充发言完成会直接切回原阶段，同样要重新检查掉线玩家。
    this.requeuePendingDisconnects(room);
    await this.log({
      type: "game.description_submitted",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
    });
    this.publishRoom(room);
    await this.runBots(room);

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
      createDescription(this, player, text, "supplement", round.descriptionCycle, {
        supplementIndex: supplement.index,
        order: order > 0 ? order : undefined,
      })
    );
    this.completeSupplementIfReady(room);
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
      createDescription(this, player, text, "description", round.descriptionCycle, {
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
      createDescription(this, player, text, "tieBreak", round.descriptionCycle, {
        tieBreakIndex: round.tieBreakCount,
        order: order > 0 ? order : undefined,
      })
    );
  }

  private async cancelVote(connection: ConnectionRecord) {
    // 撤销设计为幂等操作：客户端重试或快速连点时仍会收到最新私有状态。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);
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

    this.touch(room);
    this.publishRoom(room);
    return { cancelled };
  }

  private async cancelNightAction(connection: ConnectionRecord) {
    // 允许已提交夜晚操作的玩家在主持人推进前撤销。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);

    if (round.phase !== "night") {
      throw new AppError("INVALID_PHASE", "当前阶段不能撤销夜晚操作");
    }

    const cancelled = round.nightActions.some((a) => a.actorId === player.id);
    round.nightActions = round.nightActions.filter((a) => a.actorId !== player.id);
    this.touch(room);
    this.publishRoom(room);
    return { cancelled };
  }

  private async requestSupplement(connection: ConnectionRecord, playerIds: string[]) {
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

    this.clearPhaseTimer(room);
    round.supplement = {
      index: maxSuppIdx + 1,
      requestedPlayerIds: [...new Set(playerIds)],
      donePlayers: [],
      resumePhase: round.phase,
    };
    round.phase = "description";
    round.speechMode = "supplement";

    this.touch(room);
    this.requeuePendingDisconnects(room);
    await this.runBots(room);
    this.publishRoom(room);
    return { requested: true };
  }

  completeSupplementIfReady(room: WhoIsFakerRoomRecord): boolean {
    const round = room.round;
    const supplement = round?.supplement;
    if (
      !round ||
      !supplement ||
      supplement.donePlayers.length < supplement.requestedPlayerIds.length
    ) {
      return false;
    }
    round.supplement = undefined;
    if (round.phase === "blankGuess" && round.blankGuessContext?.resumePhase === "description") {
      round.blankGuessContext.resumePhase = supplement.resumePhase;
      // 原补充已完成，其剩余倒计时不能移植到恢复后的投票。
      round.blankGuessContext.interruptedRemainingTimerMs = undefined;
    } else {
      this.clearPhaseTimer(room);
      round.phase = supplement.resumePhase;
      round.speechMode = supplement.resumePhase === "description" ? "normal" : undefined;
    }
    return true;
  }

  private async submitVote(connection: ConnectionRecord, targetId: string) {
    // 第一轮投票与平票第二轮投票复用同一个入口，但资格校验不同。
    const { room, player } = this.requireRoomPlayer(connection);
    const round = this.requireRound(room);

    if (round.phase === "voting") {
      ensureCanVote(this, room, player.id, targetId, false);
      round.votes = replaceVote(round.votes, player.id, targetId);
    } else if (round.phase === "tieBreak" && round.tieBreak?.stage === "vote") {
      ensureCanVote(this, room, player.id, targetId, true);
      round.tieBreak.votes = replaceVote(round.tieBreak.votes, player.id, targetId);
    } else {
      throw new AppError("INVALID_PHASE", "当前阶段不能提交投票");
    }

    this.touch(room);
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
    this.publishRoom(room);
    await this.runBots(room);

    return { submitted: true };
  }

  private async submitNightAction(connection: ConnectionRecord, targetId?: string | null) {
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

    round.nightActions = replaceNightAction(round.nightActions, player.id, {
      actorId: player.id,
      actorRole: state.role,
      targetId: targetId ?? undefined,
    });
    this.touch(room);

    await this.log({
      type: "game.night_action_submitted",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        hasTarget: Boolean(targetId),
      },
    });

    this.publishRoom(room);
    await this.runBots(room);

    return { submitted: true };
  }

  private submitBlankGuess(connection: ConnectionRecord, words: [string, string]) {
    return submitBlankGuess(this, connection, words);
  }

  private enterBlankGuess(connection: ConnectionRecord) {
    return enterBlankGuess(this, connection);
  }

  private updateBlankGuessDraft(connection: ConnectionRecord, words: [string, string]) {
    return updateBlankGuessDraft(this, connection, words);
  }

  private reviewBlankGuess(connection: ConnectionRecord, approve: boolean) {
    return reviewBlankGuess(this, connection, approve);
  }

  private resolveDisconnect(
    connection: ConnectionRecord,
    targetPlayerId: string,
    resolution: "wait" | "eliminate"
  ) {
    return resolveDisconnect(this, connection, targetPlayerId, resolution);
  }

  private startPhaseTimer(connection: ConnectionRecord, durationSeconds: number) {
    return startPhaseTimer(this, connection, durationSeconds);
  }

  private stopPhaseTimer(connection: ConnectionRecord) {
    return stopPhaseTimer(this, connection);
  }

  private clearPhaseTimer(room: WhoIsFakerRoomRecord): void {
    clearPhaseTimer(this, room);
  }

  private handlePhaseTimeout(
    roomId: string,
    expectedPhase: WhoIsFakerPhase,
    expectedSpeechMode?: SpeechMode,
    expectedTieBreakStage?: TieBreakStage
  ) {
    return handlePhaseTimeout(
      this,
      roomId,
      expectedPhase,
      expectedSpeechMode,
      expectedTieBreakStage
    );
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

  private async sendChat(connection: ConnectionRecord, text: string) {
    // 聊天区在任意阶段都开放，所以不受 round.phase 限制。
    const { room, player } = this.requireRoomPlayer(connection);
    if (!this.chatLimiter.allow(connection.id, this.now())) {
      throw new AppError("RATE_LIMITED", "发言过于频繁，请稍后再试");
    }
    const normalized = normalizeWord(text);

    if (!normalized) {
      throw new AppError("INVALID_CHAT", "聊天内容不能为空");
    }

    const { channel, ghostRole } = this.chatChannelOf(room, player);

    const message = this.createChatMessage(
      player.id,
      player.name,
      normalized,
      false,
      channel,
      ghostRole
    );
    room.chat.push(message);
    room.chat = room.chat.slice(-CHAT_LIMIT);
    this.touch(room);

    await this.log({
      type: "chat.sent",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: {
        text: normalized,
        channel,
        ghostRole,
      },
    });

    this.publishRoom(room);
    return { sent: true };
  }

  private async transferHost(connection: ConnectionRecord, targetPlayerId: string) {
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
    this.touch(room);
    this.appendSystemMessage(room, `${player.name} 将房主转移给了 ${target.name}`);

    await this.log({
      type: "room.host_transferred",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
      payload: { nextHostId: target.id },
    });

    this.publishRoom(room);
    this.publishLobby();
    return { hostPlayerId: target.id };
  }

  private testJumpToPhase(connection: ConnectionRecord, target: WhoIsFakerPhase) {
    return testJumpToPhase(this, connection, target);
  }

  private testSetMyRole(connection: ConnectionRecord, role: WhoIsFakerRole) {
    return testSetMyRole(this, connection, role);
  }

  /** 测试房间批量补入机器人的口径见 whoisfaker/TestControls.ts。 */
  private testAddBot(connection: ConnectionRecord, count: number) {
    return testAddBot(this, connection, count);
  }

  /** 测试房间移除机器人走与踢人相同的路径，见 whoisfaker/TestControls.ts。 */
  private testRemoveBot(connection: ConnectionRecord, playerId: string | undefined, count: number) {
    return testRemoveBot(this, connection, playerId, count);
  }

  private finishRound(room: WhoIsFakerRoomRecord, winner: RoundWinner, reason: string) {
    return finishRound(this, room, winner, reason);
  }

  private handlePlayerOffline(
    room: WhoIsFakerRoomRecord,
    playerId: string,
    reason: PlayerOfflineReason
  ) {
    return handlePlayerOffline(this, room, playerId, reason);
  }

  private forceRemovePlayer(room: WhoIsFakerRoomRecord, playerId: string, reason: string) {
    return forceRemovePlayer(this, room, playerId, reason);
  }

  async closeRoom(room: WhoIsFakerRoomRecord, reason: string) {
    this.clearPhaseTimer(room);
    // 房间销毁 = 这一局结束：把聚合后的对局记录收尾到销毁时刻。
    (this.options.gameRecorder ?? NOOP_GAME_RECORDER).finishRoom({
      game: "faker",
      roomId: room.id,
      roomCreatedAt: room.createdAt,
      endedAt: this.now(),
    });
    // closeRoom 负责房间生命周期的最后一步：通知、解绑、删除、记日志。
    for (const connection of this.connectionRegistry.getRoomConnections(room.id)) {
      (connection.sendPacket ?? connection.send)(
        createEvent("room.closed", {
          roomId: room.id,
          reason,
        })
      );
      this.connectionRegistry.detach(connection);
    }

    this.rooms.delete(room.id);
    this.mcpSeats.clearRoom(room.id);
    if (room.round) this.roundStartedAtById.delete(room.round.id);
    this.publishedPhaseKeyByRoomId.delete(room.id);
    this.gameOverAdvanceAllowedAtByRoomId.delete(room.id);
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

  private buildRoomSummary(room: WhoIsFakerRoomRecord): WhoIsFakerRoomSummary {
    return buildRoomSummary(room);
  }

  private buildRoomSnapshot(room: WhoIsFakerRoomRecord): WhoIsFakerRoomSnapshot {
    return buildRoomSnapshot(this, room);
  }

  private buildPrivateState(
    room: WhoIsFakerRoomRecord,
    player: WhoIsFakerPlayerRecord
  ): WhoIsFakerPrivateState {
    return buildPrivateState(this, room, player);
  }

  /** MCP 接管时私有状态的脱敏规则见 whoisfaker/RoomViews.ts。 */
  private privateStateForConnection(
    room: WhoIsFakerRoomRecord,
    player: WhoIsFakerPlayerRecord,
    connection: ConnectionRecord
  ): WhoIsFakerPrivateState {
    return privateStateForConnection(this, room, player, connection);
  }

  private publishRoom(room: WhoIsFakerRoomRecord, targetConnection?: ConnectionRecord) {
    publishRoom(this, room, targetConnection);
  }

  private publishRoomCalibration(room: WhoIsFakerRoomRecord) {
    publishRoomCalibration(this, room);
  }

  private publishLobby() {
    publishLobby(this);
  }

  private broadcastRoomEvent(room: WhoIsFakerRoomRecord, event: string, payload: unknown) {
    broadcastRoomEvent(this, room, event, payload);
  }

  private attachConnection(
    room: WhoIsFakerRoomRecord,
    player: WhoIsFakerPlayerRecord,
    connection: ConnectionRecord
  ) {
    return attachConnection(this, room, player, connection);
  }

  private createChatMessage(
    playerId: string,
    playerName: string,
    text: string,
    system: boolean,
    channel?: ChatChannel,
    ghostRole?: "dead" | "spectator"
  ): ChatMessage {
    return {
      id: this.createId("chat"),
      playerId,
      playerName,
      text,
      createdAt: this.now(),
      system,
      channel,
      ghostRole,
    };
  }

  appendSystemMessage(room: WhoIsFakerRoomRecord, text: string) {
    room.chat.push(this.createChatMessage("system", "系统", text, true, "main"));
    room.chat = room.chat.slice(-CHAT_LIMIT);
  }

  describePhaseChange(snapshot: WhoIsFakerRoomSnapshot, room: WhoIsFakerRoomRecord): string {
    const phase = snapshot.status.phase;
    const describe = PHASE_CHANGE_DESCRIPTIONS[phase];
    return describe ? describe(snapshot, room) : `已进入${phase}`;
  }

  getPhaseNoticeKey(snapshot: WhoIsFakerRoomSnapshot) {
    const { phase, day, speechMode, tieBreakStage, supplementIndex } = snapshot.status;
    return [phase, day, speechMode, tieBreakStage, supplementIndex].join(":");
  }

  private async restorePlayerConnection(
    room: WhoIsFakerRoomRecord,
    player: WhoIsFakerPlayerRecord,
    connection: ConnectionRecord,
    options: {
      appendMessage: string;
    }
  ) {
    const previousRoomUpdate = this.attachConnection(room, player, connection);

    if (room.round) {
      this.clearPendingDisconnect(room.round, player.id);
    }

    if (room.round?.questionerPlayerId === player.id) {
      room.round.questionerReconnectDeadlineAt = undefined;
    }

    if (room.hostPlayerId === player.id) {
      room.hostReconnectDeadlineAt = undefined;
    }

    this.touch(room);
    this.appendSystemMessage(room, options.appendMessage);

    await previousRoomUpdate;
    await this.log({
      type: "room.reconnected",
      createdAt: this.now(),
      roomId: room.id,
      playerId: player.id,
    });

    this.publishRoom(room);
    this.publishLobby();

    return {
      roomId: room.id,
      playerId: player.id,
      sessionToken: player.sessionToken,
    };
  }

  /** 掉线玩家是否阻塞当前阶段、以及重新入队的规则见 whoisfaker/OfflineSettlement.ts。 */
  private requeuePendingDisconnects(room: WhoIsFakerRoomRecord) {
    requeuePendingDisconnects(this, room);
  }

  private clearPendingDisconnect(round: GameRound, playerId: string) {
    clearPendingDisconnect(round, playerId);
  }

  async maybeAbortRoundAfterRosterChange(room: WhoIsFakerRoomRecord) {
    const round = room.round;

    if (!round || round.phase === "gameOver") {
      return;
    }

    if (round.phase === "assigningQuestioner") {
      if (!hasValidQuestionerCandidate(room)) {
        await this.finishRound(room, "aborted", "当前人数不足，系统已取消本局");
      }
      return;
    }

    if (round.phase === "wordSubmission" && round.questionerPlayerId) {
      const satisfied = isRoleConfigSatisfied(
        room.settings.roleConfig,
        getParticipantCount(room, round.questionerPlayerId)
      );
      if (!satisfied) {
        await this.finishRound(room, "aborted", "当前人数不足，系统已取消本局");
      }
    }
  }

  createPlayer(name: string, isBot: boolean, isAgent = false): WhoIsFakerPlayerRecord {
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
      ...(isAgent ? { isAgent: true } : {}),
      online: !isBot,
      joinedAt: this.now(),
      lastSeenAt: this.now(),
    };
  }

  private createSessionToken() {
    return `${this.createId("session")}_${crypto.randomUUID()}`;
  }

  createId(prefix: string) {
    this.idCounter += 1;
    return `${prefix}_${this.idCounter.toString(36)}`;
  }

  touch(room: WhoIsFakerRoomRecord) {
    room.updatedAt = this.now();
    room.lastActivityAt = this.now();
  }

  private getConnection(connectionId: string) {
    return this.connectionRegistry.getConnection(connectionId);
  }

  getConnectionByPlayer(playerId: string) {
    return this.connectionRegistry.findConnectionByPlayerId(playerId);
  }

  private getRoom(roomId: string) {
    const room = this.rooms.get(roomId);

    if (!room) {
      throw new AppError("ROOM_NOT_FOUND", "房间不存在");
    }

    return room;
  }

  requireRound(room: WhoIsFakerRoomRecord) {
    if (!room.round) {
      throw new AppError("ROUND_NOT_STARTED", "当前房间尚未开始游戏");
    }

    return room.round;
  }

  requireRoomPlayer(connection: ConnectionRecord) {
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

  ensureHost(room: WhoIsFakerRoomRecord, playerId: string) {
    if (room.hostPlayerId !== playerId) {
      throw new AppError("FORBIDDEN", "只有房主可以执行该操作");
    }
  }

  private ensureAgentsAllowed(room: WhoIsFakerRoomRecord, connection: ConnectionRecord) {
    if (connection.isAgent === true && room.settings.allowAgents !== true) {
      throw new AppError("AGENTS_NOT_ALLOWED", "房主已禁止 Agent 进入");
    }
  }

  ensureQuestioner(round: GameRound, playerId: string) {
    if (round.questionerPlayerId !== playerId) {
      throw new AppError("FORBIDDEN", "只有出题人可以执行该操作");
    }
  }

  private ensureUniqueName(room: WhoIsFakerRoomRecord, name: string, exceptPlayerId?: string) {
    const normalized = normalizeName(name);

    if (
      Object.values(room.players).some(
        (player) => player.id !== exceptPlayerId && player.name === normalized
      )
    ) {
      throw new AppError("NAME_CONFLICT", "该用户名已在房间中");
    }
  }

  private async ensurePasswordMatch(
    room: WhoIsFakerRoomRecord,
    password: string | null | undefined,
    connection: ConnectionRecord
  ) {
    if (room.settings.visibility !== "private") return;
    // 缺少密码回 PASSWORD_REQUIRED，不消耗尝试次数。
    const normalized = this.requirePassword(password);
    // 先计数再校验：超限后正确密码同样被拒，攻击者无法区分猜中与猜错。
    if (!this.joinPasswordLimiter.allow(`${connection.id}:${room.id}`, this.now())) {
      throw new AppError("TOO_MANY_ATTEMPTS", "密码错误次数过多，请稍后再试");
    }
    // 房间级聚合额度：多开连接各自占一份额度时，爆破速度随连接数线性增长。
    if (!this.joinRoomPasswordLimiter.allow(room.id, this.now())) {
      throw new AppError("TOO_MANY_ATTEMPTS", "密码错误次数过多，请稍后再试");
    }
    // 只按摘要比对：房间记录里没有可读的口令。
    const matched = room.passwordHash
      ? await Bun.password.verify(normalized, room.passwordHash)
      : false;
    if (!matched) {
      throw new AppError("PASSWORD_INCORRECT", "房间密码错误");
    }
  }

  private requirePassword(password?: string | null) {
    const normalized = normalizeWord(password ?? "");

    if (!normalized) {
      throw new AppError("PASSWORD_REQUIRED", "该操作需要有效密码");
    }

    return normalized;
  }

  reassignHost(room: WhoIsFakerRoomRecord) {
    const candidates = Object.values(room.players).filter(
      (player) => player.membership !== "kicked"
    );
    const current = room.hostPlayerId ? room.players[room.hostPlayerId] : undefined;

    // 现任房主仍在且未被踢出 → 保留。
    if (current && current.membership !== "kicked") {
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

  private async transferHostAfterDisconnect(room: WhoIsFakerRoomRecord) {
    const previousHostId = room.hostPlayerId;
    const previousHost = room.players[previousHostId];

    if (!previousHost || previousHost.online || previousHost.membership === "kicked") {
      room.hostReconnectDeadlineAt = undefined;
      return;
    }

    const nextHost = Object.values(room.players)
      .filter((player) => player.membership === "active" && player.online && !player.isBot)
      .sort((left, right) => left.joinedAt - right.joinedAt)[0];

    if (!nextHost) {
      return;
    }

    room.hostReconnectDeadlineAt = undefined;
    room.hostPlayerId = nextHost.id;
    this.touch(room);
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

    this.publishRoom(room);
    this.publishLobby();
  }

  isRoundActive(room: WhoIsFakerRoomRecord) {
    return Boolean(room.round && room.round.phase !== "gameOver");
  }

  /** 机器人补齐提交的判定与顺序见 whoisfaker/BotActors.ts。 */
  private runBots(room: WhoIsFakerRoomRecord) {
    return runBots(this, room);
  }

  async drainPendingWrites(): Promise<void> {
    await this.options.wordBankRepository?.drainWrites();
  }

  async log(entry: LogEntry) {
    await this.options.eventLogger.write(entry);
  }
}
