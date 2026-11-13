import { ConnectionRegistry } from "./ConnectionRegistry";
import { requireCEEClientAdmission } from "./CEEClientAdmission";
import { ADMIN_CLOSE_MESSAGE, ADMIN_KICK_MESSAGE, type AdminRoomView } from "../domain/AdminRoom";
import { AppError } from "../domain/Errors";
import { NOOP_GAME_RECORDER, type GameRecorder } from "../domain/GameRecord";
import { TEST_ROOMS_DISABLED, type TestRoomPolicy } from "../domain/TestRooms";
import {
  type CEEPlayerRecord,
  type CEERoom,
  type CEERound,
  type CEEUnit,
} from "../domain/CEEModel";
import type { SnapshottedRoom } from "../shared/RoomSnapshot";
import {
  advanceCEERound,
  getCEEUnit,
  surrenderCEE,
  tickCEERound,
  unitHasActor,
} from "../domain/CEERound";
import { tabSeatId } from "./TabSeat";
import { ensureRoomId, safeEqualToken } from "../domain/Rules";
import {
  createDefaultCEESettings,
  isCEEAntiCheatRoom,
  SERVER_SHUTDOWN_MESSAGE,
  type CEEPayload,
  type CEECharacterView,
  type CEERoomEnterResult,
  type CEESettings,
  type ConnectionRecord,
} from "../shared/Index";
import type { EventLogger } from "../infrastructure/EventLogger";
import { describeError } from "../infrastructure/Sentry";
import { createEvent } from "../transport/Packets";
import {
  NOOP_ANTI_CHEAT_REVIEW_QUEUE,
  ceeAntiCheatReviews,
  type CEEGuessSignal,
  type CEEAntiCheatReviewQueue,
} from "./CEEAntiCheatSignals";
import { ceePrivateState, ceeSnapshot, ceeRoomSummary } from "./CEEViews";
import { RoomIdReservations } from "./room/RoomIdReservations";
import { RoomPasswordGate } from "./room/RoomPasswordGate";
import { RoomTimers, type TimerSeam } from "./room/RoomTimers";
import type { RoomShape } from "./room/RoomCore";
import { reassignHost, resolveHostGrace, transferHost as handOverHost } from "./room/HostPolicy";
import { expiredOfflineSeats, forEachRoomIsolated, judgeReclaim } from "./room/RoomJanitor";
import { publishRoomState } from "./room/RoomPublisher";
import { adminRoomView, countOnline, requireAdminRoom } from "./room/RoomSummaries";
import { acceptChatText, appendChat, systemMessage } from "./room/ChatLog";
import {
  adoptRoomCore,
  exportRoomJson,
  hasSnapshotShape,
  restoreRooms,
  shiftDeadline,
} from "./room/RoomSnapshotCodec";
import {
  assertAgentAdmission,
  assertSeatResumable,
  assertTabAgentsAllowed,
  bindSeat,
  dissolveRoom,
  findSeat,
  markSeatOffline,
  roomsOfTab,
} from "./room/SeatBinding";

/**
 * 口令规范化只取首尾空白：摘要绑定规范化后的值，建房、改设置与入房必须同一口径。
 * TODO(行为统一)：卧底用 `normalizeWord`，两种口径算出的摘要互不相认，统一前各款保留现值。
 */
const normalizePassword = (value: string): string => value.trim();
/** 空消息的错误码：三款各不相同，增强房保持现值。TODO(行为统一) */
const EMPTY_CHAT_ERROR = { code: "EMPTY_MESSAGE", message: "消息不能为空" };
/** 系统消息的发送者占位：增强房是两个空串，客户端按空串识别。TODO(行为统一) */
const CEE_SYSTEM_SENDER = { playerId: "", playerName: "" };
/** 反作弊房里旁观请求的等待上限：超时自动拒绝，房主挂机不会让请求永久悬空。 */
export const CEE_SPECTATE_APPROVAL_TIMEOUT_MS = 120_000;
/** 一间房最多挂多少个待批准请求：防止刷请求骚扰房主。 */
export const CEE_SPECTATE_QUEUE_MAX = 8;

/** 内核认识增强房房间与座位的方式：容器是 Map，准入字段在房间层与设置里，事件名带 cee 前缀。 */
const CEE_ROOM_SHAPE: RoomShape<CEERoom, CEEPlayerRecord> = {
  game: "cee",
  seats: (room) => room.players.values(),
  seat: (room, seatId) => room.players.get(seatId),
  addSeat: (room, seat) => {
    room.players.set(seat.id, seat);
  },
  dropSeat: (room, seatId) => {
    room.players.delete(seatId);
  },
  admission: (room) => ({
    visibility: room.visibility,
    allowSpectators: room.allowSpectators,
    allowAgents: room.settings.allowAgents === true,
  }),
  events: {
    snapshot: "cee.room.snapshot",
    privateState: "cee.game.privateState",
    closed: "cee.room.closed",
    sessionReplaced: "session.replaced",
  },
  // TODO(行为统一)：另两款下发 `{ roomId }` 与 `session_replaced`，增强房保持现值。
  sessionReplacedPayload: () => ({ reason: "此身份已在另一连接恢复" }),
  sessionReplacedCloseReason: "session replaced",
};

