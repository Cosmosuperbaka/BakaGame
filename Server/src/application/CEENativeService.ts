import type { GameRecorder } from '../domain/GameRecord';
import type { CEEClientMessage, ConnectionRecord } from '../shared/Index';
import { AppError } from '../domain/Errors';
import type { CEEPlayerRecord, CEERoom } from '../domain/CEEModel';
import { ceeUnitId } from '../domain/CEEModel';
import { applyCEEGuess, beginCEERound, ceeParticipants, requireCEEAction, surrenderCEE, tickCEERound } from '../domain/CEERound';
import { validateCEESettings } from '../domain/CEERules';
import type { CEEDataProvider } from '../infrastructure/CEEData';
import { CEEImageHints } from '../infrastructure/CEEImageHints';
import { CEERooms } from './CEERooms';
import { ceePrivateState } from './CEEViews';

export class CEENativeService {
  readonly state: CEERooms;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly data: CEEDataProvider;
  private readonly imageHints: CEEImageHints;
  private readonly inFlight = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(options: { data: CEEDataProvider; now?: () => number; random?: () => number; imageHints?: CEEImageHints;
    isRoomIdReserved?: (roomId: string) => boolean; gameRecorder?: GameRecorder }) {
    this.data = options.data; this.now = options.now ?? Date.now; this.random = options.random ?? Math.random;
    this.imageHints = options.imageHints ?? new CEEImageHints(); this.state = new CEERooms(this.now, options.isRoomIdReserved, options.gameRecorder);
  }
  registerConnection(connection: ConnectionRecord) { this.state.registerConnection(connection); }
  unregisterConnection(connectionId: string) { this.state.unregisterConnection(connectionId); this.rescheduleAll(); }
  getHealthSnapshot() { return this.state.getHealthSnapshot(); }
  listRooms() { return this.state.listRooms(); }
  adminListRooms() { return this.state.adminList(); }
  adminCloseRoom(roomId: string) { this.state.adminClose(roomId); this.rescheduleAll(); }
  adminKickPlayer(roomId: string, playerId: string) {
    this.state.adminKick(roomId, playerId);
    const room = this.state.rooms.get(roomId); if (room) this.schedule(room); else this.rescheduleAll();
  }
  notifyShutdown() { this.state.notifyShutdown(); }
  close() { for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
  runHousekeeping() {
    for (const room of this.state.rooms.values()) {
      const before = JSON.stringify([room.phase, room.round?.syncRound, [...room.players.values()].map(player => [player.attempts, player.status])]);
      tickCEERound(room, this.now());
      const after = JSON.stringify([room.phase, room.round?.syncRound, [...room.players.values()].map(player => [player.attempts, player.status])]);
      if (before !== after) this.state.publish(room);
    }
    this.state.housekeeping(); this.rescheduleAll();
  }
  async execute(connectionId: string, message: CEEClientMessage): Promise<unknown> {
    const connection = this.state.connections.getConnection(connectionId);
    switch (message.type) {
      case 'cee.room.create': return this.state.create(connection, message.payload);
      case 'cee.room.join': return this.state.join(connection, message.roomId, message.payload);
      case 'cee.room.reconnect': {
        const result = this.state.reconnect(connection, message.payload); this.rescheduleAll(); return result;
      }
      case 'cee.lobby.subscribeRooms': connection.lobbySubscribed = true; return { rooms: this.listRooms() };
    }
    const { room, player } = this.state.authenticate(connection, message.sessionToken, message.roomId);
    tickCEERound(room, this.now());
    try {
    switch (message.type) {
      case 'cee.room.leave': this.state.leave(connection, room, player); break;
      case 'cee.room.requestSync': connection.resetStateSync?.(); break;
      case 'cee.room.settings':
        this.state.requireHost(room, player); this.state.requireWaiting(room); validateCEESettings(message.payload.settings);
        room.settings = structuredClone(message.payload.settings); break;
      case 'cee.room.update': await this.state.update(room, player, message.payload); break;
      // 房主没有准备态：开局权在房主手里，准备与否对他没有意义，界面也不显示准备按钮。
      case 'cee.player.ready':
        this.state.requireWaiting(room); if (player.id !== room.hostPlayerId) player.ready = message.payload.ready; break;
      case 'cee.player.team': this.state.requireWaiting(room); player.team = message.payload.team; break;
      case 'cee.player.spectate':
        this.state.requireWaiting(room);
        if (message.payload.spectator && !room.allowSpectators) throw new AppError('SPECTATING_DISABLED', '该房间不允许观战');
        player.membership = message.payload.spectator ? 'spectator' : 'active'; player.ready = false; break;
      case 'cee.room.kick': this.state.kick(room, player, message.payload.playerId); break;
      case 'cee.room.transferHost': this.state.transfer(room, player, message.payload.playerId); break;
      case 'cee.chat.send': this.state.sendChat(room, player, message.payload.text); break;
      case 'cee.character.search': return { results: await this.data.searchCharacters(message.payload.keyword) };
      case 'cee.subject.search':
        this.requireSubjectSearch(room, player); return { results: await this.data.searchSubjects(message.payload.keyword) };
      case 'cee.subject.characters':
        this.requireSubjectSearch(room, player); return { results: await this.data.getSubjectCharacters(message.payload.subjectId) };
      case 'cee.subject.lookup': return { results: await this.data.getSubjects(message.payload.subjectIds) };
      case 'cee.directory.import':
        this.state.requireHost(room, player); this.state.requireWaiting(room); return this.data.importDirectory(message.payload.indexId);
      // 列表是方形缩略图，尺寸缺省即方格图；大图用途走服务端内部调用，不带这条命令。
      case 'cee.character.image': return { imageUrl: await this.data.resolveCharacterImage(message.payload.characterId, message.payload.size ?? 'grid') };
      case 'cee.subject.image': return { imageUrl: await this.data.resolveSubjectImage(message.payload.subjectId) };
      case 'cee.game.start': await this.start(room, player); break;
      case 'cee.game.chooseSetter': this.chooseSetter(room, player, message.payload.playerId); break;
      case 'cee.game.setAnswer': await this.setAnswer(room, player, message.payload.characterId, message.payload.hints); break;
      case 'cee.game.cancel': this.cancelPreparation(room, player); break;
      case 'cee.game.guess': await this.guess(room, player, message.payload.characterId); break;
      case 'cee.game.surrender': surrenderCEE(room, player, this.now()); break;
      case 'cee.game.next':
        this.state.requireHost(room, player);
        if (room.phase !== 'settled') throw new AppError('INVALID_PHASE', '请等待本局结束');
        this.state.resetWaiting(room); break;
      case 'cee.game.imageHint': return this.imageHint(room, player);
    }
    return {};
    } finally { this.state.publish(room); this.schedule(room); }
  }
  /** 关闭作品搜索的那一局里，正在猜题的玩家不能靠搜索绕过题目线索。 */
  private requireSubjectSearch(room: CEERoom, player: CEEPlayerRecord): void {
    if (room.phase === 'guessing' && !room.settings.subjectSearch && player.status === 'playing') throw new AppError('SUBJECT_SEARCH_DISABLED', '本局关闭了作品搜索');
  }
  private chooseSetter(room: CEERoom, player: CEEPlayerRecord, playerId: string): void {
    this.state.requireHost(room, player);
    if (room.phase !== 'choosingSetter') throw new AppError('INVALID_PHASE', '请先开始游戏再指定出题人');
    const setter = this.state.member(room, playerId);
    if (!setter.online) throw new AppError('PLAYER_OFFLINE', '出题人已离线');
    if (!ceeParticipants(room, setter.id).length) throw new AppError('NO_PARTICIPANTS', '出题人及其队友不能参与猜测，请保留其他猜题者');
    room.setterPlayerId = setter.id;
    room.phase = 'answering'; room.preparationId = crypto.randomUUID(); room.phaseDeadlineAt = this.now() + 120000;
  }
  private cancelPreparation(room: CEERoom, player: CEEPlayerRecord): void {
    this.state.requireHost(room, player);
    // 选出题人阶段还没开局，退回等待只换阶段，大家的准备状态原样保留。
    if (room.phase === 'choosingSetter') { room.phase = 'waiting'; return; }
    if (room.phase !== 'answering' && room.phase !== 'preparing') throw new AppError('INVALID_PHASE', '当前没有等待中的出题任务');
    this.state.resetWaiting(room);
  }
  /** 开始游戏：随机出题直接抽题开局；手动出题进入选出题人阶段，由房主在那里指定出题人。 */
  private async start(room: CEERoom, player: CEEPlayerRecord): Promise<void> {
    this.state.requireHost(room, player);
    if (room.phase !== 'waiting' && room.phase !== 'settled') throw new AppError('INVALID_PHASE', '当前阶段无法开始游戏');
    if (!ceePrivateState(room, player).canStart) throw new AppError('PLAYERS_NOT_READY', '至少两名玩家在线，且其他参与者准备后才能开始');
    validateCEESettings(room.settings);
    room.round = null; room.summary = null; room.setterPlayerId = null;
    if (room.settings.answerMode === 'manual') { room.phase = 'choosingSetter'; return; }
    room.phase = 'preparing'; room.phaseDeadlineAt = this.now() + 30000;
    const preparationId = crypto.randomUUID(); room.preparationId = preparationId;
    this.state.publish(room); this.schedule(room);
    try {
      const answer = await this.data.chooseRandomCharacter(room.settings, this.random);
      if (this.state.rooms.get(room.id) !== room || room.phase !== 'preparing' || room.preparationId !== preparationId || this.now() >= room.phaseDeadlineAt!) throw new AppError('ROUND_CANCELLED', '本次出题已经取消');
      beginCEERound(room, answer, null, this.now(), this.random);
    } catch (error) {
      if (room.phase === 'preparing' && room.preparationId === preparationId) this.state.resetWaiting(room);
      this.state.publish(room); this.schedule(room); throw error;
    }
  }
  private async setAnswer(room: CEERoom, player: CEEPlayerRecord, id: number, hints: string[]): Promise<void> {
    if (room.phase !== 'answering' || room.setterPlayerId !== player.id) throw new AppError('NOT_SETTER', '仅当前出题人可以提交答案');
    const key = `answer:${room.id}`;
    if (this.inFlight.has(key)) throw new AppError('ACTION_PENDING', '答案正在提交');
    this.inFlight.add(key); const preparationId = room.preparationId;
    try {
      const answer = await this.data.getCharacter(id, room.settings);
      if (this.state.rooms.get(room.id) !== room || room.phase !== 'answering' || room.setterPlayerId !== player.id || room.preparationId !== preparationId || this.now() >= room.phaseDeadlineAt! || !player.online) throw new AppError('ROUND_CANCELLED', '本次出题已经取消');
      beginCEERound(room, answer, hints, this.now(), this.random);
    } finally { this.inFlight.delete(key); }
  }
  private async guess(room: CEERoom, player: CEEPlayerRecord, id: number): Promise<void> {
    const { round, unit } = requireCEEAction(room, player);
    const syncRound = round.syncRound; const attempts = unit.attempts;
    const key = `guess:${room.id}:${ceeUnitId(player)}`;
    if (this.inFlight.has(key)) throw new AppError('ACTION_PENDING', '队伍猜测正在提交');
    this.inFlight.add(key);
    try {
      const loaded = round.characters.get(id) ?? await this.data.getCharacter(id, round.settings);
      if (this.state.rooms.get(room.id) !== room || room.round !== round) throw new AppError('ROUND_CANCELLED', '本局已经结束');
      // 查询期间时钟仍继续运行；到期先执行扣次，再重新校验行动资格。
      tickCEERound(room, this.now());
      requireCEEAction(room, player);
      if (round.syncRound !== syncRound || unit.attempts !== attempts) throw new AppError('ROUND_CANCELLED', '本次行动已超时，请重新猜测');
      const character = round.characters.get(id) ?? structuredClone(loaded);
      applyCEEGuess(room, player, character, this.now());
      round.characters.set(id, character);
    } finally { this.inFlight.delete(key); }
  }
  private async imageHint(room: CEERoom, player: CEEPlayerRecord): Promise<{ dataUrl: string }> {
    const state = ceePrivateState(room, player); const round = room.round;
    if (!state.imageHintAvailable || !round) throw new AppError('HINT_LOCKED', '图片提示尚未解锁');
    const url = await this.data.resolveCharacterImage(round.answer.id);
    if (!url) throw new AppError('IMAGE_UNAVAILABLE', '该角色暂时没有图片');
    const dataUrl = await this.imageHints.render(url, state.imageHintLevel);
    if (room.round !== round || !ceePrivateState(room, player).imageHintAvailable) throw new AppError('HINT_LOCKED', '图片提示已失效');
    return { dataUrl };
  }
  private rescheduleAll() {
    for (const [id, timer] of this.timers) if (!this.state.rooms.has(id)) { clearTimeout(timer); this.timers.delete(id); }
    for (const room of this.state.rooms.values()) this.schedule(room);
  }
  private schedule(room: CEERoom): void {
    const current = this.timers.get(room.id); if (current) clearTimeout(current); this.timers.delete(room.id);
    if (!this.state.rooms.has(room.id)) return;
    const times = [room.phaseDeadlineAt, ...[...room.round?.units.values() ?? []].map(unit => unit.deadlineAt)].filter((value): value is number => value !== null);
    if (!times.length) return;
    const timer = setTimeout(() => {
      this.timers.delete(room.id);
      if (!this.state.rooms.has(room.id)) return;
      if (room.phaseDeadlineAt !== null && this.now() >= room.phaseDeadlineAt) this.state.resetWaiting(room);
      tickCEERound(room, this.now()); this.state.publish(room); this.schedule(room);
    }, Math.max(1, Math.min(...times) - this.now()));
    timer.unref(); this.timers.set(room.id, timer);
  }
}
