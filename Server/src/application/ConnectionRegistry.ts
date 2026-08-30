import type { ConnectionRecord } from "../domain/Model";
import { AppError } from "../domain/Errors";

export class ConnectionRegistry {
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly roomIndex = new Map<string, Set<ConnectionRecord>>();
  private readonly playerIndex = new Map<string, ConnectionRecord>();
  private readonly lobbySubscribers = new Set<ConnectionRecord>();

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

  broadcastToLobby(payload: unknown): void {
    for (const conn of this.lobbySubscribers) {
      try {
        conn.send(payload);
      } catch {
        // 忽略离线连接推送失败
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
        // 忽略离线连接推送失败
      }
    }
  }

  broadcastToAll(payload: unknown): void {
    for (const conn of this.connections.values()) {
      try {
        conn.send(payload);
      } catch {
        // 忽略已断开连接
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
}