export class CEERooms {
  readonly connections = new ConnectionRegistry();
  readonly rooms = new Map<string, CEERoom>();
  private readonly seatContext = {
    shape: CEE_ROOM_SHAPE,
    connections: this.connections,
    now: () => this.now(),
  };
  private readonly tabContext = {
    shape: CEE_ROOM_SHAPE,
    connections: this.connections,
    rooms: this.rooms,
  };
  onChange?: () => void;
  /** 每房一个「截止」定时器：关房由内核一并清掉，服务关闭时清全部。 */
  readonly timers: RoomTimers;
  readonly testRooms: TestRoomPolicy;
  private readonly logger?: EventLogger;
  /** 建房期间的房号占用：占号与「房间可见」分开，算摘要的窗口里房间表里没有这间房。 */
  private readonly reservations = new RoomIdReservations();
  /**
   * 私密房带锁出现在大厅，房间号又只有 9000 个，密码尝试必须封顶：
   * 口令门在校验之前计数，超限后正确密码同样被拒。
   */
  private readonly passwords = new RoomPasswordGate({
    now: () => this.now(),
    normalize: normalizePassword,
    missingOnCreate: { code: "PASSWORD_REQUIRED", message: "私密房间需要密码" },
    missingOnJoin: { code: "PASSWORD_REQUIRED", message: "该房间需要密码" },
  });
  /** 已交给对局记录的结算摘要：结算后的多次发布只记一次。 */
  private readonly recordedSummaries = new WeakSet<object>();
  /**
   * 本回合每条猜测的服务端可观测切片（`guessId → 信号`）。
   * 不进协议类型：反作弊特征只落库与进复核队列，绝不下发给客户端。
   */
  private readonly guessSignals = new Map<string, Map<string, CEEGuessSignal>>();
  /** `isRoomIdReserved` 由统一房号目录提供：该号已分配给原版房时增强房不能占用。 */
  constructor(
    readonly now: () => number,
    private readonly isRoomIdReserved: (roomId: string) => boolean = () => false,
    private readonly gameRecorder: GameRecorder = NOOP_GAME_RECORDER,
    private readonly reviewQueue: CEEAntiCheatReviewQueue = NOOP_ANTI_CHEAT_REVIEW_QUEUE,
    deps: {
      /** 测试房特权（大厅隐藏、单人开局）的唯一判定来源；缺省关闭。 */
      testRooms?: TestRoomPolicy;
      /** 巡检、快照恢复与定时回调的失败出口：一间坏房只记一条日志，不连累其余房间。 */
      logger?: EventLogger;
      /** 定时器接缝：测试注入假时钟，缺省真实定时器（不拖住进程退出）。 */
      setTimer?: TimerSeam;
    } = {}
  ) {
    this.testRooms = deps.testRooms ?? TEST_ROOMS_DISABLED;
    this.logger = deps.logger;
    this.timers = new RoomTimers({
      onError: (roomId, name, error) =>
        this.logger?.warn("增强房定时回调失败", { roomId, name, ...describeError(error) }),
      setTimer: deps.setTimer,
    });
  }
  /** 房号是否已被增强房占用：含建房途中尚未登记的房间，统一房号目录据此避让。 */
  isRoomIdTaken(roomId: string): boolean {
    return this.rooms.has(roomId) || this.reservations.has(roomId);
  }
  /** 提交猜测时由服务层登记：那里才拿得到连接（平台类型与检索台账）。 */
  noteGuessSignal(roomId: string, signal: CEEGuessSignal): void {
    let held = this.guessSignals.get(roomId);
    if (!held) {
      held = new Map();
      this.guessSignals.set(roomId, held);
    }
    held.set(signal.guessId, signal);
  }
  private recordSettled(room: CEERoom): void {
    const { round, summary } = room;
    if (!round || !summary || this.recordedSummaries.has(summary)) return;
    this.recordedSummaries.add(summary);
    const signals = this.guessSignals.get(room.id) ?? new Map<string, CEEGuessSignal>();
    const nameOf = (playerId: string) => room.players.get(playerId)?.name ?? playerId;
    this.gameRecorder.record({
      game: "cee",
      roomId: room.id,
      roomCreatedAt: room.createdAt,
      roundNumber: room.roundNumber,
      startedAt: round.startedAt,
      endedAt: this.now(),
      players: summary.scores.map((score) => ({
        playerId: score.playerId,
        userId: room.players.get(score.playerId)?.account?.userId ?? null,
        name: score.playerName,
        score: score.score,
      })),
      summary: {
        answer: { id: summary.answer.id, name: summary.answer.name, nameCn: summary.answer.nameCn },
        setter: room.setterPlayerId ? nameOf(room.setterPlayerId) : null,
        winners: summary.winners.map((winner) => ({
          name: nameOf(winner.playerId),
          rank: winner.rank,
          score: winner.score,
        })),
        mode: {
          sync: round.settings.syncMode,
          nonstop: round.settings.nonstopMode,
          answer: round.settings.answerMode,
        },
      },
      timeline: summary.guesses.map((guess) => {
        const signal = signals.get(guess.id);
        return {
          at: guess.createdAt,
          type: "guess",
          name: guess.playerName,
          character: guess.character.nameCn || guess.character.name,
          correct: guess.correct,
          partial: guess.partial,
          ...(signal
            ? {
                attempts: signal.attempts,
                clientType: signal.clientType,
                searchedAt: signal.searchedAt,
                searchMatched: signal.searchMatched,
              }
            : {}),
        };
      }),
    });
    this.collectReviews(room, summary.guesses, signals);
    this.guessSignals.delete(room.id);
  }
  /**
   * 采集覆盖全部增强房对局，判定只发生在反作弊房：普通房的特征不参与打分、不对外呈现，
   * 只作为难度调优与后续建模的语料。条目只进队列，不触发任何自动处置。
   */
  private collectReviews(
    room: CEERoom,
    guesses: { id: string; correct: boolean }[],
    signals: ReadonlyMap<string, CEEGuessSignal>
  ): void {
    if (!isCEEAntiCheatRoom(room.settings) || signals.size === 0) return;
    const ordered = new Map<string, CEEGuessSignal[]>();
    for (const guess of guesses) {
      const signal = signals.get(guess.id);
      if (!signal) continue;
      const list = ordered.get(signal.playerId) ?? [];
      list.push({ ...signal, correct: guess.correct });
      ordered.set(signal.playerId, list);
    }
    const recordedAt = this.now();
    for (const review of ceeAntiCheatReviews(
      { roomId: room.id, roomCreatedAt: room.createdAt, roundNumber: room.roundNumber, recordedAt },
      ordered,
      (playerId) => {
        const player = room.players.get(playerId);
        return { name: player?.name ?? playerId, userId: player?.account?.userId ?? null };
      }
    ))
      this.reviewQueue.add(review);
  }
  getHealthSnapshot() {
    return {
      roomCount: this.rooms.size,
      playerCount: [...this.rooms.values()].reduce((sum, room) => sum + room.players.size, 0),
      onlinePlayerCount: [...this.rooms.values()].reduce(
        (sum, room) => sum + countOnline(room.players.values()),
        0
      ),
      connectionCount: this.connections.stats.totalConnections,
    };
  }
  /** 私密房带锁列出，与其它游戏的大厅口径一致；测试房不进大厅。 */
  listRooms() {
    return [...this.rooms.values()]
      .filter((room) => !this.testRooms.isTestRoom(room.id))
      .map(ceeRoomSummary);
  }
  registerConnection(connection: ConnectionRecord) {
    this.connections.registerConnection(connection);
  }
  unregisterConnection(connectionId: string): void {
    const connection = this.connections.unregisterConnection(connectionId);
    if (!connection?.playerId || !connection.roomId) return;
    const room = this.rooms.get(connection.roomId);
    const player = room?.players.get(connection.playerId);
    if (!room || !player) return;

    if (player.connectionId !== connectionId) return;
    this.markSeatOffline(room, player);
  }
  /** 座位转为离线保留：与网络断线同一套后果，给人类留出用会话凭证重连的时间。调用方先解绑连接。 */
  private markSeatOffline(room: CEERoom, player: CEEPlayerRecord): void {
    markSeatOffline(this.seatContext, room, player, {
      emptyRoomExempt: this.testRooms.isTestRoom(room.id),
    });
    if (room.phase === "answering" && room.setterPlayerId === player.id) this.resetWaiting(room);
    advanceCEERound(room, this.now());
    this.publishRoom(room);
  }
  async createRoom(
    connection: ConnectionRecord,
    payload: CEEPayload<"cee.room.create">
  ): Promise<CEERoomEnterResult> {
    this.ensureFree(connection);
    const id = ensureRoomId(payload.roomId, this.testRooms);
    // 算摘要要让出事件循环：先同步占号，房间构造好后在复核通过的那一刻才登记，
    // 窗口里入房、大厅与巡检都看不到这间还没有摘要的私密房。
    const release = this.reservations.hold(
      id,
      (roomId) => this.rooms.has(roomId) || this.isRoomIdReserved(roomId)
    );
    try {
      const password =
        payload.visibility === "private" ? this.passwords.require(payload.password) : undefined;
      const name = this.name(payload.name);
      const userName = this.name(payload.userName);
      // 反作弊只在这一步落地：先查建房的这条连接够不够格，再把那一位写进初始设置。
      const antiCheat = payload.bakaAntiCheat === true;
      if (antiCheat) this.requireClientAdmission(connection);
      const player = this.player(userName, tabSeatId(connection, "cee", id));
      if (connection.isAgent === true) player.isAgent = true;
      const room: CEERoom = {
        id,
        name,
        visibility: payload.visibility,
        allowSpectators: payload.allowSpectators,
        hostPlayerId: player.id,
        players: new Map([[player.id, player]]),
        settings: {
          ...createDefaultCEESettings(),
          bakaAntiCheat: antiCheat,
          allowAgents: payload.allowAgents === true || connection.agentDriven?.() === true,
        },
        phase: "waiting",
        roundNumber: 0,
        setterPlayerId: null,
        phaseDeadlineAt: null,
        round: null,
        summary: null,
        chat: [],
        spectatorRequests: new Map(),
        createdAt: this.now(),
        lastActivityAt: this.now(),
      };
      if (password) room.passwordHash = await this.passwords.hash(password);
      if (!this.connections.findConnection(connection.id) || connection.roomId)
        throw new AppError("SESSION_INVALID", "连接状态已经变化，请重新加入");
      player.ready = true;
      this.rooms.set(id, room);
      try {
        this.attach(connection, room, player);
        this.system(room, `${player.name} 创建了房间`);
        this.publishRoom(room);
      } catch (error) {
        this.rooms.delete(id);
        throw error;
      }
      return this.entry(room, player);
    } finally {
      release();
    }
  }
  async joinRoom(
    connection: ConnectionRecord,
    roomId: string | undefined,
    payload: CEEPayload<"cee.room.join">
  ): Promise<CEERoomEnterResult> {
    this.ensureFree(connection);
    const room = this.room(roomId);
    this.requireAdmission(connection, room);
    // 同一张标签页再次加入就是回到原座位：已经进过门，不重复核对口令，也不会与自己撞名。
    const seat = findSeat(this.seatContext, room, connection);
    if (seat) return this.resumeSeat(connection, room, seat);
    const name = this.name(payload.userName);
    // 口令门以可见性为准、摘要为空一律不匹配：私密房任何时候都不能无口令进入。
    await this.passwords.verify(room, room.visibility, payload.password, connection.id);
    this.ensureFree(connection);
    if (this.rooms.get(room.id) !== room) throw new AppError("ROOM_NOT_FOUND", "房间已经关闭");
    if (
      [...room.players.values()].some((player) => player.name.toLowerCase() === name.toLowerCase())
    )
      throw new AppError("NAME_TAKEN", "房间中已有同名玩家");
    if (room.phase !== "waiting" && !room.allowSpectators)
      throw new AppError("SPECTATING_DISABLED", "该房间不允许中途加入");
    const player = this.player(name, tabSeatId(connection, "cee", room.id));
    if (connection.isAgent === true) player.isAgent = true;
    if (room.phase !== "waiting") player.status = "observing";
    room.players.set(player.id, player);
    this.attach(connection, room, player);
    this.system(room, `${name} 加入了房间`);
    this.publishRoom(room);
    return this.entry(room, player);
  }
  reconnectRoom(
    connection: ConnectionRecord,
    payload: CEEPayload<"cee.room.reconnect">
  ): CEERoomEnterResult {
    this.ensureFree(connection);
    const room = this.room(payload.roomId);
    this.requireAdmission(connection, room);

    const player = findSeat(this.seatContext, room, connection, payload.sessionToken);
    if (!player) throw new AppError("SESSION_NOT_FOUND", "会话凭证无效或座位已不存在");

    return this.resumeSeat(connection, room, player);
  }

