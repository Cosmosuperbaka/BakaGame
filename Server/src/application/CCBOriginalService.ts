import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../domain/Errors';
import { buildCCBFeedback, createCCBHints, validateCCBSettings } from '../domain/CCBRules';
import type { ConnectionRecord } from '../domain/Model';
import type { CCBDataProvider } from '../infrastructure/CCBData';
import { CCBImageHints } from '../infrastructure/CCBImageHints';
import type { EventLogger } from '../infrastructure/EventLogger';
import { SlidingWindowRateLimiter } from '../infrastructure/RateLimiter';
import { createCCBOriginalSocket, originalConfirmedEvent, originalRequest, type CCBOriginalSocketFactory } from '../infrastructure/CCBOriginalSocket';
import { decodeOriginalCharacter, encodeOriginalCharacter, originalArray, originalCharacter, originalNumber,
  originalObject, originalPlayers, originalScores, originalSettings, originalString, originalStrings,
  toOriginalCharacter, toOriginalSettings } from '../infrastructure/CCBOriginalProtocol';
import { createDefaultCCBSettings, type CCBClientMessage, type CCBGuess, type CCBRoomEnterResult,
  type CCBRoomSummary, type CCBSettings } from '../shared/CCB';
import { createEvent } from '../transport/Packets';
import type { CCBOriginalChatRoom, CCBOriginalSession } from './CCBOriginalModel';
import { originalPrivateState, originalSnapshot } from './CCBOriginalView';

interface CCBOriginalOptions {
  data: CCBDataProvider;
  serverUrl?: string;
  aesSecret?: string;
  now?: () => number;
  logger?: Pick<EventLogger, 'warn'>;
  socketFactory?: CCBOriginalSocketFactory;
  fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  imageHints?: Pick<CCBImageHints, 'render'>;
}

export class CCBOriginalService {
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly sessions = new Map<string, CCBOriginalSession>();
  private readonly byConnection = new Map<string, CCBOriginalSession>();
  private readonly entering = new Set<string>();
  private readonly chats = new Map<string, CCBOriginalChatRoom>();
  private readonly chatLimiter = new SlidingWindowRateLimiter({ windowMs: 10_000, maxRequests: 8 });
  private readonly now: () => number;
  private readonly fetcher: NonNullable<CCBOriginalOptions['fetcher']>;
  private readonly imageHints: Pick<CCBImageHints, 'render'>;
  readonly sourceKey: string;
  readonly configured: boolean;

  constructor(private readonly options: CCBOriginalOptions) {
    this.now = options.now || Date.now;
    this.fetcher = options.fetcher || fetch;
    this.imageHints = options.imageHints || new CCBImageHints();
    this.configured = !!options.serverUrl && !!options.aesSecret;
    if (options.serverUrl) {
      const url = new URL(options.serverUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new AppError('CCB_ORIGINAL_CONFIG', '原版地址必须是无凭据的 HTTP 或 HTTPS 地址');
      }
    }
    this.sourceKey = createHash('sha256').update(options.serverUrl || '').digest('hex').slice(0, 12);
  }

  registerConnection(connection: ConnectionRecord): void { this.connections.set(connection.id, connection); }
  unregisterConnection(id: string): void {
    this.connections.delete(id);
    const session = this.byConnection.get(id);
    this.byConnection.delete(id);
    if (session) { session.connectionId = undefined; session.detachedAt = this.now(); }
  }
  hasSession(id: string): boolean { return this.byConnection.has(id) || this.entering.has(id); }
  getAvailability() {
    return { configured: this.configured, available: this.configured, sourceKey: this.sourceKey,
      reason: this.configured ? '' : '原版服务器兼容配置尚未完成' };
  }
  getHealthSnapshot() {
    return { configured: this.configured, sessions: this.sessions.size, rooms: this.chats.size,
      onlineSessions: [...this.sessions.values()].filter(session => session.confirmed && session.connectionId && session.socket.connected).length };
  }

