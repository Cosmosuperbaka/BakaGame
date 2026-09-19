import type { CCBClientMessage, CCBRoomSummary, ConnectionRecord } from '../shared/Index';
import { AppError } from '../domain/Errors';
import type { CCBDataProvider } from '../infrastructure/CCBData';
import type { EventLogger } from '../infrastructure/EventLogger';
import { SlidingWindowRateLimiter } from '../infrastructure/RateLimiter';
import { CCBNativeService } from './CCBNativeService';
import { CCBOriginalService } from './CCBOriginalService';

export class CCBService {
  readonly native: CCBNativeService;
  readonly original: CCBOriginalService;
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly limiter = new SlidingWindowRateLimiter({ windowMs: 10000, maxRequests: 80 });
  private readonly chatLimiter = new SlidingWindowRateLimiter({ windowMs: 10000, maxRequests: 8 });
  private readonly entering = new Set<string>();
  private readonly now: () => number;
  private remoteRooms: CCBRoomSummary[] = [];
  private remoteFetchedAt = Number.NEGATIVE_INFINITY;
  private remoteRequest: Promise<void> | null = null;
  private lastLobby = '';
  constructor(private readonly options: { data: CCBDataProvider; eventLogger?: EventLogger; serverUrl?: string; aesSecret?: string; now?: () => number; random?: () => number; originalService?: CCBOriginalService }) {
    this.now = options.now ?? Date.now;
    this.native = new CCBNativeService(options);
    this.original = options.originalService ?? new CCBOriginalService({ ...options, logger: options.eventLogger });
    this.native.state.onChange = () => this.broadcastLobby();
  }
  registerConnection(connection: ConnectionRecord): void {
    this.connections.set(connection.id, connection); this.native.registerConnection(connection); this.original.registerConnection(connection);
  }
  async unregisterConnection(id: string): Promise<void> {
    const connection = this.connections.get(id);
    const isOriginal = Boolean(connection?.roomId?.startsWith('original:'));
    if (isOriginal && connection) this.native.state.connections.detach(connection);
    this.original.unregisterConnection(id); this.native.unregisterConnection(id); this.connections.delete(id);
  }
  async execute(id: string, message: CCBClientMessage): Promise<unknown> {
    const connection = this.connections.get(id);
    if (!connection) throw new AppError('CONNECTION_NOT_FOUND', '连接已经断开');
    if (!this.limiter.allow(id, this.now())) throw new AppError('RATE_LIMITED', '操作过于频繁，请稍后再试');
    if (message.type === 'ccb.chat.send' && !this.chatLimiter.allow(id, this.now())) throw new AppError('RATE_LIMITED', '消息发送过快，请稍后再试');
    if (message.type === 'ccb.lobby.subscribeRooms') {
      if (connection.roomId) throw new AppError('ALREADY_IN_ROOM', '请先离开房间');
      connection.lobbySubscribed = true; await this.refreshRemote();
      const rooms = this.listRooms(); connection.send({ type: 'event', event: 'ccb.lobby.rooms', payload: rooms });
      return { rooms, originalAvailable: this.original.configured, sourceKey: this.original.sourceKey };
    }
    const isEntering = message.type === 'ccb.room.create' || message.type === 'ccb.room.join' || message.type === 'ccb.room.reconnect';
    if (isEntering) {
      if (connection.roomId || this.entering.has(id)) throw new AppError('ALREADY_IN_ROOM', '请先离开当前房间，或等待加入完成');
      this.entering.add(id);
    }
    try {
      const original = isEntering ? message.payload.source === 'original' : this.original.hasSession(id);
      if (original && !isEntering && (!message.sessionToken || !connection.roomId?.startsWith('original:'))) throw new AppError('SESSION_INVALID', '请重新加入房间');
      const result = await (original ? this.original.execute(id, message) : this.native.execute(id, message));
      this.broadcastLobby(); return result;
    } finally { if (isEntering) this.entering.delete(id); }
  }
  listRooms(): CCBRoomSummary[] { return [...this.native.listRooms(), ...this.remoteRooms]; }
  getHealthSnapshot() {
    const local = this.native.getHealthSnapshot(); const remote = this.original.getHealthSnapshot();
    return { roomCount: local.roomCount + remote.rooms, onlinePlayerCount: local.onlinePlayerCount + remote.onlineSessions,
      playerCount: local.playerCount + remote.sessions, connectionCount: this.connections.size };
  }
  async runHousekeeping(): Promise<void> {
    this.native.runHousekeeping(); this.original.runHousekeeping();
    if ([...this.connections.values()].some(connection => connection.lobbySubscribed && !connection.roomId)) await this.refreshRemote();
    this.broadcastLobby();
  }
  notifyShutdown(): void { this.native.notifyShutdown(); }
  async close(): Promise<void> { this.native.close(); this.original.close(); await this.options.data.close(); }
  private broadcastLobby(): void {
    const rooms = this.listRooms(); const serialized = JSON.stringify(rooms);
    if (serialized === this.lastLobby) return;
    this.lastLobby = serialized;
    for (const connection of this.connections.values()) if (connection.lobbySubscribed && !connection.roomId) connection.send({ type: 'event', event: 'ccb.lobby.rooms', payload: rooms });
  }
  private async refreshRemote(): Promise<void> {
    if (!this.original.configured || this.now() - this.remoteFetchedAt < 5000) return;
    if (this.remoteRequest) return this.remoteRequest;
    this.remoteRequest = this.original.listRooms().then(rooms => { this.remoteRooms = rooms; this.remoteFetchedAt = this.now(); })
      .catch((error: unknown) => { this.options.eventLogger?.warn('原版房间列表暂不可用', { error: error instanceof Error ? error.message : String(error) }); this.remoteRooms = []; })
      .finally(() => { this.remoteRequest = null; });
    return this.remoteRequest;
  }
}