  /** 把连接接回既有席位：重连与同标签页再次加入共用，准入判定只有这一份。 */
  private resumeSeat(
    connection: ConnectionRecord,
    room: CEERoom,
    player: CEEPlayerRecord
  ): CEERoomEnterResult {
    assertSeatResumable(player, connection);
    this.attach(connection, room, player);
    const unit = getCEEUnit(room, player);
    if (
      room.phase === "guessing" &&
      unit &&
      !unit.ended &&
      !unit.completed &&
      room.settings.timeLimit &&
      unit.deadlineAt === null
    )
      unit.deadlineAt = this.now() + room.settings.timeLimit * 1000;
    this.publishRoom(room);
    return this.entry(room, player);
  }
  authenticate(
    connection: ConnectionRecord,
    token?: string,
    expectedRoomId?: string
  ): { room: CEERoom; player: CEEPlayerRecord } {
    const room = this.room(connection.roomId);
    const player = connection.playerId ? room.players.get(connection.playerId) : undefined;
    if (!player || !token) throw new AppError("SESSION_INVALID", "请重新加入房间");
    if (!safeEqualToken(player.sessionToken, token) || player.connectionId !== connection.id)
      throw new AppError("SESSION_INVALID", "请重新加入房间");
    if (expectedRoomId && expectedRoomId !== room.id)
      throw new AppError("ROOM_MISMATCH", "指令房间与当前会话不一致");
    room.lastActivityAt = this.now();
    return { room, player };
  }