  async listRooms(): Promise<CCBRoomSummary[]> {
    if (!this.configured) return [];
    const rooms = await this.fetchRooms();
    return rooms.filter(room => room.isPublic === true).map(room => ({
      roomId: originalString(room.id), source: 'original',
      name: originalString(room.displayRoomName) || originalString(room.roomName) || `${originalString(room.hostName)}的房间`,
      phase: room.isGameStarted === true ? 'guessing' : 'waiting', playerCount: originalNumber(room.playerCount),
      hasPassword: false, allowSpectators: true,
    }));
  }

  async execute(connectionId: string, message: CCBClientMessage): Promise<unknown> {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new AppError('CONNECTION_NOT_FOUND', '连接不存在或已断开');
    if (!this.configured) throw new AppError('CCB_ORIGINAL_UNAVAILABLE', '原版服务器兼容配置尚未完成');
    if (message.type === 'ccb.room.create') {
      if (message.payload.password || !message.payload.allowSpectators) this.unsupported('原版房间不支持密码或禁止观战');
      return this.enterOnce(connection, message.payload.roomId, message.payload.userName, message.payload);
    }
    if (message.type === 'ccb.room.join') {
      if (!message.roomId) throw new AppError('ROOM_NOT_FOUND', '请输入原版房间号');
      if (message.payload.password) this.unsupported('原版房间不支持密码');
      return this.enterOnce(connection, message.roomId, message.payload.userName);
    }
    if (message.type === 'ccb.room.reconnect') return this.reconnect(connection, message.payload.roomId, message.payload.sessionToken);
    const session = this.requireSession(connectionId);
    if (message.sessionToken !== session.token) throw new AppError('SESSION_INVALID', '原版会话凭据无效，请重新加入');
    if (message.roomId && message.roomId !== session.roomId) throw new AppError('ROOM_NOT_FOUND', '房间与当前会话不一致');
    const task = session.queue.then(() => this.executeInRoom(session, message));
    session.queue = task.catch(() => undefined);
    return task;
  }

  private async executeInRoom(session: CCBOriginalSession, message: CCBClientMessage): Promise<unknown> {
    if (!session.confirmed || session.revoked || !session.socket.connected) throw new AppError('CCB_ORIGINAL_DISCONNECTED', '原版连接已中断，请重新加入');
    const { data } = this.options;
    const send = (event: string, payload: Record<string, unknown> = {}) => originalRequest(session.socket, event, { roomId: session.roomId, ...payload });
    switch (message.type) {
      case 'ccb.room.leave': this.revoke(session, '已离开房间', false); return {};
      case 'ccb.room.requestSync':
        if (session.connectionId) this.connections.get(session.connectionId)?.resetStateSync?.();
        this.publish(session); return this.enterResult(session);
      case 'ccb.character.search': return { results: await data.searchCharacters(message.payload.keyword) };
      case 'ccb.subject.search':
        this.requireSubjectSearch(session); return { results: await data.searchSubjects(message.payload.keyword) };
      case 'ccb.subject.characters':
        this.requireSubjectSearch(session); return { results: await data.getSubjectCharacters(message.payload.subjectId) };
      case 'ccb.directory.import': return data.importDirectory(message.payload.indexId);
      case 'ccb.character.image': return { imageUrl: await data.resolveCharacterImage(message.payload.characterId) };
      case 'ccb.game.imageHint': return this.imageHint(session);
      case 'ccb.chat.send': return this.chat(session, message.payload.text);
      case 'ccb.player.team': return send('updatePlayerTeam', { team: message.payload.team === null ? null : String(message.payload.team) });
      case 'ccb.player.spectate': return send('updatePlayerTeam', { team: message.payload.spectator ? '0' : null });
      case 'ccb.player.ready': {
        if (this.me(session).ready === message.payload.ready) return {};
        await originalConfirmedEvent(session.socket, 'updatePlayers', () => this.me(session).ready === message.payload.ready,
          () => session.socket.emit('toggleReady', { roomId: session.roomId }));
        return {};
      }
      case 'ccb.room.settings':
        this.requireHost(session); validateCCBSettings(message.payload.settings);
        return send('updateGameSettings', { settings: toOriginalSettings(message.payload.settings) });
      case 'ccb.room.update': {
        this.requireHost(session);
        if (!message.payload.allowSpectators) this.unsupported('原版房间不支持禁止观战');
        await this.updateRoom(session, message.payload.name, message.payload.visibility === 'public');
        return {};
      }
      case 'ccb.room.kick': this.requireHost(session); return send('kickPlayer', { playerId: message.payload.playerId });
      case 'ccb.room.transferHost': this.requireHost(session); return send('transferHost', { newHostId: message.payload.playerId });
      case 'ccb.game.chooseSetter':
        this.requireHost(session);
        await send('enterManualMode');
        return send('setAnswerSetter', { setterId: message.payload.playerId });
      case 'ccb.game.start':
      case 'ccb.game.next': return this.start(session);
      case 'ccb.game.setAnswer': return this.setAnswer(session, message.payload.characterId, message.payload.hints);
      case 'ccb.game.guess': return this.guess(session, message.payload.characterId);
      case 'ccb.game.surrender': return send('enterObserverMode');
      case 'ccb.game.cancel': return this.unsupported('原版服务器没有取消出题或中止对局的指令，可重新指定出题人');
      default: return this.unsupported('当前原版房间不支持此操作');
    }
  }

