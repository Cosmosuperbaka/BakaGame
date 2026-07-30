import type { ConnectionRecord } from "../domain/model";
import { AppError } from "../domain/errors";

export class ConnectionRegistry {
  private readonly connections = new Map<string, ConnectionRecord>();

  registerConnection(connection: ConnectionRecord): void {
    this.connections.set(connection.id, connection);
  }

  unregisterConnection(connectionId: string): ConnectionRecord | undefined {
    const connection = this.connections.get(connectionId);
    if (connection) {
      this.connections.delete(connectionId);
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
    for (const connection of this.connections.values()) {
      if (connection.roomId === roomId && connection.playerId === playerId) {
        return connection;
      }
    }
    return undefined;
  }

  getLobbySubscribers(): ConnectionRecord[] {
    return Array.from(this.connections.values()).filter(
      (conn) => conn.lobbySubscribed && !conn.roomId,
    );
  }

  getRoomConnections(roomId: string): ConnectionRecord[] {
    return Array.from(this.connections.values()).filter(
      (conn) => conn.roomId === roomId,
    );
  }

  broadcastToLobby(payload: unknown): void {
    for (const conn of this.getLobbySubscribers()) {
      try {
        conn.send(payload);
      } catch {
        // 忽略离线连接推送失败
      }
    }
  }

  broadcastToRoom(roomId: string, payload: unknown): void {
    for (const conn of this.getRoomConnections(roomId)) {
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
    for (const connection of this.connections.values()) {
      if (connection.playerId === playerId) {
        return connection;
      }
    }
    return undefined;
  }

  get stats() {
    return {
      totalConnections: this.connections.size,
      lobbySubscribers: this.getLobbySubscribers().length,
    };
  }
}