  requireHost(room: CEERoom, player: CEEPlayerRecord): void {
    if (player.id !== room.hostPlayerId) throw new AppError("FORBIDDEN", "只有房主可以执行该操作");
  }
  requireWaiting(room: CEERoom): void {
    if (room.phase !== "waiting") throw new AppError("INVALID_PHASE", "请在等待阶段修改");
  }
  /**
   * 反作弊房的准入：只放持有客户端通道证明且已登录的连接，浏览器与自写客户端直接拒。
   * 开关为假的房间一行都不执行——普通房间的连接路径与以往完全一致。
   */
  requireAdmission(connection: ConnectionRecord, room: CEERoom): void {
    assertAgentAdmission(connection, CEE_ROOM_SHAPE.admission(room));
    if (isCEEAntiCheatRoom(room.settings)) this.requireClientAdmission(connection);
  }
  /**
   * 连接级反作弊准入：建房与进房共用同一条判据。
   * 建房时查的是「建房的这条连接」自己——房间里还没有别人，不存在要清场才能开启的顾虑。
   */
  requireClientAdmission(connection: ConnectionRecord): void {
    requireCEEClientAdmission(connection, "antiCheatRoom");
  }
  /**
   * 应用房主提交的玩法设置。反作弊那一位**不跟随入参**：它由建房那一刻决定，之后锁死。
   * 这里是覆盖而不是报错，因为预设、导入的配置文件与「沿用上次设置」都可能捎带一个不同的值，
   * 报错会让房主整包设置都存不下去，而那些字段本身没问题。
   */
  applySettings(room: CEERoom, next: CEESettings): void {
    room.settings = {
      ...structuredClone(next),
      bakaAntiCheat: isCEEAntiCheatRoom(room.settings),
    };
  }
  /**
   * 旁观切换。反作弊房里改为登记请求等房主批准，返回 `true` 表示进入待批准态；
   * 其它房间沿用旧口径直接生效。
   */
  requestSpectate(room: CEERoom, player: CEEPlayerRecord, spectator: boolean): boolean {
    if (!spectator) {
      room.spectatorRequests.delete(player.id);
      player.membership = "active";
      player.ready = false;
      return false;
    }
    if (!room.allowSpectators) throw new AppError("SPECTATING_DISABLED", "该房间不允许观战");
    if (!isCEEAntiCheatRoom(room.settings)) {
      player.membership = "spectator";
      player.ready = false;
      return false;
    }
    // 旁观本身要登录：游客身份没有可追溯性，而旁观能看到出题人视角与答案。
    if (!player.account) throw new AppError("LOGIN_REQUIRED", "该房间要求全部成员已登录");
    if (player.membership === "spectator") return false;
    if (
      !room.spectatorRequests.has(player.id) &&
      room.spectatorRequests.size >= CEE_SPECTATE_QUEUE_MAX
    )
      throw new AppError("SPECTATE_QUEUE_FULL", "待房主批准的旁观请求已满");
    room.spectatorRequests.set(player.id, this.now());
    player.membership = "pendingSpectator";
    player.ready = false;
    return true;
  }
  /** 房主处理旁观请求。拒绝立即退回参与态，不等 120 秒超时；结果单独回给请求方以便提示。 */
  approveSpectate(room: CEERoom, actor: CEEPlayerRecord, id: string, approved: boolean): void {
    this.requireHost(room, actor);
    if (!isCEEAntiCheatRoom(room.settings))
      throw new AppError("SPECTATE_NOT_PENDING", "该房间不需要批准旁观");
    if (!room.spectatorRequests.has(id))
      throw new AppError("SPECTATE_NOT_PENDING", "该旁观请求已经处理");
    const player = this.member(room, id);
    room.spectatorRequests.delete(id);
    player.membership = approved ? "spectator" : "active";
    const connection = player.connectionId
      ? this.connections.findConnection(player.connectionId)
      : undefined;
    connection?.send(createEvent("cee.player.spectateResult", { approved }));
  }
  /** 先解绑再移除：最后一人离开时房间随之关闭，离开者自己不该再收到关闭通知（与另外两个游戏一致）。 */
  leaveRoom(connection: ConnectionRecord, room: CEERoom, player: CEEPlayerRecord): void {
    this.connections.detach(connection);
    this.remove(room, player);
  }
  kick(room: CEERoom, actor: CEEPlayerRecord, id: string): void {
    this.requireHost(room, actor);
    if (id === actor.id) throw new AppError("INVALID_PLAYER", "不能移除自己");
    this.kickPlayer(room, this.member(room, id), "你已被房主移出房间");
  }
  adminListRooms(): AdminRoomView[] {
    return [...this.rooms.values()].map((room) =>
      adminRoomView(room, room.players.values(), {
        game: "cee",
        name: room.name,
        phase: room.phase,
        visibility: room.visibility,
        hidden: this.testRooms.isTestRoom(room.id),
        roundNumber: room.roundNumber,
      })
    );
  }
  adminCloseRoom(roomId: string): void {
    this.closeRoom(this.adminRoom(roomId), ADMIN_CLOSE_MESSAGE);
  }
  /** 后台移人可以移走房主：`remove` 会按掉线口径重选房主。 */
  adminKickPlayer(roomId: string, playerId: string): void {
    const room = this.adminRoom(roomId);
    this.kickPlayer(room, this.member(room, playerId), ADMIN_KICK_MESSAGE);
  }
  private adminRoom(roomId: string): CEERoom {
    return requireAdminRoom(this.rooms, roomId);
  }
  private kickPlayer(room: CEERoom, target: CEEPlayerRecord, reason: string): void {
    const connection = target.connectionId
      ? this.connections.findConnection(target.connectionId)
      : undefined;
    if (connection) {
      connection.send(createEvent("cee.player.kicked", { reason }));
      this.connections.detach(connection);
    }
    this.remove(room, target);
  }
  transferHost(room: CEERoom, actor: CEEPlayerRecord, id: string): void {
    this.requireHost(room, actor);
    const target = this.member(room, id);
    handOverHost(room, target, { code: "INVALID_PLAYER", message: "请选择在线参与玩家" });
    // 房主没有准备态：新房主视同已准备，卸任的房主回到未准备，需要自己再点准备。
    actor.ready = false;
    target.ready = true;
    this.system(room, `${target.name} 成为房主`);
  }
  /** 私密即有密码：切到私密时必须带新密码或已有密码；留空保留原密码；公开房清除密码。 */
  async updateSettings(
    room: CEERoom,
    actor: CEEPlayerRecord,
    payload: CEEPayload<"cee.room.update">
  ): Promise<void> {
    this.requireHost(room, actor);
    this.requireWaiting(room);
    const name = this.name(payload.name);
    const password = normalizePassword(payload.password ?? "");
    if (payload.visibility === "private" && !password && !room.passwordHash)
      throw new AppError("PASSWORD_REQUIRED", "私密房间需要密码");
    const passwordHash =
      payload.visibility === "public"
        ? undefined
        : password
          ? await this.passwords.hash(password)
          : room.passwordHash;
    if (this.rooms.get(room.id) !== room) throw new AppError("ROOM_NOT_FOUND", "房间已经关闭");
    this.requireHost(room, actor);
    this.requireWaiting(room);
    room.name = name;
    room.visibility = payload.visibility;
    room.allowSpectators = payload.allowSpectators;
    if (passwordHash) room.passwordHash = passwordHash;
    else delete room.passwordHash;
  }
  member(room: CEERoom, id: string): CEEPlayerRecord {
    const player = room.players.get(id);
    if (!player) throw new AppError("PLAYER_NOT_FOUND", "玩家不在房间中");
    return player;
  }
  sendChat(room: CEERoom, player: CEEPlayerRecord, rawText: string): void {
    // 与另两款同一口径：剔除控制字符并折叠空白，只剩空白或不可见字符的消息按空消息拒绝。
    const text = acceptChatText(rawText, { maxLength: 500, emptyError: EMPTY_CHAT_ERROR });
    appendChat(room, {
      id: crypto.randomUUID(),
      playerId: player.id,
      playerName: player.name,
      text,
      createdAt: this.now(),
      system: false,
    });
  }
  resetWaiting(room: CEERoom): void {
    room.phase = "waiting";
    room.setterPlayerId = null;
    room.phaseDeadlineAt = null;
    room.round = null;
    room.summary = null;
    delete room.preparationId;
    for (const player of room.players.values()) {
      player.ready = player.id === room.hostPlayerId;
      player.status = "waiting";
      player.attempts = 0;
      player.marks = "";
      player.syncCompleted = false;
    }
  }
  publishRoom(room: CEERoom): void {
    if (!this.rooms.has(room.id)) return;
    // 结算散落在领域函数的多条路径里，但都以一次发布收尾：在这里统一交对局记录。
    if (room.phase === "settled") this.recordSettled(room);
    this.fanOutRoom(room, "state");
    this.onChange?.();
  }
  publishRoomCalibration(room: CEERoom): void {
    this.fanOutRoom(room, "calibration");
  }
  /**
   * 快照与私有态扇出：正常发布与校准共用同一份帧来源，公共快照每次发布只构造一次。
   * 只给在座的连接发；私有态按连接裁剪，同一条猜测在不同成员眼里遮蔽不同，不能合并成共享帧。
   */
  private fanOutRoom(room: CEERoom, mode: "state" | "calibration"): void {
    const snapshot = this.snapshotOf(room);
    publishRoomState(
      this.connections.getRoomConnections(room.id),
      (connection) => (connection.playerId ? room.players.get(connection.playerId) : undefined),
      {
        snapshotEvent: CEE_ROOM_SHAPE.events.snapshot,
        privateEvent: CEE_ROOM_SHAPE.events.privateState,
        snapshotFor: (seat) => (seat ? snapshot : undefined),
        privateFor: (seat) => ceePrivateState(room, seat, this.testRooms),
      },
      mode
    );
  }