  private async enter(connection: ConnectionRecord, roomId: string, name: string,
    create?: { name: string; visibility: 'public' | 'private' }): Promise<CCBRoomEnterResult> {
    if (connection.roomId || this.byConnection.has(connection.id)) throw new AppError('ALREADY_IN_ROOM', '请先离开当前房间');
    if (!create && !(await this.fetchRooms()).some(room => room.id === roomId)) throw new AppError('ROOM_NOT_FOUND', '原版房间不存在');
    if (!this.connections.has(connection.id)) throw new AppError('CONNECTION_NOT_FOUND', '加入期间连接已断开');
    const socket = (this.options.socketFactory || createCCBOriginalSocket)(this.options.serverUrl!);
    const session: CCBOriginalSession = {
      token: `ccb_original_${this.sourceKey}_${randomUUID()}`, connectionId: connection.id, roomId, name, socket,
      confirmed: false, revoked: false, players: [], settings: createDefaultCCBSettings(), phase: 'waiting',
      roomName: '', isPublic: true, setterId: null, roundNumber: 0, syncRound: 1, roundKey: null,
      answer: null, hints: [], guesses: [], bannedTags: new Map(), winners: [], roundSummary: null,
      deadlineAt: null, queue: Promise.resolve(),
    };
    this.sessions.set(session.token, session);
    this.byConnection.set(connection.id, session);
    this.listen(session);
    try {
      await originalConfirmedEvent(socket, 'connect', () => true, () => socket.connect());
      await originalConfirmedEvent(socket, 'updatePlayers', () => session.players.some(player => player.id === socket.id && player.name === name),
        () => socket.emit(create ? 'createRoom' : 'joinRoom', { roomId, username: name }));
      if (!this.connections.has(connection.id)) throw new AppError('CONNECTION_NOT_FOUND', '加入期间连接已断开');
      session.confirmed = true;
      if (!this.chats.has(roomId)) this.chats.set(roomId, { generation: randomUUID(), chat: [], roundHints: new Map() });
      connection.resetStateSync?.();
      connection.roomId = `original:${roomId}`;
      connection.playerId = socket.id;
      if (create) {
        await originalRequest(socket, 'updateGameSettings', { roomId, settings: toOriginalSettings(session.settings) });
        await this.updateRoom(session, create.name, create.visibility === 'public');
      } else socket.emit('requestGameSettings', { roomId });
      this.publish(session);
      return this.enterResult(session);
    } catch (error) {
      this.revoke(session, '无法加入原版房间', false);
      throw error;
    }
  }

  private async enterOnce(connection: ConnectionRecord, roomId: string, name: string,
    create?: { name: string; visibility: 'public' | 'private' }): Promise<CCBRoomEnterResult> {
    if (this.entering.has(connection.id)) throw new AppError('CCB_JOIN_PENDING', '正在加入原版房间，请稍候');
    this.entering.add(connection.id);
    try { return await this.enter(connection, roomId, name, create); }
    finally { this.entering.delete(connection.id); }
  }

