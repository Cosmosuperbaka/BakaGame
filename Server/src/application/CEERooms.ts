import { ConnectionRegistry } from "./ConnectionRegistry";
import { ADMIN_CLOSE_MESSAGE, ADMIN_KICK_MESSAGE, type AdminRoomView } from "../domain/AdminRoom";
import { AppError } from "../domain/Errors";
import { NOOP_GAME_RECORDER, type GameRecorder } from "../domain/GameRecord";
import {
  type CEEPlayerRecord,
  type CEERoom,
  type CEERound,
  type CEEUnit,
} from "../domain/CEEModel";
import type { SnapshottedRoom } from "../shared/RoomSnapshot";
import { advanceCEERound, getCEEUnit, surrenderCEE } from "../domain/CEERound";
import { ensureRoomId, safeEqualToken } from "../domain/Rules";
import {
  createDefaultCEESettings,
  isCEEAntiCheatRoom,
  ROOM_ID_TEST_MODE,
  SERVER_SHUTDOWN_MESSAGE,
  type CEEPayload,
  type CEECharacterView,
  type CEERoomEnterResult,
  type CEESettings,
  type ConnectionRecord,
} from "../shared/Index";
import {
  CHAT_LIMIT,
  HOST_RECONNECT_TIMEOUT_MS,
  PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS,
  ROOM_EMPTY_GRACE_PERIOD_MS,
  ROOM_IDLE_TIMEOUT_MS,
} from "../config/Constants";
import { SlidingWindowRateLimiter } from "../infrastructure/RateLimiter";
import { createEvent } from "../transport/Packets";
import {
  NOOP_ANTI_CHEAT_REVIEW_QUEUE,
  ceeAntiCheatReviews,
  type CEEGuessSignal,
  type CEEAntiCheatReviewQueue,
} from "./CEEAntiCheatSignals";
import { ceePrivateState, ceeSnapshot, ceeRoomSummary } from "./CEEViews";

/** 同一连接对同一房间每分钟最多尝试的密码次数。 */
export const CEE_JOIN_PASSWORD_MAX_ATTEMPTS = 5;
/** 同一房间每分钟所有连接合计最多尝试的密码次数：只按连接计数时，多开连接就多倍爆破速度。 */
export const CEE_JOIN_PASSWORD_ROOM_MAX_ATTEMPTS = CEE_JOIN_PASSWORD_MAX_ATTEMPTS * 6;
const CEE_JOIN_PASSWORD_WINDOW_MS = 60_000;
/** 反作弊房里旁观请求的等待上限：超时自动拒绝，房主挂机不会让请求永久悬空。 */
export const CEE_SPECTATE_APPROVAL_TIMEOUT_MS = 120_000;
/** 一间房最多挂多少个待批准请求：防止刷请求骚扰房主。 */
export const CEE_SPECTATE_QUEUE_MAX = 8;