  /**
   * 导出全部房间以供停机保存。
   *
   * CEE 的房间与回合里散着六处 `Map`（players / spectatorRequests / units / characters /
   * tagOwners / pendingTagOwners），`JSON.stringify` 会把它们统统写成 `{}` —— 直接序列化
   * 得到的是「房间还在、座位和进度全空」的空壳。所以这里逐处摊平成普通对象。
   */
  exportSnapshots(): SnapshottedRoom[] {
    return [...this.rooms.values()].map((room) => exportRoomJson(flattenRoom(room)));
  }

  /**
   * 从快照恢复房间，返回真正恢复的房间数。
   *
   * 时间字段分两类：截止时刻按停机时长后移（停机期间没人能操作），
   * 而空房、离线、空闲三类计时衡量的是「人离开多久」，从恢复时刻重新起算。
   * 单间恢复失败只丢这一间。
   */
  restoreSnapshots(rooms: readonly SnapshottedRoom[], savedAt: number): number {
    return restoreRooms(
      this.rooms,
      rooms,
      { savedAt, now: this.now() },
      {
        adopt: expandRoom,
        onError: (raw, error) =>
          this.logger?.warn("增强房快照恢复失败，已丢弃该房间", {
            roomId: raw?.id,
            ...describeError(error),
          }),
      }
    );
  }