  private reconnect(connection: ConnectionRecord, roomId: string, token: string): CCBRoomEnterResult {
    const session = this.sessions.get(token);
    if (!session || session.roomId !== roomId || !session.confirmed || session.revoked || !session.socket.connected
      || (session.detachedAt !== undefined && this.now() - session.detachedAt >= 60_000)) {
      throw new AppError('SESSION_EXPIRED', '原版会话已失效，请重新加入房间');
    }
    if (connection.roomId && this.byConnection.get(connection.id) !== session) throw new AppError('ALREADY_IN_ROOM', '请先离开当前房间');
    if (session.connectionId && session.connectionId !== connection.id) {
      const previous = this.connections.get(session.connectionId);
      previous?.send(createEvent('session.replaced', { reason: '已在其他页面恢复原版房间' }));
      if (previous) { previous.roomId = undefined; previous.playerId = undefined; }
      this.byConnection.delete(session.connectionId);
    }
    session.connectionId = connection.id;
    session.detachedAt = undefined;
    this.byConnection.set(connection.id, session);
    connection.roomId = `original:${roomId}`;
    connection.playerId = session.socket.id;
    connection.resetStateSync?.();
    this.publish(session);
    return this.enterResult(session);
  }

  private async updateRoom(session: CCBOriginalSession, name: string, isPublic: boolean): Promise<void> {
    if (name !== session.roomName) await originalConfirmedEvent(session.socket, 'roomNameUpdated',
      payload => originalString(originalObject(payload).roomName) === name.trim().slice(0, 30),
      () => session.socket.emit('updateRoomName', { roomId: session.roomId, roomName: name }));
    if (isPublic !== session.isPublic) await originalConfirmedEvent(session.socket, 'updatePlayers', () => session.isPublic === isPublic,
      () => session.socket.emit('toggleRoomVisibility', { roomId: session.roomId }));
  }

  private async start(session: CCBOriginalSession): Promise<unknown> {
    this.requireHost(session);
    if (!originalPrivateState(session).canStart) throw new AppError('CCB_CANNOT_START', '请等待玩家准备或本局结束');
    const previous = session.phase;
    session.phase = 'preparing'; this.publish(session);
    try {
      const character = await this.options.data.chooseRandomCharacter(session.settings);
      if (!character.imageUrl) character.imageUrl = await this.options.data.resolveCharacterImage(character.id);
      return await originalRequest(session.socket, 'gameStart', { roomId: session.roomId,
        character: encodeOriginalCharacter(character, this.options.aesSecret!), settings: toOriginalSettings(session.settings) });
    } catch (error) {
      if (session.phase === 'preparing') session.phase = previous;
      this.publish(session); throw error;
    }
  }

  private async setAnswer(session: CCBOriginalSession, id: number, hints: string[]): Promise<unknown> {
    if (!originalPrivateState(session).canSetAnswer) throw new AppError('CCB_NOT_SETTER', '只有指定出题人可以提交答案');
    const character = await this.options.data.getCharacter(id, session.settings);
    if (!character.imageUrl) character.imageUrl = await this.options.data.resolveCharacterImage(id);
    return originalRequest(session.socket, 'setAnswer', { roomId: session.roomId,
      character: encodeOriginalCharacter(character, this.options.aesSecret!), hints });
  }

  private async guess(session: CCBOriginalSession, id: number): Promise<unknown> {
    if (!originalPrivateState(session).canGuess || !session.answer) throw new AppError('CCB_CANNOT_GUESS', '当前不能猜测');
    const roundKey = session.roundKey;
    const answer = session.answer;
    const character = await this.options.data.getCharacter(id, session.settings);
    if (session.roundKey !== roundKey || !originalPrivateState(session).canGuess) throw new AppError('CCB_ROUND_CHANGED', '本轮状态已变化，请重新操作');
    const feedback = buildCCBFeedback(character, answer, session.settings);
    const tags = session.settings.tagBan ? feedback.tags.filter(tag => tag.matched).map(tag => tag.text) : [];
    const result = await originalRequest(session.socket, 'playerGuess', { roomId: session.roomId,
      guessResult: { isCorrect: id === answer.id, isPartialCorrect: feedback.sharedAppearances.length > 0, guessData: toOriginalCharacter(character) },
      sharedMetaTags: tags });
    // 旧部署只有独立标签事件；新部署在猜测事务中登记并通过 ACK 确认。
    if (result.tagBanApplied !== true && tags.length && session.roundKey === roundKey && session.phase === 'guessing') {
      session.socket.emit('tagBanSharedMetaTags', { roomId: session.roomId, tags });
    }
    return result;
  }

