import type { CCBClientMessage, CCBCharacterView, ConnectionRecord } from '../shared/Index';
import { AppError } from '../domain/Errors';
import type { CCBPlayerRecord, CCBRoom } from '../domain/CCBModel';
import { ccbUnitId } from '../domain/CCBModel';
import { applyCCBGuess, beginCCBRound, ccbParticipants, getCCBUnit, requireCCBAction, surrenderCCB, tickCCBRound } from '../domain/CCBRound';
import { validateCCBSettings } from '../domain/CCBRules';
import type { CCBDataProvider } from '../infrastructure/CCBData';
import { CCBImageHints } from '../infrastructure/CCBImageHints';
import { CCBRooms } from './CCBRooms';
import { ccbPrivateState } from './CCBViews';

export class CCBNativeService {
  readonly state: CCBRooms;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly data: CCBDataProvider;
  private readonly imageHints: CCBImageHints;
  private readonly inFlight = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(options: { data: CCBDataProvider; now?: () => number; random?: () => number; imageHints?: CCBImageHints;
    isRoomIdReserved?: (roomId: string) => boolean }) {
    this.data = options.data; this.now = options.now ?? Date.now; this.random = options.random ?? Math.random;
    this.imageHints = options.imageHints ?? new CCBImageHints(); this.state = new CCBRooms(this.now, options.isRoomIdReserved);
  }
  registerConnection(connection: ConnectionRecord) { this.state.registerConnection(connection); }
  unregisterConnection(connectionId: string) { this.state.unregisterConnection(connectionId); this.rescheduleAll(); }
  getHealthSnapshot() { return this.state.getHealthSnapshot(); }
  listRooms() { return this.state.listRooms(); }
  notifyShutdown() { this.state.notifyShutdown(); }
  close() { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
  runHousekeeping() {
    for (const room of this.state.rooms.values()) {
      const before = JSON.stringify([room.phase, room.round?.syncRound, [...room.players.values()].map(player => [player.attempts, player.status])]);
      tickCCBRound(room, this.now());
      const after = JSON.stringify([room.phase, room.round?.syncRound, [...room.players.values()].map(player => [player.attempts, player.status])]);
      if (before !== after) this.state.publish(room);
    }
    this.state.housekeeping(); this.rescheduleAll();
  }
  async execute(connectionId: string, message: CCBClientMessage): Promise<unknown> {
    const connection = this.state.connections.getConnection(connectionId);
    switch (message.type) {
      case 'ccb.room.create': return this.state.create(connection, message.payload);
      case 'ccb.room.join': return this.state.join(connection, message.roomId, message.payload);
      case 'ccb.room.reconnect': {
        const result = this.state.reconnect(connection, message.payload); this.rescheduleAll(); return result;
      }
      case 'ccb.lobby.subscribeRooms': connection.lobbySubscribed = true; return { rooms: this.listRooms() };
    }
    const { room, player } = this.state.authenticate(connection, message.sessionToken, message.roomId);
    tickCCBRound(room, this.now());
    try {
    switch (message.type) {
      case 'ccb.room.leave': this.state.leave(connection, room, player); break;
      case 'ccb.room.requestSync': connection.resetStateSync?.(); break;
      case 'ccb.room.settings':
        this.state.requireHost(room, player); this.state.requireWaiting(room); validateCCBSettings(message.payload.settings);
        room.settings = structuredClone(message.payload.settings); break;
      case 'ccb.room.update': await this.state.update(room, player, message.payload); break;
      // 房主没有准备态：开局权在房主手里，准备与否对他没有意义，界面也不显示准备按钮。
      case 'ccb.player.ready':
        this.state.requireWaiting(room); if (player.id !== room.hostPlayerId) player.ready = message.payload.ready; break;
      case 'ccb.player.team': this.state.requireWaiting(room); player.team = message.payload.team; break;
      case 'ccb.player.spectate':
        this.state.requireWaiting(room);
        if (message.payload.spectator && !room.allowSpectators) throw new AppError('SPECTATING_DISABLED', '该房间不允许观战');
        player.membership = message.payload.spectator ? 'spectator' : 'active'; player.ready = false; break;
      case 'ccb.room.kick': this.state.kick(room, player, message.payload.playerId); break;
      case 'ccb.room.transferHost': this.state.transfer(room, player, message.payload.playerId); break;
      case 'ccb.chat.send': this.state.sendChat(room, player, message.payload.text); break;
      case 'ccb.character.search': return { results: await this.data.searchCharacters(message.payload.keyword) };
      case 'ccb.subject.search':
        if (room.phase === 'guessing' && !room.settings.subjectSearch && player.status === 'playing') throw new AppError('SUBJECT_SEARCH_DISABLED', '本局关闭了作品搜索');
        return { results: await this.data.searchSubjects(message.payload.keyword) };
      case 'ccb.subject.characters':
        if (room.phase === 'guessing' && !room.settings.subjectSearch && player.status === 'playing') throw new AppError('SUBJECT_SEARCH_DISABLED', '本局关闭了作品搜索');
        return { results: await this.data.getSubjectCharacters(message.payload.subjectId) };
      case 'ccb.subject.lookup': return { results: await this.data.getSubjects(message.payload.subjectIds) };
      case 'ccb.directory.import':
        this.state.requireHost(room, player); this.state.requireWaiting(room); return this.data.importDirectory(message.payload.indexId);
      case 'ccb.character.image': return { imageUrl: await this.data.resolveCharacterImage(message.payload.characterId) };
      case 'ccb.subject.image': return { imageUrl: await this.data.resolveSubjectImage(message.payload.subjectId) };
      case 'ccb.game.start': await this.start(room, player); break;
      case 'ccb.game.chooseSetter': {
        this.state.requireHost(room, player);
        if (room.phase !== 'choosingSetter') throw new AppError('INVALID_PHASE', '请先开始游戏再指定出题人');
        const setter = this.state.member(room, message.payload.playerId);
        if (!setter.online) throw new AppError('PLAYER_OFFLINE', '出题人已离线');
        if (!ccbParticipants(room, setter.id).length) throw new AppError('NO_PARTICIPANTS', '出题人及其队友不能参与猜测，请保留其他猜题者');
        room.setterPlayerId = setter.id;
        room.phase = 'answering'; room.preparationId = crypto.randomUUID(); room.phaseDeadlineAt = this.now() + 120000; break;
      }
      case 'ccb.game.setAnswer': await this.setAnswer(room, player, message.payload.characterId, message.payload.hints); break;
      case 'ccb.game.cancel':
        this.state.requireHost(room, player);
        // 选出题人阶段还没开局，退回等待只换阶段，大家的准备状态原样保留。
        if (room.phase === 'choosingSetter') { room.phase = 'waiting'; break; }
        if (room.phase !== 'answering' && room.phase !== 'preparing') throw new AppError('INVALID_PHASE', '当前没有等待中的出题任务');
        this.state.resetWaiting(room); break;
      case 'ccb.game.guess': await this.guess(room, player, message.payload.characterId); break;
      case 'ccb.game.surrender': surrenderCCB(room, player, this.now()); break;
      case 'ccb.game.next':
        this.state.requireHost(room, player);
        if (room.phase !== 'settled') throw new AppError('INVALID_PHASE', '请等待本局结束');
        this.state.resetWaiting(room); break;
      case 'ccb.game.imageHint': return this.imageHint(room, player);
    }
    return {};
    } finally { this.state.publish(room); this.schedule(room); }
  }
  /** 开始游戏：随机出题直接抽题开局；手动出题进入选出题人阶段，由房主在那里指定出题人。 */
  private async start(room: CCBRoom, player: CCBPlayerRecord): Promise<void> {
    this.state.requireHost(room, player); this.state.requireWaiting(room);
    if (!ccbPrivateState(room, player).canStart) throw new AppError('PLAYERS_NOT_READY', '至少一名猜题玩家在线，且其他参与者准备后才能开始');
    validateCCBSettings(room.settings);
    if (room.settings.answerMode === 'manual') { room.phase = 'choosingSetter'; return; }
    room.phase = 'preparing'; room.phaseDeadlineAt = this.now() + 30000;
    const preparationId = crypto.randomUUID(); room.preparationId = preparationId;
    this.state.publish(room); this.schedule(room);
    try {
      const answer = await this.data.chooseRandomCharacter(room.settings, this.random);
      if (this.state.rooms.get(room.id) !== room || room.phase !== 'preparing' || room.preparationId !== preparationId || this.now() >= room.phaseDeadlineAt!) throw new AppError('ROUND_CANCELLED', '本次出题已经取消');
      beginCCBRound(room, answer, null, this.now(), this.random);
    } catch (error) {
      if (room.phase === 'preparing' && room.preparationId === preparationId) this.state.resetWaiting(room);
      this.state.publish(room); this.schedule(room); throw error;
    }
  }
  private async setAnswer(room: CCBRoom, player: CCBPlayerRecord, id: number, hints: string[]): Promise<void> {
    if (room.phase !== 'answering' || room.setterPlayerId !== player.id) throw new AppError('NOT_SETTER', '仅当前出题人可以提交答案');
    const key = `answer:${room.id}`;
    if (this.inFlight.has(key)) throw new AppError('ACTION_PENDING', '答案正在提交');
    this.inFlight.add(key); const preparationId = room.preparationId;
    try {
      const answer = await this.data.getCharacter(id, room.settings);
      if (this.state.rooms.get(room.id) !== room || room.phase !== 'answering' || room.setterPlayerId !== player.id || room.preparationId !== preparationId || this.now() >= room.phaseDeadlineAt! || !player.online) throw new AppError('ROUND_CANCELLED', '本次出题已经取消');
      beginCCBRound(room, answer, hints, this.now(), this.random);
    } finally { this.inFlight.delete(key); }
  }
  private async guess(room: CCBRoom, player: CCBPlayerRecord, id: number): Promise<void> {
    const { round, unit } = requireCCBAction(room, player);
    const syncRound = round.syncRound; const attempts = unit.attempts;
    const key = `guess:${room.id}:${ccbUnitId(player)}`;
    if (this.inFlight.has(key)) throw new AppError('ACTION_PENDING', '队伍猜测正在提交');
    this.inFlight.add(key);
    try {
      const loaded = round.characters.get(id) ?? await this.data.getCharacter(id, round.settings);
      if (this.state.rooms.get(room.id) !== room || room.round !== round) throw new AppError('ROUND_CANCELLED', '本局已经结束');
      // 查询期间时钟仍继续运行；到期先执行扣次，再重新校验行动资格。
      tickCCBRound(room, this.now());
      requireCCBAction(room, player);
      if (round.syncRound !== syncRound || unit.attempts !== attempts) throw new AppError('ROUND_CANCELLED', '本次行动已超时，请重新猜测');
      const character = round.characters.get(id) ?? structuredClone(loaded);
      applyCCBGuess(room, player, character, this.now());
      round.characters.set(id, character);
    } finally { this.inFlight.delete(key); }
  }
  private async imageHint(room: CCBRoom, player: CCBPlayerRecord): Promise<{ dataUrl: string }> {
    const state = ccbPrivateState(room, player); const round = room.round;
    if (!state.imageHintAvailable || !round) throw new AppError('HINT_LOCKED', '图片提示尚未解锁');
    const url = await this.data.resolveCharacterImage(round.answer.id);
    if (!url) throw new AppError('IMAGE_UNAVAILABLE', '该角色暂时没有图片');
    const dataUrl = await this.imageHints.render(url, state.imageHintLevel);
    if (room.round !== round || !ccbPrivateState(room, player).imageHintAvailable) throw new AppError('HINT_LOCKED', '图片提示已失效');
    return { dataUrl };
  }
  private rescheduleAll() {
    for (const [id, timer] of this.timers) if (!this.state.rooms.has(id)) { clearTimeout(timer); this.timers.delete(id); }
    for (const room of this.state.rooms.values()) this.schedule(room);
  }
  private schedule(room: CCBRoom): void {
    const current = this.timers.get(room.id); if (current) clearTimeout(current); this.timers.delete(room.id);
    if (!this.state.rooms.has(room.id)) return;
    const times = [room.phaseDeadlineAt, ...[...room.round?.units.values() ?? []].map(unit => unit.deadlineAt)].filter((value): value is number => value !== null);
    if (!times.length) return;
    const timer = setTimeout(() => {
      this.timers.delete(room.id);
      if (!this.state.rooms.has(room.id)) return;
      if (room.phaseDeadlineAt !== null && this.now() >= room.phaseDeadlineAt) this.state.resetWaiting(room);
      tickCCBRound(room, this.now()); this.state.publish(room); this.schedule(room);
    }, Math.max(1, Math.min(...times) - this.now()));
    timer.unref(); this.timers.set(room.id, timer);
  }
}