  /** 逐房巡检：一间房的坏状态只记日志，其余房间的回收与截止推进照常进行。 */
  housekeeping(): void {
    const now = this.now();
    void forEachRoomIsolated(
      this.rooms,
      (room) => this.sweepRoom(room, now),
      (room, error) =>
        this.logger?.warn("增强房巡检失败，已跳过该房间", {
          roomId: room.id,
          ...describeError(error),
        })
    );
  }
  /**
   * 单间房的巡检：先推进回合计时，再判回收，之后才做离线清理、房主改选与截止收口。
   * 测试房只豁免空房回收，仍受闲置超时约束；空房宽限内照常巡检（没有连接，发布不会送出任何帧）。
   */
  private sweepRoom(room: CEERoom, now: number): void {
    if (tickCEERound(room, this.now())) this.publishRoom(room);
    const verdict = judgeReclaim(room, countOnline(room.players.values()), now, {
      emptyRoomExempt: this.testRooms.isTestRoom(room.id),
    });
    if (verdict === "close-empty" || verdict === "close-idle") {
      this.closeRoom(room, "房间长时间无人活动，已关闭");
      return;
    }
    let changed = false;
    if (this.sweepOfflinePlayers(room, now)) changed = true;
    const hostChange = resolveHostGrace(room, room.players.values(), now);
    if (hostChange.changed) {
      this.markHostReady(room);
      changed = true;
    }
    if (room.phaseDeadlineAt !== null && now >= room.phaseDeadlineAt) {
      this.system(room, "出题等待超时，已返回准备阶段");
      this.resetWaiting(room);
      changed = true;
    }
    // 旁观请求的兜底收口：超时自动拒绝，玩家已离开的条目也要从队列里摘掉。
    if (this.expireSpectateRequests(room, now)) changed = true;
    if (changed) this.publishRoom(room);
    else this.publishRoomCalibration(room);
  }
  /** 离线超过保留时长的真人座位清出名册；0 分旁观者的保留期更短（由内核判定）。 */
  private sweepOfflinePlayers(room: CEERoom, now: number): boolean {
    const expired = expiredOfflineSeats(room, room.players.values(), now);
    for (const player of expired) this.remove(room, player);
    return expired.length > 0;
  }
  private expireSpectateRequests(room: CEERoom, now: number): boolean {
    if (room.spectatorRequests.size === 0) return false;
    let changed = false;
    for (const [playerId, requestedAt] of room.spectatorRequests)
      if (now - requestedAt >= CEE_SPECTATE_APPROVAL_TIMEOUT_MS || !room.players.has(playerId)) {
        room.spectatorRequests.delete(playerId);
        const player = room.players.get(playerId);
        if (player?.membership === "pendingSpectator") player.membership = "active";
        changed = true;
      }
    return changed;
  }
  notifyShutdown() {
    this.connections.broadcastToAll(
      createEvent("server.shutdown", { message: SERVER_SHUTDOWN_MESSAGE })
    );
  }
  private room(id: string | undefined): CEERoom {
    const room = id ? this.rooms.get(ensureRoomId(id, this.testRooms)) : undefined;
    if (!room) throw new AppError("ROOM_NOT_FOUND", "房间不存在或已关闭");
    return room;
  }
  private name(value: string): string {
    const result = value.trim();
    if (!result) throw new AppError("INVALID_NAME", "名称不能为空");
    return result.slice(0, 32);
  }
  private ensureFree(connection: ConnectionRecord) {
    if (this.connections.findConnection(connection.id) !== connection)
      throw new AppError("SESSION_INVALID", "连接已经断开，请重新加入");
    if (connection.roomId) throw new AppError("ALREADY_IN_ROOM", "请先离开当前房间");
  }
  private player(name: string, seatId?: string): CEEPlayerRecord {
    return {
      id: seatId ?? `cee_player_${crypto.randomUUID()}`,
      sessionToken: crypto.randomUUID(),
      name,
      online: true,
      ready: false,
      team: null,
      membership: "active",
      score: 0,
      status: "waiting",
      attempts: 0,
      marks: "",
      syncCompleted: false,
      joinedAt: this.now(),
      lastSeenAt: this.now(),
    };
  }
  /**
   * 把连接绑到座位：顶号、标在线与房主接任都由内核完成。
   * 房主没有准备态，所以新当选的房主（不一定是回来的这个人）要同步置为已准备。
   */
  private attach(connection: ConnectionRecord, room: CEERoom, player: CEEPlayerRecord): void {
    const previousHostId = room.hostPlayerId;
    bindSeat(this.seatContext, room, player, connection);
    connection.lobbySubscribed = false;
    room.lastActivityAt = this.now();
    if (room.hostPlayerId !== previousHostId) this.markHostReady(room);
  }
  private markHostReady(room: CEERoom): void {
    const host = room.players.get(room.hostPlayerId);
    if (host) host.ready = true;
  }
  /** 公开快照：座位是否被 Agent 操作看连接所在的标签页，同房玩家据此看到 MCP 徽标。 */
  private snapshotOf(room: CEERoom) {
    return ceeSnapshot(room, (playerId) =>
      this.connections.isAgentDriven(room.players.get(playerId)?.connectionId)
    );
  }
  /** 这张标签页要交给 Agent：它坐着的房间必须开着 MCP，反作弊房一律不开放。 */
  assertTabAgentsAllowed(tabKey: string): void {
    assertTabAgentsAllowed(this.tabContext, tabKey, (room) => isCEEAntiCheatRoom(room.settings));
  }
  /** 接管开始或结束：同房玩家要立刻看到座位上的 MCP 徽标变化。 */
  publishTabRooms(tabKey: string): void {
    for (const room of roomsOfTab(this.tabContext, tabKey)) this.publishRoom(room);
  }
  private entry(room: CEERoom, player: CEEPlayerRecord): CEERoomEnterResult {
    return {
      roomId: room.id,
      source: "native",
      sessionToken: player.sessionToken,
      snapshot: this.snapshotOf(room),
      privateState: ceePrivateState(room, player, this.testRooms),
    };
  }
  private system(room: CEERoom, text: string) {
    appendChat(
      room,
      systemMessage({
        id: crypto.randomUUID(),
        text,
        createdAt: this.now(),
        sender: CEE_SYSTEM_SENDER,
      })
    );
  }
  private remove(room: CEERoom, player: CEEPlayerRecord): void {
    const unit = getCEEUnit(room, player);
    if (room.phase === "guessing" && unit && !unit.ended && !unitHasActor(room, unit, player.id))
      surrenderCEE(room, player, this.now());
    player.online = false;
    room.players.delete(player.id);
    if (
      (room.phase === "answering" || room.phase === "preparing") &&
      room.setterPlayerId === player.id
    )
      this.resetWaiting(room);
    if (reassignHost(room, room.players.values())) this.markHostReady(room);
    if (!room.players.size) this.closeRoom(room, "房间已关闭");
    else {
      if (![...room.players.values()].some((member) => member.online))
        room.emptySinceAt = this.now();
      advanceCEERound(room, this.now());
      this.publishRoom(room);
    }
  }
  private closeRoom(room: CEERoom, reason: string): void {
    // 房间销毁 = 这一局结束：收尾对局记录、通知并解绑全部连接，随后清玩法旁表、删房。
    dissolveRoom({ ...this.seatContext, recorder: this.gameRecorder, timers: this.timers }, room, {
      reason,
    });
    // 回合中途关房时结算不会再来清，信号表要随房间一起走。
    this.guessSignals.delete(room.id);
    this.rooms.delete(room.id);
    this.onChange?.();
  }
}