  private async imageHint(session: CCBOriginalSession): Promise<{ dataUrl: string }> {
    const state = originalPrivateState(session);
    if (!state.imageHintAvailable || !session.answer) throw new AppError('CCB_HINT_LOCKED', '图片提示尚未解锁');
    const roundKey = session.roundKey;
    const image = session.answer.imageUrl || await this.options.data.resolveCharacterImage(session.answer.id);
    if (!image) throw new AppError('CCB_IMAGE_UNAVAILABLE', '暂时无法取得图片提示');
    const dataUrl = await this.imageHints.render(image, Math.max(1, state.imageHintLevel));
    if (session.revoked || session.roundKey !== roundKey) throw new AppError('CCB_ROUND_CHANGED', '本局状态已变化');
    return { dataUrl };
  }

  private chat(session: CCBOriginalSession, text: string): unknown {
    const connectionId = session.connectionId;
    if (!connectionId || !this.chatLimiter.allow(session.token, this.now())) throw new AppError('CHAT_RATE_LIMIT', '发送消息太快，请稍后重试');
    const me = this.me(session);
    const room = this.chats.get(session.roomId)!;
    const message = { id: `ccb_chat_${randomUUID()}`, playerId: me.id, playerName: me.name, text: text.trim(), createdAt: this.now(), system: false };
    if (!message.text) throw new AppError('CHAT_EMPTY', '消息不能为空');
    room.chat = [...room.chat, message].slice(-100);
    for (const peer of this.sessions.values()) if (peer.confirmed && peer.roomId === session.roomId) this.publish(peer);
    return { message };
  }