export class CEERooms {
  readonly connections = new ConnectionRegistry();
  readonly rooms = new Map<string, CEERoom>();
  onChange?: () => void;
  /**
   * 私密房带锁出现在大厅，房间号又只有 9000 个，密码尝试必须封顶。
   * 在校验密码之前计数：超限后正确密码同样被拒，才能真正挡住穷举。
   */
  private readonly joinPasswordLimiter = new SlidingWindowRateLimiter({
    windowMs: CEE_JOIN_PASSWORD_WINDOW_MS,
    maxRequests: CEE_JOIN_PASSWORD_MAX_ATTEMPTS,
  });
  private readonly joinRoomPasswordLimiter = new SlidingWindowRateLimiter({
    windowMs: CEE_JOIN_PASSWORD_WINDOW_MS,
    maxRequests: CEE_JOIN_PASSWORD_ROOM_MAX_ATTEMPTS,
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
    private readonly reviewQueue: CEEAntiCheatReviewQueue = NOOP_ANTI_CHEAT_REVIEW_QUEUE
  ) {}
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
        (sum, room) => sum + [...room.players.values()].filter((player) => player.online).length,
        0
      ),
      connectionCount: this.connections.stats.totalConnections,
    };
  }
  /** 私密房带锁列出，与其它游戏的大厅口径一致；测试房不进大厅。 */
  listRooms() {
    return [...this.rooms.values()]
      .filter((room) => room.id !== ROOM_ID_TEST_MODE)
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
    if (!room || !player || player.connectionId !== connectionId) return;
    player.online = false;
    player.offlineAt = this.now();
    delete player.connectionId;
    if (room.hostPlayerId === player.id)
      room.hostDeadlineAt = this.now() + HOST_RECONNECT_TIMEOUT_MS;
    if (![...room.players.values()].some((member) => member.online)) room.emptyAt = this.now();
    if (room.phase === "answering" && room.setterPlayerId === player.id) this.resetWaiting(room);
    advanceCEERound(room, this.now());
    this.publish(room);
  }
  async create(
    connection: ConnectionRecord,
    payload: CEEPayload<"cee.room.create">
  ): Promise<CEERoomEnterResult> {
    this.ensureFree(connection);
    const id = ensureRoomId(payload.roomId);
    if (this.rooms.has(id) || this.isRoomIdReserved(id))
      throw new AppError("ROOM_EXISTS", "该房间号已被使用");
    const password =
      payload.visibility === "private" ? this.requirePassword(payload.password) : undefined;
    const name = this.name(payload.name);
    const userName = this.name(payload.userName);
    // 反作弊只在这一步落地：先查建房的这条连接够不够格，再把那一位写进初始设置。
    const antiCheat = payload.bakaAntiCheat === true;
    if (antiCheat) this.requireClientAdmission(connection);
    // 密码处理前占用房号，失败时由局部事务撤销，防止并发创建覆盖。
    const player = this.player(userName);
    const room: CEERoom = {
      id,
      name,
      visibility: payload.visibility,
      allowSpectators: payload.allowSpectators,
      hostPlayerId: player.id,
      players: new Map([[player.id, player]]),
      settings: { ...createDefaultCEESettings(), bakaAntiCheat: antiCheat },
      phase: "waiting",
      roundNumber: 0,
      setterPlayerId: null,
      phaseDeadlineAt: null,
      round: null,
      summary: null,
      chat: [],
      spectatorRequests: new Map(),
      createdAt: this.now(),
      lastActiveAt: this.now(),
    };
    this.rooms.set(id, room);
    try {
      if (password) room.passwordHash = await Bun.password.hash(password);
      if (!this.connections.findConnection(connection.id) || connection.roomId)
        throw new AppError("SESSION_INVALID", "连接状态已经变化，请重新加入");
      player.ready = true;
      this.attach(connection, room, player);
      this.system(room, `${player.name} 创建了房间`);
      this.publish(room);
      return this.entry(room, player);
    } catch (error) {
      this.rooms.delete(id);
      throw error;
    }
  }
  async join(
    connection: ConnectionRecord,
    roomId: string | undefined,
    payload: CEEPayload<"cee.room.join">
  ): Promise<CEERoomEnterResult> {
    this.ensureFree(connection);
    const room = this.room(roomId);
    this.requireAdmission(connection, room);
    const name = this.name(payload.userName);
    if (room.passwordHash)
      await this.verifyPassword(connection, room.id, room.passwordHash, payload.password);
    this.ensureFree(connection);
    if (this.rooms.get(room.id) !== room) throw new AppError("ROOM_NOT_FOUND", "房间已经关闭");
    if (
      [...room.players.values()].some((player) => player.name.toLowerCase() === name.toLowerCase())
    )
      throw new AppError("NAME_TAKEN", "房间中已有同名玩家");
    if (room.phase !== "waiting" && !room.allowSpectators)
      throw new AppError("SPECTATING_DISABLED", "该房间不允许中途加入");
    const player = this.player(name);
    if (room.phase !== "waiting") player.status = "observing";
    room.players.set(player.id, player);
    this.attach(connection, room, player);
    this.system(room, `${name} 加入了房间`);
    this.publish(room);
    return this.entry(room, player);
  }
  reconnect(
    connection: ConnectionRecord,
    payload: CEEPayload<"cee.room.reconnect">
  ): CEERoomEnterResult {
    this.ensureFree(connection);
    const room = this.room(payload.roomId);
    this.requireAdmission(connection, room);
    const player = [...room.players.values()].find((member) =>
      safeEqualToken(member.sessionToken, payload.sessionToken ?? undefined)
    );
    if (!player) throw new AppError("SESSION_NOT_FOUND", "房间身份已失效，请重新加入");
    if (player.connectionId && player.connectionId !== connection.id) {
      const previous = this.connections.findConnection(player.connectionId);
      if (previous) {
        // 旧连接多半已经死了（客户端断网才会重连），通知与关闭都不许抛：
        // 让顶号失败把新连接一起挡在门外，等于把一次掉线放大成进不去房。口径同 broadcastToRoom。
        try {
          previous.send(createEvent("session.replaced", { reason: "此身份已在另一连接恢复" }));
        } catch {
          /* 发不出去就不发，接管照常 */
        }
        this.connections.detach(previous);
        try {
          previous.close(4001, "session replaced");
        } catch {
          /* 已经关掉的连接不需要再关一次 */
        }
      }
    }
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
    this.publish(room);
    return this.entry(room, player);
  }
  authenticate(
    connection: ConnectionRecord,
    token?: string,
    expectedRoomId?: string
  ): { room: CEERoom; player: CEEPlayerRecord } {
    const room = this.room(connection.roomId);
    const player = connection.playerId ? room.players.get(connection.playerId) : undefined;
    if (
      !player ||
      player.connectionId !== connection.id ||
      !token ||
      !safeEqualToken(player.sessionToken, token)
    )
      throw new AppError("SESSION_INVALID", "请重新加入房间");
    if (expectedRoomId && expectedRoomId !== room.id)
      throw new AppError("ROOM_MISMATCH", "指令房间与当前会话不一致");
    room.lastActiveAt = this.now();
    return { room, player };
  }
  requireHost(room: CEERoom, player: CEEPlayerRecord): void {
    if (player.id !== room.hostPlayerId) throw new AppError("NOT_HOST", "仅房主可以执行此操作");
  }
  requireWaiting(room: CEERoom): void {
    if (room.phase !== "waiting") throw new AppError("INVALID_PHASE", "请在等待阶段修改");
  }
  /**
   * 反作弊房的准入：只放持有客户端通道证明且已登录的连接，浏览器与自写客户端直接拒。
   * 开关为假的房间一行都不执行——普通房间的连接路径与以往完全一致。
   */
  requireAdmission(connection: ConnectionRecord, room: CEERoom): void {
    if (isCEEAntiCheatRoom(room.settings)) this.requireClientAdmission(connection);
  }
  /**
   * 连接级反作弊准入：建房与进房共用同一条判据。
   * 建房时查的是「建房的这条连接」自己——房间里还没有别人，不存在要清场才能开启的顾虑。
   */
  requireClientAdmission(connection: ConnectionRecord): void {
    if (!connection.clientChannel)
      throw new AppError("CLIENT_REQUIRED", "只有 BakaGame 客户端能创建反作弊房间");
    // 强制更新只拦这类房间：旧壳在普通房照常玩，协议变更不该波及他们。
    if (connection.clientChannel.outdated)
      throw new AppError("CLIENT_OUTDATED", "客户端版本过低，请更新后再创建该房间");
    if (!connection.account) throw new AppError("LOGIN_REQUIRED", "创建反作弊房间要求已登录");
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
  leave(connection: ConnectionRecord, room: CEERoom, player: CEEPlayerRecord): void {
    this.connections.detach(connection);
    this.remove(room, player);
  }
  kick(room: CEERoom, actor: CEEPlayerRecord, id: string): void {
    this.requireHost(room, actor);
    if (id === actor.id) throw new AppError("INVALID_PLAYER", "不能移除自己");
    this.evict(room, this.member(room, id), "你已被房主移出房间");
  }
  adminList(): AdminRoomView[] {
    return [...this.rooms.values()].map((room) => ({
      game: "cee",
      roomId: room.id,
      name: room.name,
      phase: room.phase,
      visibility: room.visibility,
      hasPassword: Boolean(room.passwordHash),
      hidden: room.id === ROOM_ID_TEST_MODE,
      roundNumber: room.roundNumber,
      createdAt: room.createdAt,
      lastActiveAt: room.lastActiveAt,
      players: [...room.players.values()].map((player) => ({
        id: player.id,
        name: player.name,
        online: player.online,
        membership: player.membership,
        host: player.id === room.hostPlayerId,
        bot: false,
        userId: player.account?.userId ?? null,
      })),
    }));
  }
  adminClose(roomId: string): void {
    this.closeRoom(this.adminRoom(roomId), ADMIN_CLOSE_MESSAGE);
  }
  /** 后台移人可以移走房主：`remove` 会按掉线口径重选房主。 */
  adminKick(roomId: string, playerId: string): void {
    const room = this.adminRoom(roomId);
    this.evict(room, this.member(room, playerId), ADMIN_KICK_MESSAGE);
  }
  private adminRoom(roomId: string): CEERoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new AppError("ROOM_NOT_FOUND", "房间不存在或已经关闭");
    return room;
  }
  private evict(room: CEERoom, target: CEEPlayerRecord, reason: string): void {
    const connection = target.connectionId
      ? this.connections.findConnection(target.connectionId)
      : undefined;
    if (connection) {
      connection.send(createEvent("cee.player.kicked", { reason }));
      this.connections.detach(connection);
    }
    this.remove(room, target);
  }
  transfer(room: CEERoom, actor: CEEPlayerRecord, id: string): void {
    this.requireHost(room, actor);
    const target = this.member(room, id);
    if (!target.online || target.membership !== "active")
      throw new AppError("INVALID_PLAYER", "请选择在线参与玩家");
    // 房主没有准备态：新房主视同已准备，卸任的房主回到未准备，需要自己再点准备。
    actor.ready = false;
    target.ready = true;
    room.hostPlayerId = id;
    delete room.hostDeadlineAt;
    this.system(room, `${target.name} 成为房主`);
  }
  /** 私密即有密码：切到私密时必须带新密码或已有密码；留空保留原密码；公开房清除密码。 */
  async update(
    room: CEERoom,
    actor: CEEPlayerRecord,
    payload: CEEPayload<"cee.room.update">
  ): Promise<void> {
    this.requireHost(room, actor);
    this.requireWaiting(room);
    const name = this.name(payload.name);
    const password = payload.password?.trim();
    if (payload.visibility === "private" && !password && !room.passwordHash)
      throw new AppError("PASSWORD_REQUIRED", "私密房间需要密码");
    const passwordHash =
      payload.visibility === "public"
        ? undefined
        : password
          ? await Bun.password.hash(password)
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
    const text = rawText.trim().slice(0, 500);
    if (!text) throw new AppError("EMPTY_MESSAGE", "消息不能为空");
    room.chat.push({
      id: crypto.randomUUID(),
      playerId: player.id,
      playerName: player.name,
      text,
      createdAt: this.now(),
      system: false,
    });
    room.chat = room.chat.slice(-CHAT_LIMIT);
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
  publish(room: CEERoom): void {
    if (!this.rooms.has(room.id)) return;
    // 结算散落在领域函数的多条路径里，但都以一次发布收尾：在这里统一交对局记录。
    if (room.phase === "settled") this.recordSettled(room);
    const snapshot = ceeSnapshot(room);
    for (const connection of this.connections.getRoomConnections(room.id)) {
      const player = connection.playerId ? room.players.get(connection.playerId) : undefined;
      if (!player) continue;
      connection.send(createEvent("cee.room.snapshot", snapshot));
      // 私有态按连接裁剪：同一条猜测在不同成员眼里遮蔽不同，不能合并成共享帧。
      connection.send(createEvent("cee.game.privateState", ceePrivateState(room, player)));
    }
    this.onChange?.();
  }
  calibrate(room: CEERoom): void {
    const snapshot = ceeSnapshot(room);
    for (const connection of this.connections.getRoomConnections(room.id)) {
      const player = connection.playerId ? room.players.get(connection.playerId) : undefined;
      if (!player) continue;
      connection.sendStateSyncCalibration?.(createEvent("cee.room.snapshot", snapshot));
      connection.sendStateSyncCalibration?.(
        createEvent("cee.game.privateState", ceePrivateState(room, player))
      );
    }
  }
  /**
   * 导出全部房间以供停机保存。
   *
   * CEE 的房间与回合里散着六处 `Map`（players / spectatorRequests / units / characters /
   * tagOwners / pendingTagOwners），`JSON.stringify` 会把它们统统写成 `{}` —— 直接序列化
   * 得到的是「房间还在、座位和进度全空」的空壳。所以这里逐处摊平成普通对象。
   */
  exportSnapshots(): SnapshottedRoom[] {
    return [...this.rooms.values()].map((room) => serializeRoom(room));
  }

  /**
   * 从快照恢复房间，返回真正恢复的房间数。
   *
   * 时间字段分两类：截止时刻按停机时长后移（停机期间没人能操作），
   * 而空房、离线、空闲三类计时衡量的是「人离开多久」，从恢复时刻重新起算。
   */
  restoreSnapshots(rooms: readonly SnapshottedRoom[], savedAt: number): number {
    const now = this.now();
    const pausedMs = Math.max(0, now - savedAt);
    let restored = 0;
    for (const raw of rooms) {
      const room = deserializeRoom(raw, now, pausedMs);
      if (!room || this.rooms.has(room.id)) continue;
      this.rooms.set(room.id, room);
      restored += 1;
    }
    return restored;
  }

  housekeeping(): void {
    const now = this.now();
    for (const room of this.rooms.values()) {
      if (
        room.id !== ROOM_ID_TEST_MODE &&
        ((room.emptyAt !== undefined && now - room.emptyAt >= ROOM_EMPTY_GRACE_PERIOD_MS) ||
          now - room.lastActiveAt >= ROOM_IDLE_TIMEOUT_MS)
      ) {
        this.closeRoom(room, "房间长时间无人活动，已关闭");
        continue;
      }
      let changed = false;
      if (this.sweepOfflinePlayers(room, now)) changed = true;
      if (room.hostDeadlineAt !== undefined && now >= room.hostDeadlineAt) {
        this.assignHost(room);
        changed = true;
      }
      if (room.phaseDeadlineAt !== null && now >= room.phaseDeadlineAt) {
        this.system(room, "出题等待超时，已返回准备阶段");
        this.resetWaiting(room);
        changed = true;
      }
      // 旁观请求的兜底收口：超时自动拒绝，玩家已离开的条目也要从队列里摘掉。
      if (this.expireSpectateRequests(room, now)) changed = true;
      if (changed) this.publish(room);
      else this.calibrate(room);
    }
  }
  private sweepOfflinePlayers(room: CEERoom, now: number): boolean {
    const expired = [...room.players.values()].filter(
      (player) =>
        !player.online &&
        player.offlineAt !== undefined &&
        now - player.offlineAt >= PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS
    );
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
    const room = id ? this.rooms.get(ensureRoomId(id)) : undefined;
    if (!room) throw new AppError("ROOM_NOT_FOUND", "房间不存在或已经关闭");
    return room;
  }
  private name(value: string): string {
    const result = value.trim();
    if (!result) throw new AppError("INVALID_NAME", "名称不能为空");
    return result.slice(0, 32);
  }
  private requirePassword(value: string | null | undefined): string {
    const password = value?.trim();
    if (!password) throw new AppError("PASSWORD_REQUIRED", "私密房间需要密码");
    return password;
  }
  private async verifyPassword(
    connection: ConnectionRecord,
    roomId: string,
    hash: string,
    value: string | null | undefined
  ): Promise<void> {
    const password = value?.trim();
    if (!password) throw new AppError("PASSWORD_REQUIRED", "该房间需要密码");
    if (!this.joinPasswordLimiter.allow(`${connection.id}:${roomId}`, this.now()))
      throw new AppError("TOO_MANY_ATTEMPTS", "密码错误次数过多，请稍后再试");
    if (!this.joinRoomPasswordLimiter.allow(roomId, this.now()))
      throw new AppError("TOO_MANY_ATTEMPTS", "密码错误次数过多，请稍后再试");
    if (!(await Bun.password.verify(password, hash)))
      throw new AppError("PASSWORD_INCORRECT", "房间密码错误");
  }
  private ensureFree(connection: ConnectionRecord) {
    if (this.connections.findConnection(connection.id) !== connection)
      throw new AppError("SESSION_INVALID", "连接已经断开，请重新加入");
    if (connection.roomId) throw new AppError("ALREADY_IN_ROOM", "请先离开当前房间");
  }
  private player(name: string): CEEPlayerRecord {
    return {
      id: `cee_player_${crypto.randomUUID()}`,
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
    };
  }
  private attach(connection: ConnectionRecord, room: CEERoom, player: CEEPlayerRecord): void {
    connection.resetStateSync?.();
    this.connections.attach(connection, room.id, player.id);
    connection.lobbySubscribed = false;
    player.connectionId = connection.id;
    player.online = true;
    player.account = connection.account;
    delete player.offlineAt;
    delete room.emptyAt;
    if (player.id === room.hostPlayerId) delete room.hostDeadlineAt;
    room.lastActiveAt = this.now();
  }
  private entry(room: CEERoom, player: CEEPlayerRecord): CEERoomEnterResult {
    return {
      roomId: room.id,
      source: "native",
      sessionToken: player.sessionToken,
      snapshot: ceeSnapshot(room),
      privateState: ceePrivateState(room, player),
    };
  }
  private system(room: CEERoom, text: string) {
    room.chat.push({
      id: crypto.randomUUID(),
      playerId: "",
      playerName: "",
      text,
      createdAt: this.now(),
      system: true,
    });
    room.chat = room.chat.slice(-CHAT_LIMIT);
  }
  private remove(room: CEERoom, player: CEEPlayerRecord): void {
    const unit = getCEEUnit(room, player);
    if (
      room.phase === "guessing" &&
      unit &&
      !unit.ended &&
      unit.memberIds.every((id) => id === player.id || !room.players.get(id)?.online)
    )
      surrenderCEE(room, player, this.now());
    player.online = false;
    room.players.delete(player.id);
    if (
      (room.phase === "answering" || room.phase === "preparing") &&
      room.setterPlayerId === player.id
    )
      this.resetWaiting(room);
    if (room.hostPlayerId === player.id) this.assignHost(room);
    if (!room.players.size) this.closeRoom(room, "房间已关闭");
    else {
      if (![...room.players.values()].some((member) => member.online)) room.emptyAt = this.now();
      advanceCEERound(room, this.now());
      this.publish(room);
    }
  }
  private assignHost(room: CEERoom) {
    const next =
      [...room.players.values()].find(
        (player) => player.online && player.membership === "active"
      ) ?? [...room.players.values()].find((player) => player.online);
    if (next) {
      room.hostPlayerId = next.id;
      next.ready = true;
      delete room.hostDeadlineAt;
    }
  }
  private closeRoom(room: CEERoom, reason: string): void {
    // 房间销毁 = 这一局结束：把聚合后的对局记录收尾到销毁时刻。
    this.gameRecorder.finishRoom({
      game: "cee",
      roomId: room.id,
      roomCreatedAt: room.createdAt,
      endedAt: this.now(),
    });
    for (const connection of this.connections.getRoomConnections(room.id)) {
      connection.send(createEvent("cee.room.closed", { reason }));
      this.connections.detach(connection);
      connection.resetStateSync?.();
    }
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

const serializeRoom = (room: CEERoom): SnapshottedRoom => {
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
  } as unknown as SnapshottedRoom;
};

const deserializeRoom = (
  raw: SnapshottedRoom,
  now: number,
  pausedMs: number
): CEERoom | undefined => {
  if (!raw || typeof raw.id !== "string" || !raw.id) return undefined;
  const saved = raw as unknown as SerializedCEERoom;
  if (!saved.players || typeof saved.players !== "object") return undefined;

  const players = new Map<string, CEEPlayerRecord>();
  for (const [id, player] of Object.entries(saved.players)) {
    players.set(id, {
      ...player,
      online: false,
      connectionId: undefined,
      // 离线清理按 offlineAt 起算：不设值的话恢复出来的玩家永远不会被回收。
      offlineAt: now,
    });
  }

  const round: CEERound | null = saved.round
    ? {
        ...saved.round,
        units: new Map(
          Object.entries(saved.round.units ?? {}).map(([id, unit]) => [
            id,
            { ...unit, deadlineAt: unit.deadlineAt === null ? null : unit.deadlineAt + pausedMs },
          ])
        ),
        characters: new Map(
          Object.entries(saved.round.characters ?? {}).map(([id, view]) => [Number(id), view])
        ),
        tagOwners: recordToSets(saved.round.tagOwners),
        pendingTagOwners: recordToSets(saved.round.pendingTagOwners),
      }
    : null;

  return {
    ...saved,
    players,
    spectatorRequests: new Map(
      Object.entries(saved.spectatorRequests ?? {}).map(([id, at]) => [id, Number(at)])
    ),
    // 阶段截止时刻暂停：停机期间没人能作答，按原时刻结算等于用故障惩罚玩家。
    phaseDeadlineAt:
      saved.phaseDeadlineAt === null ? null : saved.phaseDeadlineAt + pausedMs,
    lastActiveAt: now,
    emptyAt: undefined,
    hostDeadlineAt: saved.hostDeadlineAt === undefined ? undefined : now + HOST_RECONNECT_TIMEOUT_MS,
    round,
  };
};
