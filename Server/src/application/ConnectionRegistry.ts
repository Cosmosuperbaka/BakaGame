import type { ConnectionRecord } from "../domain/Model";
import { AppError } from "../domain/Errors";

export class ConnectionRegistry {
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly roomIndex = new Map<string, Set<ConnectionRecord>>();
  private readonly playerIndex = new Map<string, ConnectionRecord>();
  private readonly lobbySubscribers = new Set<ConnectionRecord>();

  // ==================== 显式席位变更入口 ====================
  // 索引此前只由属性 setter 隐式维护：业务代码里一句 `connection.roomId = undefined`
  // 就会偷偷改动索引，读代码的人完全看不出来。这几个方法把"改席位"变成显式动作，
  // 内部仍走同一套索引更新逻辑，行为不变。
  setRoom(connection: ConnectionRecord, roomId: string | undefined): void {
    connection.roomId = roomId;
  }

  setPlayer(connection: ConnectionRecord, playerId: string | undefined): void {
    connection.playerId = playerId;
  }

  /** 连接与其席位彻底脱钩（房间与玩家一起清空）。 */
  detach(connection: ConnectionRecord): void {
    connection.roomId = undefined;
    connection.playerId = undefined;
  }

  /** 原子地把连接绑定到某个房间的某个玩家。 */
  attach(connection: ConnectionRecord, roomId: string, playerId: string): void {
    connection.roomId = roomId;
    connection.playerId = playerId;
  }

  registerConnection(connection: ConnectionRecord): void {
    this.connections.set(connection.id, connection);

    let currentRoomId = connection.roomId;
    let currentPlayerId = connection.playerId;
    let currentLobbySubscribed = connection.lobbySubscribed;

    const updateRoomIndex = (oldRoom?: string, newRoom?: string) => {
      if (oldRoom) {
        const set = this.roomIndex.get(oldRoom);
        if (set) {
          set.delete(connection);
          if (set.size === 0) this.roomIndex.delete(oldRoom);
        }
      }
      if (newRoom) {
        if (!this.roomIndex.has(newRoom)) {
          this.roomIndex.set(newRoom, new Set());
        }
        this.roomIndex.get(newRoom)!.add(connection);
      }
      updateLobbyIndex();
    };

    const updatePlayerIndex = (oldPlayer?: string, newPlayer?: string) => {
      if (oldPlayer && this.playerIndex.get(oldPlayer) === connection) {
        this.playerIndex.delete(oldPlayer);
      }
      if (newPlayer) {
        this.playerIndex.set(newPlayer, connection);
      }
    };

    const updateLobbyIndex = () => {
      if (currentLobbySubscribed && !currentRoomId) {
        this.lobbySubscribers.add(connection);
      } else {
        this.lobbySubscribers.delete(connection);
      }
    };

    // 初始化索引
    if (currentRoomId) updateRoomIndex(undefined, currentRoomId);
    if (currentPlayerId) updatePlayerIndex(undefined, currentPlayerId);
    updateLobbyIndex();

    // 拦截属性赋值，动态维护二级索引
    Object.defineProperty(connection, "roomId", {
      get: () => currentRoomId,
      set: (next: string | undefined) => {
        if (currentRoomId !== next) {
          const prev = currentRoomId;
          currentRoomId = next;
          updateRoomIndex(prev, next);
        }
      },
      configurable: true,
      enumerable: true,
    });

    Object.defineProperty(connection, "playerId", {
      get: () => currentPlayerId,
      set: (next: string | undefined) => {
        if (currentPlayerId !== next) {
          const prev = currentPlayerId;
          currentPlayerId = next;
          updatePlayerIndex(prev, next);
        }
      },
      configurable: true,
      enumerable: true,
    });

    Object.defineProperty(connection, "lobbySubscribed", {
      get: () => currentLobbySubscribed,
      set: (next: boolean) => {
        if (currentLobbySubscribed !== next) {
          currentLobbySubscribed = next;
          updateLobbyIndex();
        }
      },
      configurable: true,
      enumerable: true,
    });
  }

  unregisterConnection(connectionId: string): ConnectionRecord | undefined {
    const connection = this.connections.get(connectionId);
    if (connection) {
      this.connections.delete(connectionId);
      if (connection.roomId) {
        const set = this.roomIndex.get(connection.roomId);
        if (set) {
          set.delete(connection);
          if (set.size === 0) this.roomIndex.delete(connection.roomId);
        }
      }
      if (connection.playerId && this.playerIndex.get(connection.playerId) === connection) {
        this.playerIndex.delete(connection.playerId);
      }
      this.lobbySubscribers.delete(connection);
    }
    return connection;
  }

  getConnection(connectionId: string): ConnectionRecord {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new AppError("CONNECTION_NOT_FOUND", "连接不存在或已断开");
    }
    return connection;
  }

  findConnection(connectionId: string): ConnectionRecord | undefined {
    return this.connections.get(connectionId);
  }

  findConnectionByPlayer(roomId: string, playerId: string): ConnectionRecord | undefined {
    const connection = this.playerIndex.get(playerId);
    return connection?.roomId === roomId ? connection : undefined;
  }

  getLobbySubscribers(): ConnectionRecord[] {
    return Array.from(this.lobbySubscribers);
  }

  getRoomConnections(roomId: string): ConnectionRecord[] {
    const set = this.roomIndex.get(roomId);
    return set ? Array.from(set) : [];
  }

  private failedBroadcasts = 0;

  broadcastToLobby(payload: unknown): void {
    for (const conn of this.lobbySubscribers) {
      try {
        conn.send(payload);
      } catch {
        this.failedBroadcasts += 1;
      }
    }
  }

  broadcastToRoom(roomId: string, payload: unknown): void {
    const roomSet = this.roomIndex.get(roomId);
    if (!roomSet) return;
    for (const conn of roomSet) {
      try {
        conn.send(payload);
      } catch {
        this.failedBroadcasts += 1;
      }
    }
  }

  broadcastToAll(payload: unknown): void {
    for (const conn of this.connections.values()) {
      try {
        conn.send(payload);
      } catch {
        this.failedBroadcasts += 1;
      }
    }
  }

  findConnectionByPlayerId(playerId: string): ConnectionRecord | undefined {
    return this.playerIndex.get(playerId);
  }

  get stats() {
    return {
      totalConnections: this.connections.size,
      lobbySubscribers: this.lobbySubscribers.size,
    };
  }

  get failedBroadcastCount(): number {
    return this.failedBroadcasts;
  }
}