// ==================== 快照序列化 ====================

/** 摊平后的回合：三处 Map / 两处 Set 换成普通对象，其余字段原样。 */
type SerializedCEERound = Omit<
  CEERound,
  "units" | "characters" | "tagOwners" | "pendingTagOwners"
> & {
  units: Record<string, CEEUnit>;
  characters: Record<string, CEECharacterView>;
  tagOwners: Record<string, string[]>;
  pendingTagOwners: Record<string, string[]>;
};

type SerializedCEERoom = Omit<CEERoom, "players" | "spectatorRequests" | "round"> & {
  players: Record<string, CEEPlayerRecord>;
  spectatorRequests: Record<string, number>;
  round: SerializedCEERound | null;
};

const setsToRecord = (map: Map<string, Set<string>>): Record<string, string[]> =>
  Object.fromEntries([...map].map(([key, set]) => [key, [...set]]));

const recordToSets = (record: Record<string, string[]> | undefined): Map<string, Set<string>> =>
  new Map(Object.entries(record ?? {}).map(([key, list]) => [key, new Set(list)]));

/** 摊平成可序列化的形状；落盘出口与「丢弃运行时状态」由内核统一处理。 */
const flattenRoom = (room: CEERoom): SerializedCEERoom => {
  const round: SerializedCEERound | null = room.round
    ? {
        ...room.round,
        units: Object.fromEntries(room.round.units),
        characters: Object.fromEntries(room.round.characters),
        tagOwners: setsToRecord(room.round.tagOwners),
        pendingTagOwners: setsToRecord(room.round.pendingTagOwners),
      }
    : null;
  return {
    ...room,
    players: Object.fromEntries(room.players),
    spectatorRequests: Object.fromEntries(room.spectatorRequests),
    round,
  };
};

