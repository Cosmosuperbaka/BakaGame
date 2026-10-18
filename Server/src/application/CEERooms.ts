import { ConnectionRegistry } from "./ConnectionRegistry";
import { ADMIN_CLOSE_MESSAGE, ADMIN_KICK_MESSAGE, type AdminRoomView } from "../domain/AdminRoom";
import { AppError } from "../domain/Errors";
import { NOOP_GAME_RECORDER, type GameRecorder } from "../domain/GameRecord";
import { type CEEPlayerRecord, type CEERoom } from "../domain/CEEModel";
import { advanceCEERound, getCEEUnit, surrenderCEE } from "../domain/CEERound";
import {
  createDefaultCEESettings,
  isCEEAntiCheatRoom,
  isValidRoomId,
  ROOM_ID_TEST_MODE,
  SERVER_SHUTDOWN_MESSAGE,
  type CEEPayload,
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
import { normalizeCEERoomId } from "./CEERoomDirectory";
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
  /** `isRoomIdReserved` 由统一房号目录提供：该号已分配给原版房时增强房不能占用。 */
  constructor(
    readonly now: () => number,
    private readonly isRoomIdReserved: (roomId: string) => boolean = () => false,
    private readonly gameRecorder: GameRecorder = NOOP_GAME_RECORDER
  ) {}
  private recordSettled(room: CEERoom): void {
    const { round, summary } = room;
    if (!round || !summary || this.recordedSummaries.has(summary)) return;
    this.recordedSummaries.add(summary);
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
      timeline: summary.guesses.map((guess) => ({
        at: guess.createdAt,
        type: "guess",
        name: guess.playerName,
        character: guess.character.nameCn || guess.character.name,
        correct: guess.correct,
        partial: guess.partial,
      })),
    });
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
    const id = this.normalizeRoomId(payload.roomId);
    if (this.rooms.has(id) || this.isRoomIdReserved(id))
      throw new AppError("ROOM_EXISTS", "该房间号已被使用");
    const password =
      payload.visibility === "private" ? this.requirePassword(payload.password) : undefined;
    const name = this.name(payload.name);
    const userName = this.name(payload.userName);
    // 密码处理前占用房号，失败时由局部事务撤销，防止并发创建覆盖。
    const player = this.player(userName);
    const room: CEERoom = {
      id,
      name,
      visibility: payload.visibility,
      allowSpectators: payload.allowSpectators,
      hostPlayerId: player.id,
      players: new Map([[player.id, player]]),
      settings: createDefaultCEESettings(),
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
    const player = [...room.players.values()].find(
      (member) => member.sessionToken === payload.sessionToken
    );
    if (!player) throw new AppError("SESSION_NOT_FOUND", "房间身份已失效，请重新加入");
    if (player.connectionId && player.connectionId !== connection.id) {
      const previous = this.connections.findConnection(player.connectionId);
      if (previous) {
        previous.send({
          type: "event",
          event: "session.replaced",
          payload: { reason: "此身份已在另一连接恢复" },
        });
        this.connections.detach(previous);
        previous.close(4001, "session replaced");
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
    if (!player || player.connectionId !== connection.id || !token || player.sessionToken !== token)
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
    if (!isCEEAntiCheatRoom(room.settings)) return;
    if (!connection.clientChannel)
      throw new AppError("CLIENT_REQUIRED", "该房间只接受 BakaGame 客户端接入");
    // 强制更新只拦这类房间：旧壳在普通房照常玩，协议变更不该波及他们。
    if (connection.clientChannel.outdated)
      throw new AppError("CLIENT_OUTDATED", "客户端版本过低，请更新后再进入该房间");
    if (!connection.account) throw new AppError("LOGIN_REQUIRED", "该房间要求全部成员已登录");
  }
  /**
   * 中途开启只在等待阶段允许，且房内不能还留着 Web 接入或未登录玩家：
   * 静默踢人不可接受，要拒绝并把「谁挡住了」说清楚。
   */
  requireAntiCheatAdmissible(room: CEERoom, next: CEESettings): void {
    if (!isCEEAntiCheatRoom(next) || isCEEAntiCheatRoom(room.settings)) return;
    for (const player of room.players.values()) {
      if (!player.online) continue;
      const connection = player.connectionId
        ? this.connections.findConnection(player.connectionId)
        : undefined;
      if (!connection?.clientChannel)
        throw new AppError("ANTI_CHEAT_BLOCKED", "请先让 Web 接入的玩家退出");
      if (!player.account) throw new AppError("ANTI_CHEAT_BLOCKED", "请先让未登录的玩家退出或登录");
    }
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
    connection?.send({
      type: "event",
      event: "cee.player.spectateResult",
      payload: { approved },
    });
  }
  /** 关闭开关后清理悬空请求：待批准的人退回参与态，不能让状态残留在已经不需要审批的房子里。 */
  clearSpectateRequests(room: CEERoom): void {
    room.spectatorRequests.clear();
    for (const player of room.players.values())
      if (player.membership === "pendingSpectator") player.membership = "active";
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
      connection.send({ type: "event", event: "cee.player.kicked", payload: { reason } });
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
      connection.send({ type: "event", event: "cee.room.snapshot", payload: snapshot });
      connection.send({
        type: "event",
        event: "cee.game.privateState",
        payload: ceePrivateState(room, player),
      });
    }
    this.onChange?.();
  }
  calibrate(room: CEERoom): void {
    const snapshot = ceeSnapshot(room);
    for (const connection of this.connections.getRoomConnections(room.id)) {
      const player = connection.playerId ? room.players.get(connection.playerId) : undefined;
      if (!player) continue;
      connection.sendStateSyncCalibration?.({
        type: "event",
        event: "cee.room.snapshot",
        payload: snapshot,
      });
      connection.sendStateSyncCalibration?.({
        type: "event",
        event: "cee.game.privateState",
        payload: ceePrivateState(room, player),
      });
    }
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
    this.connections.broadcastToAll({
      type: "event",
      event: "server.shutdown",
      payload: { message: SERVER_SHUTDOWN_MESSAGE },
    });
  }
  private room(id: string | undefined): CEERoom {
    const room = id ? this.rooms.get(this.normalizeRoomId(id)) : undefined;
    if (!room) throw new AppError("ROOM_NOT_FOUND", "房间不存在或已经关闭");
    return room;
  }
  private normalizeRoomId(id: string): string {
    if (!isValidRoomId(id)) throw new AppError("INVALID_ROOM_ID", "请输入四位数字房间号");
    return normalizeCEERoomId(id);
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
      connection.send({ type: "event", event: "cee.room.closed", payload: { reason } });
      this.connections.detach(connection);
      connection.resetStateSync?.();
    }
    this.rooms.delete(room.id);
    this.onChange?.();
  }
}