  private async fetchRooms(): Promise<Record<string, unknown>[]> {
    try {
      const response = await this.fetcher(new URL('/api/list-rooms', this.options.serverUrl), { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('HTTP');
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) throw new Error('shape');
      return payload.map(originalObject);
    } catch {
      throw new AppError('CCB_ORIGINAL_UNAVAILABLE', '暂时无法连接原版服务器');
    }
  }

  private requireSession(id: string): CCBOriginalSession {
    const session = this.byConnection.get(id);
    if (!session?.confirmed) throw new AppError('NOT_IN_ROOM', '尚未加入原版房间');
    return session;
  }
  private me(session: CCBOriginalSession) {
    const player = session.players.find(player => player.id === session.socket.id);
    if (!player) throw new AppError('NOT_IN_ROOM', '原版房间内没有当前玩家');
    return player;
  }
  private requireHost(session: CCBOriginalSession): void {
    if (!this.me(session).isHost) throw new AppError('HOST_ONLY', '只有房主可以操作');
  }
  private requireSubjectSearch(session: CCBOriginalSession): void {
    if (session.phase === 'guessing' && !session.settings.subjectSearch && !originalPrivateState(session).answer) {
      throw new AppError('SUBJECT_SEARCH_DISABLED', '本局关闭了作品搜索');
    }
  }
  private unsupported(message: string): never { throw new AppError('CCB_ORIGINAL_UNSUPPORTED', message); }
  private enterResult(session: CCBOriginalSession): CCBRoomEnterResult {
    return { roomId: session.roomId, source: 'original', sessionToken: session.token,
      snapshot: originalSnapshot(session, this.chats.get(session.roomId)), privateState: originalPrivateState(session) };
  }
  private publish(session: CCBOriginalSession, calibration = false): void {
    if (!session.confirmed || !session.connectionId) return;
    const connection = this.connections.get(session.connectionId);
    if (!connection) return;
    const send = calibration ? connection.sendStateSyncCalibration : connection.send;
    send?.(createEvent('ccb.room.snapshot', originalSnapshot(session, this.chats.get(session.roomId))));
    send?.(createEvent('ccb.game.privateState', originalPrivateState(session)));
  }

  private revoke(session: CCBOriginalSession, reason: string, notify = true, kicked = false): void {
    if (session.revoked) return;
    session.revoked = true; session.confirmed = false;
    if (session.connectionId) {
      const connection = this.connections.get(session.connectionId);
      if (notify) connection?.send(createEvent(kicked ? 'ccb.player.kicked' : 'ccb.room.closed', { roomId: session.roomId, source: 'original', reason }));
      if (connection) { connection.roomId = undefined; connection.playerId = undefined; }
      this.byConnection.delete(session.connectionId);
    }
    this.sessions.delete(session.token);
    session.socket.removeAllListeners(); session.socket.disconnect();
    if (![...this.sessions.values()].some(peer => peer.confirmed && peer.roomId === session.roomId)) this.chats.delete(session.roomId);
  }
  runHousekeeping(): void {
    for (const session of this.sessions.values()) {
      if (session.detachedAt !== undefined && this.now() - session.detachedAt >= 60_000) this.revoke(session, '重连等待已结束', false);
      else this.publish(session, true);
    }
  }
  notifyShutdown(): void {
    for (const session of this.sessions.values()) if (session.connectionId) this.connections.get(session.connectionId)?.send(createEvent('server.shutdown', { reason: '服务器正在重启' }));
  }
  close(): void { for (const session of this.sessions.values()) this.revoke(session, '服务已关闭', false); this.connections.clear(); }

  private listen(session: CCBOriginalSession): void {
    const on = (event: string, apply: (payload: Record<string, unknown>) => void) => {
      session.socket.on(event, value => {
        try { apply(value === undefined ? {} : originalObject(value)); this.publish(session); }
        catch {
          this.options.logger?.warn('原版房间状态转换失败', { event });
          this.revoke(session, '原版返回的房间状态无法解析，请重新加入');
        }
      });
    };
    on('updatePlayers', payload => {
      session.players = originalPlayers(payload.players, session.phase, session.syncRound);
      if (typeof payload.isPublic === 'boolean') session.isPublic = payload.isPublic;
      if (payload.answerSetterId !== undefined) session.setterId = originalString(payload.answerSetterId) || null;
      if (session.confirmed && !session.players.some(player => player.id === session.socket.id)) this.revoke(session, '已离开原版房间', true, true);
    });
    on('roomNameUpdated', payload => { session.roomName = originalString(payload.roomName); });
    on('updateGameSettings', payload => { session.settings = originalSettings(payload.settings); });
    on('waitForAnswer', payload => { session.setterId = originalString(payload.answerSetterId); session.phase = 'answering'; });
    on('waitForAnswerCanceled', () => { session.setterId = null; session.phase = 'waiting'; });
    on('gameStart', payload => this.gameStarted(session, payload));
    on('guessHistoryUpdate', payload => this.updateHistory(session, payload.guesses));
    on('resetTimer', payload => { session.deadlineAt = originalNumber(payload.deadlineAt) || null; });
    on('syncRoundStart', payload => { session.syncRound = originalNumber(payload.round, 1); session.players.forEach(player => { player.syncCompleted = false; }); });
    on('syncWaiting', payload => {
      session.syncRound = originalNumber(payload.round, session.syncRound);
      const completed = new Set(originalArray(payload.syncStatus).map(originalObject).filter(item => item.completed === true).map(item => originalString(item.id)));
      session.players.forEach(player => { player.syncCompleted = completed.has(player.id); });
    });
    on('tagBanStateUpdate', payload => {
      session.bannedTags = new Map(originalArray(payload.tagBanState).map(value => {
        const entry = originalObject(value); return [originalString(entry.tag), new Set(originalStrings(entry.revealer))];
      }));
    });
    on('nonstopProgress', payload => {
      session.winners = originalArray(payload.winners).map(value => {
        const winner = originalObject(value);
        return { playerId: session.players.find(player => player.name === winner.username)?.id || '', rank: originalNumber(winner.rank), score: originalNumber(winner.score) };
      });
    });
    on('gameEnded', payload => {
      this.updateHistory(session, payload.guesses);
      session.phase = 'settled'; session.deadlineAt = null;
      if (!session.answer) throw new AppError('CCB_ORIGINAL_PROTOCOL', '缺少本局答案');
      const scores = originalScores(payload.scoreDetails, session.players);
      session.roundSummary = { answer: session.answer, scores, guesses: session.guesses,
        winners: session.winners.length ? session.winners : scores.filter(score => score.base > 0).map(score => ({ playerId: score.playerId, rank: score.rank || 1, score: score.score })) };
    });
    on('playerKicked', payload => { if (payload.playerId === session.socket.id) this.revoke(session, '已被房主移出原版房间', true, true); });
    on('roomClosed', () => { for (const peer of this.sessions.values()) if (peer.roomId === session.roomId) this.revoke(peer, '原版房间已关闭'); });
    session.socket.on('disconnect', () => this.revoke(session, '原版连接已中断，请重新加入房间'));
  }

  private gameStarted(session: CCBOriginalSession, payload: Record<string, unknown>): void {
    const key = createHash('sha256').update(JSON.stringify(payload.character)).digest('hex');
    const isNew = session.phase !== 'guessing' || session.roundKey !== key;
    session.settings = originalSettings(payload.settings);
    session.answer = decodeOriginalCharacter(payload.character, this.options.aesSecret!);
    session.phase = 'guessing'; session.setterId = null;
    session.players = originalPlayers(payload.players, session.phase, session.syncRound);
    if (typeof payload.isPublic === 'boolean') session.isPublic = payload.isPublic;
    const me = session.players.find(player => player.id === session.socket.id);
    if (me && payload.isAnswerSetter === true) me.isSetter = true;
    session.setterId = session.players.find(player => player.isSetter)?.id || null;
    if (isNew) {
      session.roundNumber += 1; session.syncRound = 1; session.roundKey = key;
      session.guesses = []; session.bannedTags.clear(); session.winners = []; session.roundSummary = null; session.deadlineAt = null;
    }
    // 上游加入快照可能紧随确认包到达，先建立本房缓存，保证首位与后来者共享自动提示。
    if (!this.chats.has(session.roomId) && session.players.some(player => player.id === session.socket.id)) {
      this.chats.set(session.roomId, { generation: randomUUID(), chat: [], roundHints: new Map() });
    }
    const chat = this.chats.get(session.roomId);
    if (Array.isArray(payload.hints)) session.hints = originalStrings(payload.hints);
    else {
      if (chat && !chat.roundHints.has(key)) {
        chat.roundHints.clear();
        chat.roundHints.set(key, createCCBHints(session.answer.summary, session.settings.useHints.length, Math.random));
      }
      session.hints = chat?.roundHints.get(key) || createCCBHints(session.answer.summary, session.settings.useHints.length, Math.random);
    }
  }

  private updateHistory(session: CCBOriginalSession, value: unknown): void {
    if (!session.answer) return;
    const previous = new Map(session.guesses.map(guess => [guess.id, guess]));
    session.guesses = originalArray(value).flatMap(value => {
      const history = originalObject(value);
      return originalArray(history.guesses).map((value, index): CCBGuess => {
        const raw = originalObject(value);
        const playerId = originalString(raw.playerId) || session.players.find(player => player.name === history.username)?.id || '';
        const id = `${session.roundNumber}:${playerId}:${index}`;
        const character = originalCharacter(raw.guessData);
        return { id, playerId, playerName: originalString(raw.playerName) || originalString(history.username),
          character: { id: character.id, name: character.name, nameCn: character.nameCn, imageUrl: character.imageUrl },
          correct: raw.isCorrect === true, partial: raw.isPartialCorrect === true,
          syncRound: originalNumber(raw.round, session.syncRound), createdAt: previous.get(id)?.createdAt || this.now(),
          feedback: buildCCBFeedback(character, session.answer!, session.settings) };
      });
    });
  }
}