/** 还原 Map 与 Set，截止时刻按停机时长后移；公共的「全员离线、计时重起」交给内核。 */
const expandRoom = (raw: SnapshottedRoom, now: number, pausedMs: number): CEERoom | undefined => {
  if (!hasSnapshotShape(raw)) return undefined;
  const saved = raw as unknown as SerializedCEERoom;

  const players = new Map<string, CEEPlayerRecord>();
  for (const [id, player] of Object.entries(saved.players)) players.set(id, { ...player });

  const round: CEERound | null = saved.round
    ? {
        ...saved.round,
        units: new Map(
          Object.entries(saved.round.units ?? {}).map(([id, unit]) => [
            id,
            { ...unit, deadlineAt: shiftDeadline(unit.deadlineAt, pausedMs) },
          ])
        ),
        characters: new Map(
          Object.entries(saved.round.characters ?? {}).map(([id, view]) => [Number(id), view])
        ),
        tagOwners: recordToSets(saved.round.tagOwners),
        pendingTagOwners: recordToSets(saved.round.pendingTagOwners),
      }
    : null;

  const room: CEERoom = {
    ...saved,
    players,
    spectatorRequests: new Map(
      Object.entries(saved.spectatorRequests ?? {}).map(([id, at]) => [id, Number(at)])
    ),
    // 阶段截止时刻暂停：停机期间没人能作答，按原时刻结算等于用故障惩罚玩家。
    phaseDeadlineAt: shiftDeadline(saved.phaseDeadlineAt, pausedMs),
    round,
  };
  adoptRoomCore(room, players.values(), now);
  return room;
};
