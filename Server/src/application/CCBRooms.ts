import { ConnectionRegistry } from './ConnectionRegistry';
import { AppError } from '../domain/Errors';
import { type CCBPlayerRecord, type CCBRoom } from '../domain/CCBModel';
import { advanceCCBRound, getCCBUnit, surrenderCCB } from '../domain/CCBRound';
import { createDefaultCCBSettings, isValidRoomId, ROOM_ID_TEST_MODE, SERVER_SHUTDOWN_MESSAGE,
  type CCBPayload, type CCBRoomEnterResult, type ConnectionRecord } from '../shared/Index';
import { CHAT_LIMIT, HOST_RECONNECT_TIMEOUT_MS, PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS, ROOM_EMPTY_GRACE_PERIOD_MS, ROOM_IDLE_TIMEOUT_MS } from '../config/Constants';
import { ccbPrivateState, ccbSnapshot, ccbRoomSummary } from './CCBViews';

export class CCBRooms {
  readonly connections = new ConnectionRegistry();
  readonly rooms = new Map<string, CCBRoom>();
  onChange?: () => void;
  constructor(readonly now: () => number) {}
  getHealthSnapshot() {
    return { roomCount: this.rooms.size, playerCount: [...this.rooms.values()].reduce((sum, room) => sum + room.players.size, 0),
      onlinePlayerCount: [...this.rooms.values()].reduce((sum, room) => sum + [...room.players.values()].filter(player => player.online).length, 0),
      connectionCount: this.connections.stats.totalConnections };
  }
  listRooms() { return [...this.rooms.values()].filter(room => room.visibility === 'public' && room.id !== ROOM_ID_TEST_MODE).map(ccbRoomSummary); }
  registerConnection(connection: ConnectionRecord) { this.connections.registerConnection(connection); }
  unregisterConnection(connectionId: string): void {
    const connection = this.connections.unregisterConnection(connectionId);
    if (!connection?.playerId || !connection.roomId) return;
    const room = this.rooms.get(connection.roomId); const player = room?.players.get(connection.playerId);
    if (!room || !player || player.connectionId !== connectionId) return;
    player.online = false; player.offlineAt = this.now(); delete player.connectionId;
    if (room.hostPlayerId === player.id) room.hostDeadlineAt = this.now() + HOST_RECONNECT_TIMEOUT_MS;
    if (![...room.players.values()].some(member => member.online)) room.emptyAt = this.now();
    if (room.phase === 'answering' && room.setterPlayerId === player.id) this.resetWaiting(room);
    advanceCCBRound(room, this.now()); this.publish(room);
  }
  async create(connection: ConnectionRecord, payload: CCBPayload<'ccb.room.create'>): Promise<CCBRoomEnterResult> {
    this.ensureFree(connection);
    const id = this.normalizeRoomId(payload.roomId);
    if (this.rooms.has(id)) throw new AppError('ROOM_EXISTS', '该房间号已被使用');
    const name = this.name(payload.name); const userName = this.name(payload.userName);
    // 密码处理前占用房号，失败时由局部事务撤销，防止并发创建覆盖。
    const player = this.player(userName);
    const room: CCBRoom = { id, name, visibility: payload.visibility, allowSpectators: payload.allowSpectators,
      hostPlayerId: player.id, players: new Map([[player.id, player]]), settings: createDefaultCCBSettings(), phase: 'waiting',
      roundNumber: 0, setterPlayerId: null, phaseDeadlineAt: null, round: null, summary: null, chat: [], lastActiveAt: this.now() };
    this.rooms.set(id, room);
    try {
      if (payload.password) room.passwordHash = await Bun.password.hash(payload.password);
      if (!this.connections.findConnection(connection.id) || connection.roomId) throw new AppError('SESSION_INVALID', '连接状态已经变化，请重新加入');
      player.ready = true; this.attach(connection, room, player); this.system(room, `${player.name} 创建了房间`);
      this.publish(room); return this.entry(room, player);
    } catch (error) { this.rooms.delete(id); throw error; }
  }
  async join(connection: ConnectionRecord, roomId: string | undefined, payload: CCBPayload<'ccb.room.join'>): Promise<CCBRoomEnterResult> {
    this.ensureFree(connection); const room = this.room(roomId); const name = this.name(payload.userName);
    if (room.passwordHash && (!payload.password || !await Bun.password.verify(payload.password, room.passwordHash))) throw new AppError('PASSWORD_REQUIRED', '房间密码不正确');
    this.ensureFree(connection);
    if (this.rooms.get(room.id) !== room) throw new AppError('ROOM_NOT_FOUND', '房间已经关闭');
    if ([...room.players.values()].some(player => player.name.toLowerCase() === name.toLowerCase())) throw new AppError('NAME_TAKEN', '房间中已有同名玩家');
    if (room.phase !== 'waiting' && !room.allowSpectators) throw new AppError('SPECTATING_DISABLED', '该房间不允许中途加入');
    const player = this.player(name); if (room.phase !== 'waiting') player.status = 'observing';
    room.players.set(player.id, player); this.attach(connection, room, player); this.system(room, `${name} 加入了房间`);
    this.publish(room); return this.entry(room, player);
  }
  reconnect(connection: ConnectionRecord, payload: CCBPayload<'ccb.room.reconnect'>): CCBRoomEnterResult {
    this.ensureFree(connection); const room = this.room(payload.roomId);
    const player = [...room.players.values()].find(member => member.sessionToken === payload.sessionToken);
    if (!player) throw new AppError('SESSION_NOT_FOUND', '房间身份已失效，请重新加入');
    if (player.connectionId && player.connectionId !== connection.id) {
      const previous = this.connections.findConnection(player.connectionId);
      if (previous) { previous.send({ type: 'event', event: 'session.replaced', payload: { reason: '此身份已在另一连接恢复' } }); this.connections.detach(previous); previous.close(4001, 'session replaced'); }
    }
    this.attach(connection, room, player);
    const unit = getCCBUnit(room, player);
    if (room.phase === 'guessing' && unit && !unit.ended && !unit.completed && room.settings.timeLimit && unit.deadlineAt === null) unit.deadlineAt = this.now() + room.settings.timeLimit * 1000;
    this.publish(room); return this.entry(room, player);
  }
  authenticate(connection: ConnectionRecord, token?: string, expectedRoomId?: string): { room: CCBRoom; player: CCBPlayerRecord } {
    const room = this.room(connection.roomId); const player = connection.playerId ? room.players.get(connection.playerId) : undefined;
    if (!player || player.connectionId !== connection.id || !token || player.sessionToken !== token) throw new AppError('SESSION_INVALID', '请重新加入房间');
    if (expectedRoomId && expectedRoomId !== room.id) throw new AppError('ROOM_MISMATCH', '指令房间与当前会话不一致');
    room.lastActiveAt = this.now(); return { room, player };
  }
  requireHost(room: CCBRoom, player: CCBPlayerRecord): void {
    if (player.id !== room.hostPlayerId) throw new AppError('NOT_HOST', '仅房主可以执行此操作');
  }
  requireWaiting(room: CCBRoom): void { if (room.phase !== 'waiting') throw new AppError('INVALID_PHASE', '请在等待阶段修改'); }
  leave(connection: ConnectionRecord, room: CCBRoom, player: CCBPlayerRecord): void { this.remove(room, player); this.connections.detach(connection); }
  kick(room: CCBRoom, actor: CCBPlayerRecord, id: string): void {
    this.requireHost(room, actor); if (id === actor.id) throw new AppError('INVALID_PLAYER', '不能移除自己');
    const target = this.member(room, id); const connection = target.connectionId ? this.connections.findConnection(target.connectionId) : undefined;
    if (connection) { connection.send({ type: 'event', event: 'ccb.player.kicked', payload: { reason: '你已被房主移出房间' } }); this.connections.detach(connection); }
    this.remove(room, target);
  }
  transfer(room: CCBRoom, actor: CCBPlayerRecord, id: string): void {
    this.requireHost(room, actor); const target = this.member(room, id);
    if (!target.online || target.membership !== 'active') throw new AppError('INVALID_PLAYER', '请选择在线参与玩家');
    room.hostPlayerId = id; delete room.hostDeadlineAt; this.system(room, `${target.name} 成为房主`);
  }
  member(room: CCBRoom, id: string): CCBPlayerRecord {
    const player = room.players.get(id); if (!player) throw new AppError('PLAYER_NOT_FOUND', '玩家不在房间中'); return player;
  }
  sendChat(room: CCBRoom, player: CCBPlayerRecord, rawText: string): void {
    const text = rawText.trim().slice(0, 200); if (!text) throw new AppError('EMPTY_MESSAGE', '消息不能为空');
    room.chat.push({ id: crypto.randomUUID(), playerId: player.id, playerName: player.name, text, createdAt: this.now(), system: false });
    room.chat = room.chat.slice(-CHAT_LIMIT);
  }
  resetWaiting(room: CCBRoom): void {
    room.phase = 'waiting'; room.setterPlayerId = null; room.phaseDeadlineAt = null; room.round = null; room.summary = null;
    delete room.preparationId;
    for (const player of room.players.values()) { player.ready = player.id === room.hostPlayerId; player.status = 'waiting'; player.attempts = 0; player.marks = ''; player.syncCompleted = false; }
  }
  publish(room: CCBRoom): void {
    if (!this.rooms.has(room.id)) return;
    const snapshot = ccbSnapshot(room);
    for (const connection of this.connections.getRoomConnections(room.id)) {
      const player = connection.playerId ? room.players.get(connection.playerId) : undefined;
      if (!player) continue;
      connection.send({ type: 'event', event: 'ccb.room.snapshot', payload: snapshot });
      connection.send({ type: 'event', event: 'ccb.game.privateState', payload: ccbPrivateState(room, player) });
    }
    this.onChange?.();
  }
  calibrate(room: CCBRoom): void {
    const snapshot = ccbSnapshot(room);
    for (const connection of this.connections.getRoomConnections(room.id)) {
      const player = connection.playerId ? room.players.get(connection.playerId) : undefined;
      if (!player) continue;
      connection.sendStateSyncCalibration?.({ type: 'event', event: 'ccb.room.snapshot', payload: snapshot });
      connection.sendStateSyncCalibration?.({ type: 'event', event: 'ccb.game.privateState', payload: ccbPrivateState(room, player) });
    }
  }
  housekeeping(): void {
    const now = this.now();
    for (const room of this.rooms.values()) {
      if (room.id !== ROOM_ID_TEST_MODE && ((room.emptyAt !== undefined && now - room.emptyAt >= ROOM_EMPTY_GRACE_PERIOD_MS) || now - room.lastActiveAt >= ROOM_IDLE_TIMEOUT_MS)) { this.closeRoom(room, '房间长时间无人活动，已关闭'); continue; }
      let changed = false;
      for (const player of room.players.values()) if (!player.online && player.offlineAt !== undefined && now - player.offlineAt >= PLAYER_OFFLINE_CLEANUP_TIMEOUT_MS) { this.remove(room, player); changed = true; }
      if (room.hostDeadlineAt !== undefined && now >= room.hostDeadlineAt) { this.assignHost(room); changed = true; }
      if (room.phaseDeadlineAt !== null && now >= room.phaseDeadlineAt) { this.system(room, '出题等待超时，已返回准备阶段'); this.resetWaiting(room); changed = true; }
      if (changed) this.publish(room); else this.calibrate(room);
    }
  }
  notifyShutdown() { this.connections.broadcastToAll({ type: 'event', event: 'server.shutdown', payload: { message: SERVER_SHUTDOWN_MESSAGE } }); }
  private room(id: string | undefined): CCBRoom {
    const room = id ? this.rooms.get(this.normalizeRoomId(id)) : undefined;
    if (!room) throw new AppError('ROOM_NOT_FOUND', '房间不存在或已经关闭'); return room;
  }
  private normalizeRoomId(id: string): string {
    if (!isValidRoomId(id)) throw new AppError('INVALID_ROOM_ID', '请输入四位数字房间号');
    return id.trim().toLowerCase() === ROOM_ID_TEST_MODE.toLowerCase() ? ROOM_ID_TEST_MODE : id.trim();
  }
  private name(value: string): string { const result = value.trim(); if (!result) throw new AppError('INVALID_NAME', '名称不能为空'); return result.slice(0, 32); }
  private ensureFree(connection: ConnectionRecord) {
    if (this.connections.findConnection(connection.id) !== connection) throw new AppError('SESSION_INVALID', '连接已经断开，请重新加入');
    if (connection.roomId) throw new AppError('ALREADY_IN_ROOM', '请先离开当前房间');
  }
  private player(name: string): CCBPlayerRecord {
    return { id: `ccb_player_${crypto.randomUUID()}`, sessionToken: crypto.randomUUID(), name, online: true, ready: false,
      team: null, membership: 'active', score: 0, status: 'waiting', attempts: 0, marks: '', syncCompleted: false, joinedAt: this.now() };
  }
  private attach(connection: ConnectionRecord, room: CCBRoom, player: CCBPlayerRecord): void {
    connection.resetStateSync?.(); this.connections.attach(connection, room.id, player.id);
    connection.lobbySubscribed = false; player.connectionId = connection.id; player.online = true;
    delete player.offlineAt; delete room.emptyAt;
    if (player.id === room.hostPlayerId) delete room.hostDeadlineAt;
    room.lastActiveAt = this.now();
  }
  private entry(room: CCBRoom, player: CCBPlayerRecord): CCBRoomEnterResult {
    return { roomId: room.id, source: 'native', sessionToken: player.sessionToken, snapshot: ccbSnapshot(room), privateState: ccbPrivateState(room, player) };
  }
  private system(room: CCBRoom, text: string) {
    room.chat.push({ id: crypto.randomUUID(), playerId: '', playerName: '', text, createdAt: this.now(), system: true }); room.chat = room.chat.slice(-CHAT_LIMIT);
  }
  private remove(room: CCBRoom, player: CCBPlayerRecord): void {
    const unit = getCCBUnit(room, player);
    if (room.phase === 'guessing' && unit && !unit.ended && unit.memberIds.every(id => id === player.id || !room.players.get(id)?.online)) surrenderCCB(room, player, this.now());
    player.online = false;
    room.players.delete(player.id);
    if ((room.phase === 'answering' || room.phase === 'preparing') && room.setterPlayerId === player.id) this.resetWaiting(room);
    if (room.hostPlayerId === player.id) this.assignHost(room);
    if (!room.players.size) this.closeRoom(room, '所有玩家已离开');
    else { if (![...room.players.values()].some(member => member.online)) room.emptyAt = this.now(); advanceCCBRound(room, this.now()); this.publish(room); }
  }
  private assignHost(room: CCBRoom) {
    const next = [...room.players.values()].find(player => player.online && player.membership === 'active') ?? [...room.players.values()].find(player => player.online);
    if (next) { room.hostPlayerId = next.id; next.ready = true; delete room.hostDeadlineAt; }
  }
  private closeRoom(room: CCBRoom, reason: string): void {
    for (const connection of this.connections.getRoomConnections(room.id)) {
      connection.send({ type: 'event', event: 'ccb.room.closed', payload: { reason } }); this.connections.detach(connection); connection.resetStateSync?.();
    }
    this.rooms.delete(room.id); this.onChange?.();
  }
}
